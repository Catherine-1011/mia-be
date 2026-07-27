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
  return [...new Set(order.items.map((item) => item.product?.sellerId).filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isValidEmailAddress(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
  return order.items.map((item) => ({
    title: productTitle(item),
    quantity: item.quantity,
    price: itemPrice(item),
  }));
}

function buildOrderDetails(order) {
  const toName = order.customerName || (order.user?.isDeleted ? "Deleted User" : order.user?.name) || "Customer";
  const products = order.items.map((item) => ({
    title: productTitle(item),
    quantity: item.quantity,
    price: itemPrice(item),
  }));

  return {
    displayId: order.displayId,
    customerEmail: order.customerEmail || order.user?.email || null,
    totalAmount: Number(order.totalAmount || 0),
    itemCount: order.items.length,
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
  const orderDetails = buildOrderDetails(order);
  const customerName = orderDetails.customerName;

  if (job.type === "CUSTOMER_CONFIRMATION") {
    if (!orderDetails.customerEmail) return;
    const invoicePDFBuffer = await generateInvoiceBuffer(order);
    const result = await sendOrderConfirmationEmail(orderDetails.customerEmail, customerName, orderDetails, invoicePDFBuffer);
    assertEmailSuccess(result, "customer confirmation");
    return;
  }

  if (job.type === "FINANCE_INVOICE") {
    const invoicePDFBuffer = await generateInvoiceBuffer(order);
    const result = await sendFinanceOrderInvoiceEmail(order, invoicePDFBuffer);
    assertEmailSuccess(result, "finance invoice");
    return;
  }

  if (job.type === "ADMIN_NEW_ORDER_NOTIFICATION") {
    const payload = job.payload || {};
    const sellerNames = sellerIdsFor(order, payload)
      .map((sellerId) => {
        const item = order.items.find((candidate) => candidate.product?.sellerId === sellerId);
        return item?.product?.seller?.sellerProfile?.storeName
          || item?.product?.seller?.sellerProfile?.businessName
          || item?.product?.seller?.name
          || "Unknown";
      });
    const adminNotificationDetails = {
      customerName,
      sellerName: sellerNames.join(", ") || "Unknown",
      totalAmount: Number(order.totalAmount || 0).toFixed(2),
      itemCount: order.items.length,
      productNames: order.items.map(productTitle),
    };

    if (payload.adminNewOrderNotificationCreated !== true) {
      await notifyAdminNewOrder(order.id, adminNotificationDetails);
      await updateJobPayload(job, { adminNewOrderNotificationCreated: true });
    }

    const admins = await prisma.user.findMany({
      where: {
        role: { in: ["ADMIN", "SUPER_ADMIN"] },
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
      const sellerItems = order.items.filter((item) => item.product?.sellerId === sellerId);
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
      const sellerItems = order.items.filter((item) => item.product?.sellerId === sellerId);
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
      const result = await sendSellerPaymentReceivedEmail(seller.email, seller.name || "Seller", {
        orderId: order.id,
        orderDisplayId: order.displayId || order.id,
        amount,
        currency: "AUD",
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
    const jobs = await prisma.paymentCompletionOutbox.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        attemptCount: { lt: OUTBOX_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
      take: OUTBOX_BATCH_SIZE,
    });

    for (const job of jobs) {
      const claimed = await claimJob(job);
      if (!claimed) continue;
      try {
        await processJob(job);
        await markProcessed(job.id);
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
  } finally {
    running = false;
  }
  return { processed, skipped: false };
}

function startPaymentCompletionOutboxProcessor() {
  if (process.env.PAYMENT_OUTBOX_WORKER_ENABLED === "false") {
    console.log("[PaymentCompletionOutbox] worker disabled");
    return null;
  }
  if (intervalHandle) return intervalHandle;

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
