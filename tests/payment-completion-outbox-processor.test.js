const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const emailPath = path.resolve(__dirname, "../utils/emailService.js");
const notificationPath = path.resolve(__dirname, "../controllers/notification.js");
const ordersPath = path.resolve(__dirname, "../controllers/orders.js");
const processorPath = path.resolve(__dirname, "../utils/paymentCompletionOutboxProcessor.js");

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

function loadProcessor({ ordersById, jobs, emailResults = {}, notificationImpls = {}, admins = [ADMIN_A, ADMIN_B] } = {}) {
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
      findMany: async () => [...jobMap.values()].filter((job) => ["PENDING", "FAILED"].includes(job.status) && job.attemptCount < 10),
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
      findMany: async () => admins,
    },
  };

  require.cache[prismaPath] = { exports: prisma };
  require.cache[emailPath] = {
    exports: {
      sendOrderConfirmationEmail: async (email, name, details) => {
        calls.customerEmail.push({ email, name, isSuperAdminCopy: !!details.isSuperAdminCopy });
        return nextResult("sendOrderConfirmationEmail");
      },
      sendFinanceOrderInvoiceEmail: async (order) => {
        calls.financeEmail.push({ orderId: order.id });
        return nextResult("sendFinanceOrderInvoiceEmail");
      },
      sendSellerPaymentReceivedEmail: async (email, name, details) => {
        calls.sellerEmail.push({ email, name, amount: details.amount });
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
      generateInvoiceBuffer: async () => {
        calls.invoice += 1;
        return Buffer.from("pdf");
      },
    },
  };

  const processor = require(processorPath);
  return { processor, jobs: jobMap, calls };
}

function outboxRowsFor(order, sellerIds) {
  return [
    { id: `${order.id}-customer`, orderId: order.id, type: "CUSTOMER_CONFIRMATION" },
    { id: `${order.id}-finance`, orderId: order.id, type: "FINANCE_INVOICE" },
    { id: `${order.id}-admin`, orderId: order.id, type: "ADMIN_NEW_ORDER_NOTIFICATION", payload: { sellerIds } },
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

test("a successful payment creates customer, finance, admin, and seller job outcomes", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: outboxRowsFor(order, [SELLER_A.id]),
  });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 5);
  for (const job of jobs.values()) assert.equal(job.status, "PROCESSED");
  assert.equal(calls.customerEmail.length, 1);
  assert.equal(calls.financeEmail.length, 1);
  assert.equal(calls.notifyAdmin.length, 1);
  assert.equal(calls.adminEmail.length, 2);
  assert.deepEqual(calls.adminEmail.map((c) => c.email).sort(), [ADMIN_A.email, ADMIN_B.email].sort());
  assert.equal(calls.notifySeller.length, 1);
  assert.equal(calls.sellerEmail.length, 1);
  assert.equal(calls.sellerEmail[0].email, SELLER_A.email);
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

test("admin email failures remain retryable without duplicating successful admins or in-app notifications", async () => {
  const order = makeSingleSellerOrder();
  const { processor, jobs, calls } = loadProcessor({
    ordersById: { [order.id]: order },
    jobs: [{ id: "admin-job", orderId: order.id, type: "ADMIN_NEW_ORDER_NOTIFICATION", payload: { sellerIds: [SELLER_A.id] } }],
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
  assert.deepEqual(jobs.get("admin-job").payload.adminNewOrderEmailDeliveredAdminIds, [ADMIN_A.id]);
  assert.match(jobs.get("admin-job").lastError, /admin mailbox down/);

  const second = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(second.processed, 1);
  assert.equal(jobs.get("admin-job").status, "PROCESSED");
  assert.equal(calls.notifyAdmin.length, 1);
  assert.deepEqual(calls.adminEmail.map((c) => c.email), [ADMIN_A.email, ADMIN_B.email, ADMIN_B.email]);
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
