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

function makeOrder() {
  return {
    id: "order_1",
    displayId: "ABC123",
    customerEmail: "customer@example.com",
    customerName: "Customer",
    totalAmount: 120,
    paymentMethod: "STRIPE",
    shippingAddress: { orderSummary: { shippingCost: 20 } },
    items: [
      {
        quantity: 1,
        price: 100,
        product: {
          title: "Artwork",
          sellerId: "seller_1",
          seller: { email: "seller@example.com", name: "Seller", sellerProfile: { storeName: "Store" } },
        },
      },
    ],
    subOrders: [],
    user: null,
  };
}

function loadProcessor({ failEmail = false } = {}) {
  resetModules();
  const jobs = new Map([
    ["job_1", {
      id: "job_1",
      orderId: "order_1",
      stripePaymentIntentId: "pi_123",
      type: "CUSTOMER_CONFIRMATION",
      payload: {},
      status: "PENDING",
      attemptCount: 0,
      createdAt: new Date(),
    }],
  ]);
  const calls = { customerEmail: 0, invoice: 0 };

  const prisma = {
    paymentCompletionOutbox: {
      findMany: async () => [...jobs.values()].filter((job) => ["PENDING", "FAILED"].includes(job.status)),
      updateMany: async ({ where, data }) => {
        const job = jobs.get(where.id);
        if (!job || job.status !== where.status || job.attemptCount >= where.attemptCount.lt) return { count: 0 };
        job.status = data.status;
        job.attemptCount += data.attemptCount.increment;
        job.lastError = data.lastError;
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        Object.assign(jobs.get(where.id), data);
        return jobs.get(where.id);
      },
    },
    order: {
      findUnique: async () => makeOrder(),
    },
  };

  require.cache[prismaPath] = { exports: prisma };
  require.cache[emailPath] = {
    exports: {
      sendOrderConfirmationEmail: async () => {
        calls.customerEmail += 1;
        if (failEmail) throw new Error("email unavailable");
      },
      sendFinanceOrderInvoiceEmail: async () => {},
      sendSellerPaymentReceivedEmail: async () => {},
    },
  };
  require.cache[notificationPath] = {
    exports: {
      notifyAdminNewOrder: async () => {},
      notifySellerNewOrder: async () => {},
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
  return { processor, jobs, calls };
}

test("payment completion outbox worker processes a claimed customer confirmation once", async () => {
  const { processor, jobs, calls } = loadProcessor();

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 1);
  assert.equal(calls.customerEmail, 1);
  assert.equal(calls.invoice, 1);
  assert.equal(jobs.get("job_1").status, "PROCESSED");
  assert.equal(jobs.get("job_1").attemptCount, 1);
  assert.equal(jobs.get("job_1").lastError, null);
});

test("payment completion outbox worker stores FAILED with lastError when required work fails", async () => {
  const { processor, jobs } = loadProcessor({ failEmail: true });

  const result = await processor.processPaymentCompletionOutboxOnce();

  assert.equal(result.processed, 0);
  assert.equal(jobs.get("job_1").status, "FAILED");
  assert.match(jobs.get("job_1").lastError, /email unavailable/);
  assert.equal(jobs.get("job_1").attemptCount, 1);
});
