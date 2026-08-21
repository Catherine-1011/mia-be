const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const emailPath = path.resolve(__dirname, "../utils/emailService.js");
const notificationPath = path.resolve(__dirname, "../controllers/notification.js");
const ordersPath = path.resolve(__dirname, "../controllers/orders.js");
const processorPath = path.resolve(__dirname, "../utils/paymentCompletionOutboxProcessor.js");
const emailServiceSourcePath = path.resolve(__dirname, "../utils/emailService.js");

function resetModules() {
  for (const modulePath of [prismaPath, emailPath, notificationPath, ordersPath, processorPath]) {
    delete require.cache[modulePath];
  }
}

const SELLER_A = {
  id: "seller_a",
  email: "seller-a@example.com",
  name: "Seller A",
  sellerProfile: { storeName: "Store A" },
};
const SELLER_B = {
  id: "seller_b",
  email: "seller-b@example.com",
  name: "Seller B",
  sellerProfile: { storeName: "Store B" },
};
const SELLER_C = {
  id: "seller_c",
  email: "seller-c@example.com",
  name: "Seller C",
  sellerProfile: { storeName: "Store C" },
};
const ADMIN_A = {
  id: "admin_a",
  email: "admin-a@example.com",
  name: "Admin A",
};
const ADMIN_B = {
  id: "admin_b",
  email: "admin-b@example.com",
  name: "Admin B",
};
const SUPER_ADMIN = {
  id: "super_admin",
  email: "super-admin@example.com",
  name: "Super Admin",
};

function makeSingleSellerOrder(overrides = {}) {
  return {
    id: "order_1",
    displayId: "ABC123",
    customerEmail: "customer@example.com",
    customerName: "Customer",
    totalAmount: 120,
    paymentMethod: "STRIPE",
    userId: "user_1",
    shippingAddress: { orderSummary: { shippingCost: 20 } },
    items: [
      {
        quantity: 1,
        price: 100,
        product: { title: "Artwork", sellerId: SELLER_A.id, seller: SELLER_A },
      },
    ],
    subOrders: [],
    user: { name: "Customer", email: "customer@example.com", phone: "", isDeleted: false },
    ...overrides,
  };
}

function makeMultiSellerOrder(overrides = {}) {
  return {
    id: "order_multi",
    displayId: "MULTI1",
    customerEmail: "multi-customer@example.com",
    customerName: "Multi Customer",
    totalAmount: 300,
    paymentMethod: "STRIPE",
    userId: "user_2",
    shippingAddress: { orderSummary: { shippingCost: 30 } },
    items: [
      { quantity: 1, price: 100, product: { title: "Item A", sellerId: SELLER_A.id, seller: SELLER_A } },
      { quantity: 2, price: 80, product: { title: "Item B", sellerId: SELLER_B.id, seller: SELLER_B } },
      { quantity: 1, price: 40, product: { title: "Item C", sellerId: SELLER_C.id, seller: SELLER_C } },
    ],
    subOrders: [],
    user: { name: "Multi Customer", email: "multi-customer@example.com", phone: "", isDeleted: false },
    ...overrides,
  };
}

function makeGuestOrder(overrides = {}) {
  return {
    id: "order_guest",
    displayId: "GUEST1",
    customerEmail: "guest@example.com",
    customerName: "Guest Shopper",
    totalAmount: 50,
    paymentMethod: "STRIPE",
    userId: null,
    shippingAddress: { orderSummary: { shippingCost: 10 } },
    items: [
      { quantity: 1, price: 40, product: { title: "Craft", sellerId: SELLER_A.id, seller: SELLER_A } },
    ],
    subOrders: [],
    user: null,
    ...overrides,
  };
}

function loadProcessor({ ordersById, jobs, emailResults = {}, notificationImpls = {}, admins = [SUPER_ADMIN], invoiceImpl } = {}) {
  resetModules();
  const jobMap = new Map(jobs.map((job) => [job.id, {
    attemptCount: 0,
    status: "PENDING",
    payload: {},
    lastError: null,
    createdAt: new Date(),
    ...job,
  }]));
  const calls = {
    customerEmail: [],
    financeEmail: [],
    sellerEmail: [],
    adminEmail: [],
    invoice: 0,
    notifyAdmin: [],
    notifySeller: [],
  };

  function nextResult(fnName) {
    const queue = emailResults[fnName];
    let value;
    if (!queue) value = { success: true };
    else if (Array.isArray(queue)) value = queue.length > 1 ? queue.shift() : queue[0];
    else value = queue;
    if (value instanceof Error) throw value;
    return value;
  }

  const prisma = {
    paymentCompletionOutbox: {
      findMany: async ({ where } = {}) => {
        const staleCutoff = where?.OR?.find((clause) => clause.status === "PROCESSING")?.updatedAt?.lt;
        const maxAttemptsLt = where?.attemptCount?.lt ?? Number.POSITIVE_INFINITY;
        const maxAttemptsGte = where?.attemptCount?.gte ?? Number.NEGATIVE_INFINITY;
        const statusIn = where?.status?.in || null;
        return [...jobMap.values()].filter((job) => {
          if (statusIn && !statusIn.includes(job.status)) return false;
          if (where?.attemptCount?.lt !== undefined && job.attemptCount >= maxAttemptsLt) return false;
          if (where?.attemptCount?.gte !== undefined && job.attemptCount < maxAttemptsGte) return false;
          if (!where?.OR) return true;
          return where.OR.some((clause) => {
            if (clause.status?.in?.includes(job.status)) return true;
            if (clause.status === "PROCESSING" && job.status === "PROCESSING") {
              return new Date(job.updatedAt || 0) < staleCutoff;
            }
            return false;
          });
        });
      },
      updateMany: async ({ where, data }) => {
        const job = jobMap.get(where.id);
        if (!job || job.status !== where.status || job.attemptCount >= where.attemptCount.lt) return { count: 0 };
        job.status = data.status;
        job.attemptCount += data.attemptCount.increment;
        job.lastError = data.lastError;
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        Object.assign(jobMap.get(where.id), data);
        return jobMap.get(where.id);
      },
    },
    order: {
      findUnique: async ({ where: { id } }) => ordersById[id] || null,
    },
    user: {
      findMany: async ({ where } = {}) => {
        if (where?.role === "SUPER_ADMIN") {
          return admins.filter((admin) => admin.role === "SUPER_ADMIN" || admin.id === SUPER_ADMIN.id);
        }
        return admins;
      },
    },
  };

  require.cache[prismaPath] = { exports: prisma };
  require.cache[emailPath] = {
    exports: {
      sendOrderConfirmationEmail: async (email, name, details, invoicePDFBuffer) => {
        calls.customerEmail.push({ email, name, details, isSuperAdminCopy: !!details.isSuperAdminCopy, invoicePDFBuffer });
        return nextResult("sendOrderConfirmationEmail");
      },
      sendFinanceOrderInvoiceEmail: async (order, invoicePDFBuffer) => {
        calls.financeEmail.push({ orderId: order.id, invoicePDFBuffer });
        return nextResult("sendFinanceOrderInvoiceEmail");
      },
      sendSellerPaymentReceivedEmail: async (email, name, details) => {
        const invoiceAttachment = details.invoicePDFBuffer ? {
          content: details.invoicePDFBuffer.toString("base64"),
          filename: details.invoiceFilename,
          type: "application/pdf",
          disposition: "attachment",
        } : null;
        calls.sellerEmail.push({
          email,
          name,
          amount: details.amount,
          orderDisplayId: details.orderDisplayId,
          invoicePDFBuffer: details.invoicePDFBuffer,
          invoiceFilename: details.invoiceFilename,
          invoiceAttachment,
        });
        return nextResult("sendSellerPaymentReceivedEmail");
      },
      sendAdminNewOrderEmail: async (email, name, details) => {
        calls.adminEmail.push({ email, name, details });
        return nextResult("sendAdminNewOrderEmail");
      },
    },
  };
  require.cache[notificationPath] = {
    exports: {
      notifyAdminNewOrder: async (orderId, details) => {
        calls.notifyAdmin.push({ orderId, details });
        return notificationImpls.notifyAdminNewOrder ? notificationImpls.notifyAdminNewOrder() : [{ id: "n1" }];
      },
      notifySellerNewOrder: async (sellerId, orderId, details) => {
        calls.notifySeller.push({ sellerId, orderId, details });
        return notificationImpls.notifySellerNewOrder ? notificationImpls.notifySellerNewOrder() : { id: "n2" };
      },
    },
  };
  require.cache[ordersPath] = {
    exports: {
      generateInvoiceBuffer: async (order) => {
        calls.invoice += 1;
        return invoiceImpl ? invoiceImpl(order) : Buffer.from("pdf");
      },
    },
  };

  const processor = require(processorPath);
  return { processor, jobs: jobMap, calls };
}

function outboxRowsFor(order, sellerIds) {
  return [
    { id: `${order.id}-customer`, orderId: order.id, type: "CUSTOMER_CONFIRMATION" },
    { id: `${order.id}-admin`, orderId: order.id, type: "ADMIN_NEW_ORDER_NOTIFICATION", payload: { sellerIds } },
    { id: `${order.id}-finance`, orderId: order.id, type: "FINANCE_INVOICE" },
    { id: `${order.id}-seller-new`, orderId: order.id, type: "SELLER_NEW_ORDER_NOTIFICATION", payload: { sellerIds } },
    { id: `${order.id}-seller-payment`, orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds } },
  ];
}

test("a {success:false} email result must NOT mark the job PROCESSED", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
    emailResults: { sendOrderConfirmationEmail: { success: false, error: "SendGrid 401 Unauthorized" } },
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 0);
  assert.notEqual(jobs.get("job_1").status, "PROCESSED");
});

test("a {success:false} email result becomes FAILED (retryable) with the provider error recorded", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
    emailResults: { sendOrderConfirmationEmail: { success: false, error: "SendGrid 401 Unauthorized" } },
  });

  await processor.processPaymentCompletionOutboxOnce();

  const job = jobs.get("job_1");
  assert.equal(job.status, "FAILED");
  assert.equal(job.attemptCount, 1);
  assert.match(job.lastError, /SendGrid 401 Unauthorized/);
});

test("a {success:true} email result marks the job PROCESSED", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
    emailResults: { sendOrderConfirmationEmail: { success: true } },
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("job_1").status, "PROCESSED");
  assert.equal(jobs.get("job_1").lastError, null);
  assert.equal(calls.customerEmail.length, 1);
});

test("a thrown error still fails the job as before", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
    emailResults: { sendOrderConfirmationEmail: new Error("email unavailable") },
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 0);
  assert.equal(jobs.get("job_1").status, "FAILED");
  assert.match(jobs.get("job_1").lastError, /email unavailable/);
});

test("a successful payment creates customer, super admin, and seller job outcomes", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: outboxRowsFor(order, [SELLER_A.id]),
    admins: [{ ...ADMIN_A, role: "ADMIN" }, { ...SUPER_ADMIN, role: "SUPER_ADMIN" }],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 5);
  for (const job of jobs.values()) assert.equal(job.status, "PROCESSED");
  assert.equal(calls.customerEmail.length, 1);
  assert.ok(Buffer.isBuffer(calls.customerEmail[0].invoicePDFBuffer));
  // Accounts Receivable gets exactly one order-level copy alongside the unchanged customer/admin/seller recipients.
  assert.equal(calls.financeEmail.length, 1);
  assert.equal(calls.financeEmail[0].orderId, order.id);
  assert.ok(Buffer.isBuffer(calls.financeEmail[0].invoicePDFBuffer));
  assert.equal(calls.notifyAdmin.length, 1);
  assert.equal(calls.adminEmail.length, 1);
  assert.ok(Buffer.isBuffer(calls.adminEmail[0].details.invoicePDFBuffer));
  assert.deepEqual(calls.adminEmail.map((c) => c.email), [SUPER_ADMIN.email]);
  assert.equal(calls.notifySeller.length, 1);
  assert.equal(calls.sellerEmail.length, 1);
  assert.equal(calls.sellerEmail[0].email, SELLER_A.email);
  assert.ok(Buffer.isBuffer(calls.sellerEmail[0].invoicePDFBuffer));
  assert.equal(calls.sellerEmail[0].invoiceFilename, "Invoice-ABC123-Store-A.pdf");
  assert.equal(calls.sellerEmail[0].invoiceAttachment.filename, "Invoice-ABC123-Store-A.pdf");
  assert.equal(calls.sellerEmail[0].invoiceAttachment.type, "application/pdf");
  assert.equal(calls.sellerEmail[0].invoiceAttachment.disposition, "attachment");
  assert.ok(Buffer.from(calls.sellerEmail[0].invoiceAttachment.content, "base64").length > 0);
});

test("multi-seller payment creates seller notifications and payment emails for every seller", async () => {
  const order = makeMultiSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [
      { id: "seller-new", orderId: order.id, type: "SELLER_NEW_ORDER_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id, SELLER_C.id] } },
      { id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id, SELLER_C.id] } },
    ],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 2);
  assert.equal(jobs.get("seller-new").status, "PROCESSED");
  assert.equal(jobs.get("seller-payment").status, "PROCESSED");
  assert.deepEqual(calls.notifySeller.map((c) => c.sellerId).sort(), [SELLER_A.id, SELLER_B.id, SELLER_C.id].sort());
  assert.deepEqual(calls.sellerEmail.map((c) => c.email).sort(), [SELLER_A.email, SELLER_B.email, SELLER_C.email].sort());
});

test("single-seller payment sends exactly one seller payment email for the full order amount", async () => {
  const order = makeSingleSellerOrder();
  const { processor, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } }],
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(calls.sellerEmail.length, 1);
  assert.equal(calls.sellerEmail[0].amount, 100);
  assert.ok(Buffer.isBuffer(calls.sellerEmail[0].invoicePDFBuffer));
  assert.equal(calls.sellerEmail[0].invoiceAttachment.filename, "Invoice-ABC123-Store-A.pdf");
  assert.equal(calls.sellerEmail[0].invoiceAttachment.type, "application/pdf");
  assert.ok(Buffer.from(calls.sellerEmail[0].invoiceAttachment.content, "base64").length > 0);
});

test("parent plus suborder items feed customer, super admin, and seller-scoped emails", async () => {
  const itemA = {
    id: "item_a",
    quantity: 1,
    price: 100,
    product: { title: "Sub Item A", sellerId: SELLER_A.id, seller: SELLER_A },
  };
  const itemB = {
    id: "item_b",
    quantity: 2,
    price: 80,
    product: { title: "Sub Item B", sellerId: SELLER_B.id, seller: SELLER_B },
  };
  const order = makeMultiSellerOrder({
    items: [],
    subOrders: [
      { id: "sub_a", sellerId: SELLER_A.id, items: [itemA], seller: SELLER_A },
      { id: "sub_b", sellerId: SELLER_B.id, items: [itemB], seller: SELLER_B },
    ],
  });
  const invoiceOrders = [];
  const { processor, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [
      { id: "customer", orderId: order.id, type: "CUSTOMER_CONFIRMATION" },
      { id: "admin", orderId: order.id, type: "ADMIN_NEW_ORDER_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id] } },
      { id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id, SELLER_C.id] } },
    ],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.deepEqual(calls.customerEmail[0].details.products.map((item) => item.title).sort(), ["Sub Item A", "Sub Item B"]);
  assert.deepEqual(calls.adminEmail[0].details.items.map((item) => item.title).sort(), ["Sub Item A", "Sub Item B"]);
  assert.deepEqual(calls.sellerEmail.map((call) => call.email).sort(), [SELLER_A.email, SELLER_B.email].sort());
  assert.deepEqual(calls.sellerEmail.map((call) => call.invoiceFilename).sort(), ["Invoice-MULTI1-sub_a.pdf", "Invoice-MULTI1-sub_b.pdf"]);
  const sellerInvoiceOrders = invoiceOrders.filter((invoiceOrder) => invoiceOrder.items?.length === 1);
  assert.equal(sellerInvoiceOrders.length, 2);
  assert.deepEqual(
    sellerInvoiceOrders.map((invoiceOrder) => invoiceOrder.items[0].product.sellerId).sort(),
    [SELLER_A.id, SELLER_B.id].sort()
  );
  for (const invoiceOrder of sellerInvoiceOrders) {
    assert.equal(invoiceOrder.subOrders.length, 1);
    const invoiceSellerIds = new Set(invoiceOrder.subOrders.flatMap((subOrder) => subOrder.items).map((item) => item.product.sellerId));
    assert.equal(invoiceSellerIds.size, 1);
    assert.equal(invoiceSellerIds.has(invoiceOrder.items[0].product.sellerId), true);
  }
});

test("multi-seller payment generates each seller invoice from only that seller's items", async () => {
  const order = makeMultiSellerOrder();
  const invoiceOrders = [];
  const { processor } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id, SELLER_C.id] } }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(invoiceOrders.length, 3);
  for (const invoiceOrder of invoiceOrders) {
    const sellerIds = new Set(invoiceOrder.items.map((item) => item.product?.sellerId));
    assert.equal(sellerIds.size, 1);
  }
});

test("Order ID email typography uses the Outlook-safe font stack instead of monospace", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(emailServiceSourcePath, "utf8");
  const orderIdCells = source.match(/<td style="[^"]*font-size:14px;[^"]*font-weight:700;[^"]*font-family:[^"]*">\$\{(?:orderDetails|refundDetails)\.displayId\}<\/td>|<td style="[^"]*font-size:14px;[^"]*font-weight:700;[^"]*font-family:[^"]*">\$\{orderId \|\| 'N\/A'\}<\/td>/g) || [];

  assert.ok(orderIdCells.length >= 6);
  for (const cell of orderIdCells) {
    assert.match(cell, /font-family:Arial, Helvetica, sans-serif/);
    assert.doesNotMatch(cell, /font-family:monospace/);
    assert.match(cell, /font-size:14px/);
    assert.match(cell, /font-weight:700/);
  }
});

test("sub-order seller invoices resolve seller ownership from authoritative SubOrder data", async () => {
  const itemA = {
    id: "sub_item_a",
    quantity: 1,
    price: 75,
    product: { title: "Sub Item A", sellerId: SELLER_A.id },
  };
  const itemB = {
    id: "sub_item_b",
    quantity: 2,
    price: 55,
    product: { title: "Sub Item B", sellerId: SELLER_B.id },
  };
  const order = makeMultiSellerOrder({
    items: [],
    subOrders: [
      { id: "sub_a", subDisplayId: "MULTI1-A", sellerId: SELLER_A.id, items: [itemA], seller: SELLER_A },
      { id: "sub_b", subDisplayId: "MULTI1-B", sellerId: SELLER_B.id, items: [itemB], seller: SELLER_B },
    ],
  });
  const invoiceOrders = [];
  const { processor, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id] } }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.deepEqual(calls.sellerEmail.map((call) => call.email).sort(), [SELLER_A.email, SELLER_B.email].sort());
  assert.deepEqual(calls.sellerEmail.map((call) => call.orderDisplayId).sort(), ["MULTI1-A", "MULTI1-B"]);
  assert.deepEqual(calls.sellerEmail.map((call) => call.invoiceFilename).sort(), ["Invoice-MULTI1-MULTI1-A.pdf", "Invoice-MULTI1-MULTI1-B.pdf"]);
  assert.deepEqual(invoiceOrders.map((invoiceOrder) => invoiceOrder.displayId).sort(), ["MULTI1-A", "MULTI1-B"]);
  for (const invoiceOrder of invoiceOrders) {
    const sellerIds = new Set(invoiceOrder.items.map((item) => item.product.sellerId));
    assert.equal(sellerIds.size, 1);
    assert.equal(invoiceOrder.subOrders.length, 1);
  }
});

test("mixed platform and external seller invoices stay separated without fee fields", async () => {
  const PLATFORM_SELLER = {
    id: "platform_seller",
    email: "platform@example.com",
    name: "ALPA Platform",
    sellerProfile: { storeName: "ALPA" },
  };
  const order = makeMultiSellerOrder({
    items: [
      { id: "platform_item", quantity: 1, price: 120, product: { title: "ALPA Owned Item", sellerId: PLATFORM_SELLER.id, seller: PLATFORM_SELLER } },
      { id: "external_item", quantity: 1, price: 80, product: { title: "External Seller Item", sellerId: SELLER_A.id, seller: SELLER_A } },
    ],
    subOrders: [],
  });
  const invoiceOrders = [];
  const { processor, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [PLATFORM_SELLER.id, SELLER_A.id] } }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.deepEqual(calls.sellerEmail.map((call) => call.email).sort(), [PLATFORM_SELLER.email, SELLER_A.email].sort());
  assert.deepEqual(calls.sellerEmail.map((call) => call.invoiceAttachment.type), ["application/pdf", "application/pdf"]);
  assert.deepEqual(calls.sellerEmail.map((call) => call.invoiceAttachment.filename).sort(), ["Invoice-MULTI1-ALPA.pdf", "Invoice-MULTI1-Store-A.pdf"]);
  assert.equal(invoiceOrders.length, 2);
  for (const invoiceOrder of invoiceOrders) {
    const titles = invoiceOrder.items.map((item) => item.product.title);
    assert.equal(titles.length, 1);
    assert.equal(invoiceOrder.applicationFeeAmount, undefined);
    assert.equal(invoiceOrder.commissionAmount, undefined);
  }
});

test("seller invoice clears parent order discount and coupon when there is no seller allocation", async () => {
  const order = makeMultiSellerOrder({
    discountAmount: 45,
    couponCode: "FULLCART",
    shippingAddress: {
      orderSummary: {
        shippingCost: 12,
        totalShippingCost: 36,
        gstPercentage: 10,
        discountAmount: 45,
        couponCode: "FULLCART",
        adjustmentAmount: 9,
        credits: [{ amount: 5 }],
      },
    },
  });
  const invoiceOrders = [];
  const { processor } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id] } }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(invoiceOrders.length, 2);
  for (const invoiceOrder of invoiceOrders) {
    assert.equal(invoiceOrder.discountAmount, 0);
    assert.equal(invoiceOrder.couponCode, null);
    assert.equal(invoiceOrder.adjustmentAmount, 0);
    assert.deepEqual(invoiceOrder.adjustments, []);
    assert.deepEqual(invoiceOrder.credits, []);
    assert.equal(invoiceOrder.shippingAddress.orderSummary.discountAmount, 0);
    assert.equal(invoiceOrder.shippingAddress.orderSummary.couponCode, null);
    assert.equal(invoiceOrder.shippingAddress.orderSummary.adjustmentAmount, 0);
    assert.deepEqual(invoiceOrder.shippingAddress.orderSummary.credits, []);
  }
});

test("seller invoice uses only authoritative sub-order discount and coupon allocation", async () => {
  const itemA = {
    id: "seller_a_discounted_item",
    quantity: 1,
    price: 100,
    product: { title: "Discounted Seller Item", sellerId: SELLER_A.id, seller: SELLER_A },
  };
  const itemB = {
    id: "seller_b_full_price_item",
    quantity: 1,
    price: 80,
    product: { title: "Full Price Seller Item", sellerId: SELLER_B.id, seller: SELLER_B },
  };
  const order = makeMultiSellerOrder({
    items: [],
    discountAmount: 50,
    couponCode: "PARENT",
    shippingAddress: {
      orderSummary: {
        shippingCost: 10,
        totalShippingCost: 20,
        gstPercentage: 10,
        discountAmount: 50,
        couponCode: "PARENT",
      },
    },
    subOrders: [
      { id: "sub_a", subDisplayId: "MULTI1-A", sellerId: SELLER_A.id, items: [itemA], seller: SELLER_A, discountAmount: 15, couponCode: "SELLERA" },
      { id: "sub_b", subDisplayId: "MULTI1-B", sellerId: SELLER_B.id, items: [itemB], seller: SELLER_B },
    ],
  });
  const invoiceOrders = [];
  const { processor } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id] } }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  const sellerAInvoice = invoiceOrders.find((invoiceOrder) => invoiceOrder.displayId === "MULTI1-A");
  const sellerBInvoice = invoiceOrders.find((invoiceOrder) => invoiceOrder.displayId === "MULTI1-B");
  assert.equal(sellerAInvoice.discountAmount, 15);
  assert.equal(sellerAInvoice.couponCode, "SELLERA");
  assert.equal(sellerAInvoice.shippingAddress.orderSummary.discountAmount, 15);
  assert.equal(sellerAInvoice.shippingAddress.orderSummary.couponCode, "SELLERA");
  assert.equal(sellerBInvoice.discountAmount, 0);
  assert.equal(sellerBInvoice.couponCode, null);
  assert.equal(sellerBInvoice.shippingAddress.orderSummary.discountAmount, 0);
  assert.equal(sellerBInvoice.shippingAddress.orderSummary.couponCode, null);
});

test("seller invoice uses seller-authoritative shipping and reconciles displayed arithmetic", async () => {
  const order = makeSingleSellerOrder({
    totalAmount: 999,
    shippingAddress: {
      orderSummary: {
        shippingCost: 7,
        totalShippingCost: 40,
        gstPercentage: 10,
        discountAmount: 33,
        couponCode: "PARENT",
      },
    },
  });
  const invoiceOrders = [];
  const { processor } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  const invoiceOrder = invoiceOrders[0];
  const summary = invoiceOrder.shippingAddress.orderSummary;
  const subtotal = invoiceOrder.items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  assert.equal(subtotal, 100);
  assert.equal(summary.shippingCost, 7);
  assert.equal(summary.totalShippingCost, 7);
  assert.equal(summary.discountAmount, 0);
  assert.equal(invoiceOrder.totalAmount, 107);
  assert.equal(invoiceOrder.totalAmount, subtotal + summary.shippingCost - summary.discountAmount);
});

test("customer invoice still receives the complete parent order financial fields unchanged", async () => {
  const order = makeSingleSellerOrder({
    discountAmount: 25,
    couponCode: "CUSTOMER",
    shippingAddress: {
      orderSummary: {
        shippingCost: 8,
        totalShippingCost: 8,
        gstPercentage: 10,
        discountAmount: 25,
        couponCode: "CUSTOMER",
      },
    },
  });
  const invoiceOrders = [];
  const { processor } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "customer", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
    invoiceImpl: async (invoiceOrder) => {
      invoiceOrders.push(invoiceOrder);
      return Buffer.from("pdf");
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(invoiceOrders.length, 1);
  assert.equal(invoiceOrders[0].discountAmount, 25);
  assert.equal(invoiceOrders[0].couponCode, "CUSTOMER");
  assert.equal(invoiceOrders[0].shippingAddress.orderSummary.discountAmount, 25);
  assert.equal(invoiceOrders[0].shippingAddress.orderSummary.couponCode, "CUSTOMER");
});

test("invalid invoice buffers fail customer jobs so they remain retryable", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
    invoiceImpl: async () => Buffer.alloc(0),
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 0);
  assert.equal(jobs.get("job_1").status, "FAILED");
  assert.match(jobs.get("job_1").lastError, /invalid buffer/);
  assert.equal(calls.customerEmail.length, 0);
});

test("invalid seller invoice buffers fail seller payment jobs before email delivery", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } }],
    invoiceImpl: async () => Buffer.alloc(0),
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 0);
  assert.equal(jobs.get("seller-payment").status, "FAILED");
  assert.match(jobs.get("seller-payment").lastError, /invalid buffer/);
  assert.equal(calls.sellerEmail.length, 0);
  assert.deepEqual(jobs.get("seller-payment").payload.sellerPaymentEmailDeliveredSellerIds || [], []);
});

test("stale PROCESSING outbox jobs are reclaimed and processed once", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{
      id: "job_stale",
      orderId: order.id,
      type: "CUSTOMER_CONFIRMATION",
      status: "PROCESSING",
      attemptCount: 1,
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    }],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("job_stale").status, "PROCESSED");
  assert.equal(jobs.get("job_stale").attemptCount, 2);
  assert.equal(calls.customerEmail.length, 1);
});

test("pending confirmation jobs do not send after refund or cancellation state", async () => {
  const order = makeSingleSellerOrder({ status: "REFUND", paymentStatus: "REFUNDED" });
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_refund", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("job_refund").status, "PROCESSED");
  assert.equal(calls.customerEmail.length, 0);
});

test("guest checkout (no userId) resolves the order.customerEmail for confirmation", async () => {
  const order = makeGuestOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("job_1").status, "PROCESSED");
  assert.equal(calls.customerEmail[0].email, "guest@example.com");
});

test("an already PROCESSED job is not re-picked-up or re-sent on the next poll", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
  });

  await processor.processPaymentCompletionOutboxOnce();
  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(calls.customerEmail.length, 1);
  assert.equal(jobs.get("job_1").status, "PROCESSED");
});

test("missing customer email skips (not crashes) the confirmation job", async () => {
  const order = makeSingleSellerOrder({ customerEmail: null, user: null });
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "job_1", orderId: order.id, type: "CUSTOMER_CONFIRMATION" }],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("job_1").status, "PROCESSED");
  assert.equal(calls.customerEmail.length, 0);
});

test("one seller missing an email does not crash the SELLER_PAYMENT_NOTIFICATION job for the others", async () => {
  const sellerNoEmail = { id: "seller_no_email", email: null, name: "Seller No Email" };
  const order = makeMultiSellerOrder({
    items: [
      { quantity: 1, price: 100, product: { title: "Item A", sellerId: SELLER_A.id, seller: SELLER_A } },
      { quantity: 1, price: 50, product: { title: "Item Missing", sellerId: sellerNoEmail.id, seller: sellerNoEmail } },
    ],
  });
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, sellerNoEmail.id] } }],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("seller-payment").status, "PROCESSED");
  assert.equal(calls.sellerEmail.length, 1);
  assert.equal(calls.sellerEmail[0].email, SELLER_A.email);
});

test("seller payment retry skips sellers already delivered in the grouped legacy payload", async () => {
  const order = makeMultiSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "seller-payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id, SELLER_B.id, SELLER_C.id] } }],
    emailResults: {
      sendSellerPaymentReceivedEmail: [
        { success: true },
        { success: false, error: "mailbox full" },
        { success: true },
        { success: true },
      ],
    },
  });

  const first = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(first.processed, 0);
  assert.equal(jobs.get("seller-payment").status, "FAILED");
  assert.equal(calls.sellerEmail.length, 3);
  assert.deepEqual(jobs.get("seller-payment").payload.sellerPaymentEmailDeliveredSellerIds.sort(), [SELLER_A.id, SELLER_C.id].sort());
  assert.match(jobs.get("seller-payment").lastError, /mailbox full/);

  const second = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(second.processed, 1);
  assert.equal(jobs.get("seller-payment").status, "PROCESSED");
  assert.deepEqual(calls.sellerEmail.map((c) => c.email), [
    SELLER_A.email,
    SELLER_B.email,
    SELLER_C.email,
    SELLER_B.email,
  ]);
});

test("a failed job does not flip unrelated jobs for the same order to PROCESSED", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [
      { id: "job_customer", orderId: order.id, type: "CUSTOMER_CONFIRMATION" },
      { id: "job_finance", orderId: order.id, type: "FINANCE_INVOICE" },
    ],
    emailResults: {
      sendOrderConfirmationEmail: { success: false, error: "provider down" },
      sendFinanceOrderInvoiceEmail: { success: true },
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(jobs.get("job_customer").status, "FAILED");
  assert.equal(jobs.get("job_finance").status, "PROCESSED");
});

test("a failed FINANCE_INVOICE job does not affect customer/seller/admin job outcomes for the same order", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [
      { id: "job_customer", orderId: order.id, type: "CUSTOMER_CONFIRMATION" },
      { id: "job_finance", orderId: order.id, type: "FINANCE_INVOICE" },
      { id: "job_seller_payment", orderId: order.id, type: "SELLER_PAYMENT_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } },
    ],
    emailResults: {
      sendOrderConfirmationEmail: { success: true },
      sendFinanceOrderInvoiceEmail: { success: false, error: "FINANCE_EMAIL_RECEIVER is not configured" },
      sendSellerPaymentReceivedEmail: { success: true },
    },
  });

  await processor.processPaymentCompletionOutboxOnce();

  assert.equal(jobs.get("job_finance").status, "FAILED");
  assert.match(jobs.get("job_finance").lastError, /FINANCE_EMAIL_RECEIVER/);
  assert.equal(jobs.get("job_customer").status, "PROCESSED");
  assert.equal(jobs.get("job_seller_payment").status, "PROCESSED");
  assert.equal(calls.customerEmail.length, 1);
  assert.equal(calls.sellerEmail.length, 1);
});

test("admin email failures remain retryable without duplicating successful admins or in-app notifications", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "admin-job", orderId: order.id, type: "ADMIN_NEW_ORDER_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } }],
    admins: [
      { id: "super_a", email: "super-a@example.com", name: "Super A", role: "SUPER_ADMIN" },
      { id: "super_b", email: "super-b@example.com", name: "Super B", role: "SUPER_ADMIN" },
    ],
    emailResults: {
      sendAdminNewOrderEmail: [
        { success: true },
        { success: false, error: "admin mailbox down" },
        { success: true },
      ],
    },
  });

  const first = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(first.processed, 0);
  assert.equal(jobs.get("admin-job").status, "FAILED");
  assert.equal(calls.notifyAdmin.length, 1);
  assert.deepEqual(jobs.get("admin-job").payload.adminNewOrderEmailDeliveredAdminIds, ["super_a"]);
  assert.match(jobs.get("admin-job").lastError, /admin mailbox down/);

  const second = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(second.processed, 1);
  assert.equal(jobs.get("admin-job").status, "PROCESSED");
  assert.equal(calls.notifyAdmin.length, 1);
  assert.deepEqual(calls.adminEmail.map((c) => c.email), ["super-a@example.com", "super-b@example.com", "super-b@example.com"]);
});

test("missing or invalid admin recipients do not crash payment completion", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "admin-job", orderId: order.id, type: "ADMIN_NEW_ORDER_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } }],
    admins: [
      { id: "admin_missing", email: null, name: "Missing" },
      { id: "admin_invalid", email: "not-an-email", name: "Invalid" },
    ],
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(jobs.get("admin-job").status, "PROCESSED");
  assert.equal(calls.notifyAdmin.length, 1);
  assert.equal(calls.adminEmail.length, 0);
});
