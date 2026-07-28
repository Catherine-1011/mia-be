const prisma = require("../config/prisma");
const {
  sendOrderConfirmationEmail,
  sendFinanceOrderInvoiceEmail,
  sendSellerPaymentReceivedEmail,
  sendAdminNewOrderEmail,
} = require("./emailService");
const { notifyAdminNewOrder, notifySellerNewOrder } = require("../controllers/notification");
const { generateInvoiceBuffer } = require("../controllers/orders");

const OUTBOX_BATCH_SIZE = Number(process.env.PAYMENT_OUTBOX_BATCH_SIZE || 10);
const OUTBOX_INTERVAL_MS = Number(process.env.PAYMENT_OUTBOX_INTERVAL_MS || 30 * 1000);
const OUTBOX_MAX_ATTEMPTS = Number(process.env.PAYMENT_OUTBOX_MAX_ATTEMPTS || 10);
const OUTBOX_PROCESSING_TIMEOUT_MS =
  Number(process.env.PAYMENT_OUTBOX_PROCESSING_TIMEOUT_MS || 10 * 60 * 1000);

let intervalHandle = null;
let running = false;

function orderInclude() {
  return {
    items: {
      include: {
        product: {
          select: {
            id: true,
            title: true,
            price: true,
            sellerId: true,
            seller: {
              select: {
                email: true,
                name: true,
                sellerProfile: { select: { storeName: true, businessName: true, abn: true, businessAddress: true } },
              },
            },
          },
        },
        productVariant: {
          include: {
            variantAttributeValues: {
              include: { attributeValue: { include: { attribute: true } } },
            },
          },
        },
      },
    },
    subOrders: {
      include: {
        seller: { select: { id: true, name: true, email: true } },
        sellerProfile: { select: { abn: true, businessAddress: true } },
        items: {
          include: {
            product: { select: { id: true, title: true, price: true, sellerId: true } },
            productVariant: true,
          },
        },
      },
    },
    user: { select: { name: true, email: true, phone: true, isDeleted: true } },
  };
}

function assertEmailSuccess(result, context) {
  if (!result || result.success !== true) {
    const error = new Error(
      result?.error || `Email provider returned an unsuccessful result (${context})`
    );
    error.code = result?.code;
    error.status = result?.status;
    throw error;
  }
}

function assertValidInvoiceBuffer(buffer, context) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`Invoice PDF generation returned an invalid buffer (${context})`);
  }
}

function productTitle(item) {
  return item.product?.title || "Product";
}

function itemPrice(item) {
  return Number(item.productVariant?.price ?? item.price ?? item.product?.price ?? 0);
}

function sellerIdsFor(order, payload) {
  if (payload?.sellerId) return [payload.sellerId];
  const fromPayload = Array.isArray(payload?.sellerIds) ? payload.sellerIds : [];
  if (fromPayload.length) return [...new Set(fromPayload.filter(Boolean))];
  return [...new Set(completeOrderItems(order).map((item) => item.product?.sellerId).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isValidEmailAddress(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function completeOrderItems(order) {
  const items = [
    ...(order.items || []),
    ...(order.subOrders || []).flatMap((subOrder) => subOrder.items || []),
  ];
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.id;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function updateJobPayload(job, payloadPatch) {
  const payload = { ...(job.payload || {}), ...payloadPatch };
  job.payload = payload;
  await prisma.paymentCompletionOutbox.update({
    where: { id: job.id },
    data: { payload },
  });
}

function orderItemsForEmail(order) {
  return completeOrderItems(order).map((item) => ({
    title: productTitle(item),
    quantity: item.quantity,
    price: itemPrice(item),
  }));
}

function buildOrderDetails(order) {
  const toName = order.customerName || (order.user?.isDeleted ? "Deleted User" : order.user?.name) || "Customer";
  const items = completeOrderItems(order);
  const products = items.map((item) => ({
    title: productTitle(item),
    quantity: item.quantity,
    price: itemPrice(item),
  }));

  return {
    displayId: order.displayId,
    customerEmail: order.customerEmail || order.user?.email || null,
    totalAmount: Number(order.totalAmount || 0),
    itemCount: items.length,
    products,
    paymentMethod: order.paymentMethod || "STRIPE",
    customerPhone: order.customerPhone || order.user?.phone || "",
    customerName: toName,
    shippingAddress: {
      addressLine: order.shippingAddressLine,
      city: order.shippingCity,
      state: order.shippingState,
      zipCode: order.shippingZipCode,
      country: order.shippingCountry,
    },
    orderSummary: order.shippingAddress?.orderSummary,
    isGuest: !order.userId,
  };
}

function sellerEmailDetails(order, orderDetails, sellerId, sellerItems) {
  const sellerSubOrder = order.subOrders?.find((sub) => sub.sellerId === sellerId || sub.seller?.id === sellerId);
  const sellerShipping = parseFloat(order.shippingAddress?.orderSummary?.shippingCost || 0);
  const itemTotal = sellerItems.reduce((sum, item) => sum + itemPrice(item) * item.quantity, 0);
  const gstPct = parseFloat(order.shippingAddress?.orderSummary?.gstPercentage || 10);
  const sellerGstAmount = itemTotal * (gstPct / (100 + gstPct));
  const sellerSubtotalExGST = itemTotal - sellerGstAmount;

  return {
    ...orderDetails,
    isSellerCopy: true,
    subOrderId: sellerSubOrder?.id,
    products: sellerItems.map((item) => ({
      title: productTitle(item),
      quantity: item.quantity,
      price: itemPrice(item),
    })),
    totalAmount: itemTotal + sellerShipping,
    orderSummary: {
      ...(order.shippingAddress?.orderSummary || {}),
      subtotal: itemTotal,
      subtotalExGST: sellerSubtotalExGST,
      gstAmount: sellerGstAmount,
      shippingCost: sellerShipping,
    },
  };
}

function sellerInvoiceShape(order, sellerId, sellerItems, sellerDetails) {
  const sellerSubOrder = order.subOrders?.find((sub) => sub.sellerId === sellerId || sub.seller?.id === sellerId);
  const isolatedSubOrder = sellerSubOrder
    ? { ...sellerSubOrder, items: sellerItems }
    : null;
  return {
    ...order,
    id: sellerSubOrder?.id || order.id,
    displayId: sellerSubOrder?.subDisplayId || sellerSubOrder?.id || order.displayId || order.id,
    subDisplayId: sellerSubOrder?.subDisplayId,
    totalAmount: sellerDetails.totalAmount,
    items: sellerItems.map((item) => ({
      ...item,
      price: itemPrice(item),
    })),
    subOrders: isolatedSubOrder ? [isolatedSubOrder] : [],
  };
}

function isConfirmationEmailJob(type) {
  return [
    "CUSTOMER_CONFIRMATION",
    "FINANCE_INVOICE",
    "ADMIN_NEW_ORDER_NOTIFICATION",
    "SELLER_PAYMENT_NOTIFICATION",
  ].includes(type);
}

function isOrderSafeForConfirmationEmail(order) {
  const blockedOrderStatuses = new Set(["CANCELLED", "REFUND", "PARTIAL_REFUND"]);
  const blockedPaymentStatuses = new Set(["FAILED", "DISPUTED", "REFUND_PENDING", "REFUNDED"]);
  return !blockedOrderStatuses.has(order.status) && !blockedPaymentStatuses.has(order.paymentStatus);
}

async function loadOrder(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: orderInclude(),
  });
  if (!order) throw new Error(`Payment completion outbox order not found: ${orderId}`);
  return order;
}

async function claimJob(job) {
  const result = await prisma.paymentCompletionOutbox.updateMany({
    where: {
      id: job.id,
      status: job.status,
      attemptCount: { lt: OUTBOX_MAX_ATTEMPTS },
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      lastError: null,
    },
  });
  return result.count === 1;
}

async function markProcessed(jobId) {
  await prisma.paymentCompletionOutbox.update({
    where: { id: jobId },
    data: { status: "PROCESSED", lastError: null },
  });
}

async function markFailed(jobId, error) {
  await prisma.paymentCompletionOutbox.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      lastError: String(error?.stack || error?.message || error).slice(0, 4000),
    },
  });
}

async function processJob(job) {
  const order = await loadOrder(job.orderId);
  if (isConfirmationEmailJob(job.type) && !isOrderSafeForConfirmationEmail(order)) {
    console.warn("[PaymentCompletionOutbox] confirmation email skipped: order/payment state no longer eligible", {
      jobId: job.id,
      orderId: order.id,
      type: job.type,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
    });
    return;
  }
  const orderDetails = buildOrderDetails(order);
  const customerName = orderDetails.customerName;

  if (job.type === "CUSTOMER_CONFIRMATION") {
    if (!orderDetails.customerEmail) return;
    const invoicePDFBuffer = await generateInvoiceBuffer(order);
    assertValidInvoiceBuffer(invoicePDFBuffer, "customer confirmation");
    const result = await sendOrderConfirmationEmail(orderDetails.customerEmail, customerName, orderDetails, invoicePDFBuffer);
    assertEmailSuccess(result, "customer confirmation");
    return;
  }

  if (job.type === "FINANCE_INVOICE") {
    const invoicePDFBuffer = await generateInvoiceBuffer(order);
    assertValidInvoiceBuffer(invoicePDFBuffer, "finance invoice");
    const result = await sendFinanceOrderInvoiceEmail(order, invoicePDFBuffer);
    assertEmailSuccess(result, "finance invoice");
    return;
  }

  if (job.type === "ADMIN_NEW_ORDER_NOTIFICATION") {
    const payload = job.payload || {};
    const sellerNames = sellerIdsFor(order, payload)
      .map((sellerId) => {
        const item = completeOrderItems(order).find((candidate) => candidate.product?.sellerId === sellerId);
        return item?.product?.seller?.sellerProfile?.storeName
          || item?.product?.seller?.sellerProfile?.businessName
          || item?.product?.seller?.name
          || "Unknown";
      });
    const adminNotificationDetails = {
      customerName,
      sellerName: sellerNames.join(", ") || "Unknown",
      totalAmount: Number(order.totalAmount || 0).toFixed(2),
      itemCount: completeOrderItems(order).length,
      productNames: completeOrderItems(order).map(productTitle),
    };

    if (payload.adminNewOrderNotificationCreated !== true) {
      await notifyAdminNewOrder(order.id, adminNotificationDetails);
      await updateJobPayload(job, { adminNewOrderNotificationCreated: true });
    }

    const admins = await prisma.user.findMany({
      where: {
        role: "SUPER_ADMIN",
        isDeleted: false,
      },
      select: { id: true, email: true, name: true },
    });

    const deliveredAdminIds = new Set(asArray(job.payload?.adminNewOrderEmailDeliveredAdminIds));
    const failures = [];
    const adminEmailDetails = {
      displayId: order.displayId || order.id,
      customerName,
      customerEmail: orderDetails.customerEmail,
      customerPhone: orderDetails.customerPhone,
      sellerNames: sellerNames.join(", ") || "Unknown",
      totalAmount: Number(order.totalAmount || 0),
      paymentMethod: order.paymentMethod || "STRIPE",
      items: orderItemsForEmail(order),
    };
    const invoicePDFBuffer = await generateInvoiceBuffer(order);
    assertValidInvoiceBuffer(invoicePDFBuffer, "admin new order");
    adminEmailDetails.invoicePDFBuffer = invoicePDFBuffer;

    for (const admin of admins) {
      if (!admin?.id) continue;
      if (deliveredAdminIds.has(admin.id)) continue;
      if (!isValidEmailAddress(admin.email)) {
        console.warn("[PaymentCompletionOutbox] admin new order email skipped: missing or invalid recipient", {
          jobId: job.id,
          orderId: order.id,
          adminId: admin.id,
        });
        continue;
      }

      const result = await sendAdminNewOrderEmail(admin.email, admin.name || "Admin", adminEmailDetails);
      if (!result || result.success !== true) {
        failures.push(`${admin.id}: ${result?.error || "unknown error"}`);
        continue;
      }

      deliveredAdminIds.add(admin.id);
      await updateJobPayload(job, {
        adminNewOrderEmailDeliveredAdminIds: [...deliveredAdminIds],
      });
    }

    if (failures.length) {
      throw new Error(`Admin new order email failures: ${failures.join("; ")}`);
    }
    return;
  }

  if (job.type === "SELLER_NEW_ORDER_NOTIFICATION") {
    for (const sellerId of sellerIdsFor(order, job.payload)) {
      const sellerItems = completeOrderItems(order).filter((item) => item.product?.sellerId === sellerId);
      const itemTotal = sellerItems.reduce((sum, item) => sum + itemPrice(item) * item.quantity, 0);
      await notifySellerNewOrder(sellerId, order.id, {
        customerName,
        totalAmount: itemTotal.toFixed(2),
        itemCount: sellerItems.reduce((sum, item) => sum + item.quantity, 0),
        productNames: sellerItems.map(productTitle),
      });
    }
    return;
  }

  if (job.type === "SELLER_PAYMENT_NOTIFICATION") {
    const deliveredSellerIds = new Set(asArray(job.payload?.sellerPaymentEmailDeliveredSellerIds));
    const failures = [];
    for (const sellerId of sellerIdsFor(order, job.payload)) {
      if (deliveredSellerIds.has(sellerId)) continue;
      const sellerItems = completeOrderItems(order).filter((item) => item.product?.sellerId === sellerId);
      const seller = sellerItems[0]?.product?.seller;
      if (!sellerItems.length) {
        console.warn("[PaymentCompletionOutbox] seller payment email skipped: seller has no order items", {
          jobId: job.id,
          orderId: order.id,
          sellerId,
        });
        continue;
      }
      if (!isValidEmailAddress(seller?.email)) {
        console.warn("[PaymentCompletionOutbox] seller payment email skipped: missing or invalid recipient", {
          jobId: job.id,
          orderId: order.id,
          sellerId,
        });
        continue;
      }
      const amount = sellerItems.reduce((sum, item) => sum + itemPrice(item) * item.quantity, 0);
      const sellerDetails = sellerEmailDetails(order, orderDetails, sellerId, sellerItems);
      const invoicePDFBuffer = await generateInvoiceBuffer(sellerInvoiceShape(order, sellerId, sellerItems, sellerDetails));
      assertValidInvoiceBuffer(invoicePDFBuffer, `seller payment notification ${sellerId}`);
      const result = await sendSellerPaymentReceivedEmail(seller.email, seller.name || "Seller", {
        orderId: order.id,
        orderDisplayId: order.displayId || order.id,
        amount,
        currency: "AUD",
        invoicePDFBuffer,
      });
      if (!result || result.success !== true) {
        failures.push(`${seller.email}: ${result?.error || "unknown error"}`);
        continue;
      }

      deliveredSellerIds.add(sellerId);
      await updateJobPayload(job, {
        sellerPaymentEmailDeliveredSellerIds: [...deliveredSellerIds],
      });
    }
    if (failures.length) {
      throw new Error(`Seller payment notification email failures: ${failures.join("; ")}`);
    }
    return;
  }

  throw new Error(`Unsupported payment completion outbox type: ${job.type}`);
}

async function processPaymentCompletionOutboxOnce() {
  if (running) return { processed: 0, skipped: true };
  running = true;
  let processed = 0;
  try {
    const staleBefore = new Date(Date.now() - OUTBOX_PROCESSING_TIMEOUT_MS);
    const jobs = await prisma.paymentCompletionOutbox.findMany({
      where: {
        attemptCount: { lt: OUTBOX_MAX_ATTEMPTS },
        OR: [
          { status: { in: ["PENDING", "FAILED"] } },
          { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: OUTBOX_BATCH_SIZE,
    });
    if (jobs.length) {
      console.log("[PaymentCompletionOutbox] jobs found", { count: jobs.length });
    }

    for (const job of jobs) {
      const claimed = await claimJob(job);
      if (!claimed) continue;
      console.log("[PaymentCompletionOutbox] job claimed", {
        jobId: job.id,
        orderId: job.orderId,
        type: job.type,
      });
      try {
        await processJob(job);
        await markProcessed(job.id);
        console.log("[PaymentCompletionOutbox] job processed", {
          jobId: job.id,
          orderId: job.orderId,
          type: job.type,
        });
        processed += 1;
      } catch (error) {
        console.error("[PaymentCompletionOutbox] job failed", {
          jobId: job.id,
          orderId: job.orderId,
          type: job.type,
          error: error?.message || String(error),
        });
        await markFailed(job.id, error);
      }
    }

    const exhaustedJobs = await prisma.paymentCompletionOutbox.findMany({
      where: {
        status: { in: ["FAILED", "PROCESSING"] },
        attemptCount: { gte: OUTBOX_MAX_ATTEMPTS },
      },
      orderBy: { updatedAt: "asc" },
      take: OUTBOX_BATCH_SIZE,
    });
    for (const job of exhaustedJobs) {
      console.error("[PaymentCompletionOutbox] job exhausted max attempts", {
        jobId: job.id,
        orderId: job.orderId,
        type: job.type,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: OUTBOX_MAX_ATTEMPTS,
        lastError: job.lastError,
      });
    }
  } finally {
    running = false;
  }
  return { processed, skipped: false };
}

function startPaymentCompletionOutboxProcessor() {
  if (process.env.PAYMENT_OUTBOX_WORKER_ENABLED === "false") {
    console.log("[PaymentCompletionOutbox] worker disabled", { enabled: false });
    return null;
  }
  if (intervalHandle) return intervalHandle;
  console.log("[PaymentCompletionOutbox] worker started", {
    intervalMs: OUTBOX_INTERVAL_MS,
    batchSize: OUTBOX_BATCH_SIZE,
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
  });

  setTimeout(() => {
    processPaymentCompletionOutboxOnce().catch((error) => {
      console.error("[PaymentCompletionOutbox] initial run failed:", error.message);
    });
  }, 5000);

  intervalHandle = setInterval(() => {
    processPaymentCompletionOutboxOnce().catch((error) => {
      console.error("[PaymentCompletionOutbox] scheduled run failed:", error.message);
    });
  }, OUTBOX_INTERVAL_MS);
  return intervalHandle;
}

function stopPaymentCompletionOutboxProcessor() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = {
  processPaymentCompletionOutboxOnce,
  startPaymentCompletionOutboxProcessor,
  stopPaymentCompletionOutboxProcessor,
};
