const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const ordersControllerPath = path.resolve(__dirname, "../controllers/orders.js");

function paymentRecord(overrides = {}) {
  return {
    id: "opr_1",
    orderId: "order_1",
    paymentFlow: "PLATFORM_ACCOUNT",
    stripeAccountId: null,
    stripePaymentIntentId: "pi_1",
    refundStatus: "NONE",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makePrisma(records = []) {
  const prisma = {
    _records: records,
    _updates: [],
    orderPaymentRecord: {
      findMany: async ({ where }) => records.filter(record => record.orderId === where.orderId),
      findUnique: async ({ where }) => records.find(record => record.stripePaymentIntentId === where.stripePaymentIntentId) || null,
      update: async (args) => {
        const record = records.find(item => item.id === args.where.id);
        if (record) Object.assign(record, args.data);
        prisma._updates.push(args);
        return { ...record, ...args.data };
      },
    },
    $queryRaw: async () => [{ id: "ce_1", stripe_transfer_id: "tr_1" }],
    $executeRaw: async () => 1,
  };
  return prisma;
}

function makeStripeMock({ statuses = {}, failPaymentIntentIds = [] } = {}) {
  return {
    paymentIntents: {
      retrieveCalls: [],
      cancelCalls: [],
      retrieve: async function(paymentIntentId, options) {
        this.retrieveCalls.push({ paymentIntentId, options });
        return { id: paymentIntentId, status: statuses[paymentIntentId] || "succeeded" };
      },
      cancel: async function(paymentIntentId, params, options) {
        this.cancelCalls.push({ paymentIntentId, params, options });
        return { id: paymentIntentId, status: "canceled" };
      },
    },
    refunds: {
      createCalls: [],
      create: async function(params, options) {
        this.createCalls.push({ params, options });
        if (failPaymentIntentIds.includes(params.payment_intent)) throw new Error(`refund failed for ${params.payment_intent}`);
        return { id: `re_${params.payment_intent}`, payment_intent: params.payment_intent };
      },
    },
    transfers: {
      createReversal: async () => ({ id: "trr_1" }),
    },
  };
}

function loadOrdersController({ prisma, stripeMock }) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = (() => {
      try {
        return Module._resolveFilename(request, parent);
      } catch (_) {
        return request;
      }
    })();
    if (request === "stripe") return function Stripe() { return stripeMock; };
    if (resolved === prismaPath) return prisma;
    if (request.includes("emailService")) return {};
    if (request.includes("notification")) return {};
    if (request.includes("orderNotification")) return {};
    if (request.includes("cart")) return {};
    if (request.includes("commission")) return {};
    if (request.includes("cloudinary")) return {};
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[ordersControllerPath];
  const controller = require(ordersControllerPath);
  Module._load = originalLoad;
  return controller;
}

test("single legacy direct order cancellation preserves single-PaymentIntent path", async () => {
  const records = [paymentRecord({ id: "opr_legacy", stripePaymentIntentId: "pi_legacy" })];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({
    orderId: "missing_order",
    displayId: "ABC123",
    reason: "Customer cancelled",
    legacyPaymentIntentId: "pi_legacy",
  });

  assert.equal(outcome.failed, 0);
  assert.equal(stripeMock.refunds.createCalls.length, 1);
  assert.equal(stripeMock.refunds.createCalls[0].params.payment_intent, "pi_legacy");
});

test("multi-seller ALPA plus one seller refunds platform and connected Direct Charge", async () => {
  const records = [
    paymentRecord({ id: "opr_platform", stripePaymentIntentId: "pi_platform" }),
    paymentRecord({ id: "opr_seller", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_seller", stripePaymentIntentId: "pi_seller" }),
  ];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.failed, 0);
  assert.equal(stripeMock.refunds.createCalls[0].options.stripeAccount, undefined);
  assert.equal(stripeMock.refunds.createCalls[1].options.stripeAccount, "acct_seller");
  assert.equal(stripeMock.refunds.createCalls[1].params.refund_application_fee, true);
  assert.deepEqual(stripeMock.refunds.createCalls.map(call => call.options.idempotencyKey), [
    "refund:opr_platform:cancel:ABC123",
    "refund:opr_seller:cancel:ABC123",
  ]);
});

test("ALPA plus two sellers processes three independent payment records", async () => {
  const records = [
    paymentRecord({ id: "opr_platform", stripePaymentIntentId: "pi_platform" }),
    paymentRecord({ id: "opr_seller_a", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_a", stripePaymentIntentId: "pi_a" }),
    paymentRecord({ id: "opr_seller_b", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_b", stripePaymentIntentId: "pi_b" }),
  ];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.equal(outcome.attempted, 3);
  assert.deepEqual(stripeMock.refunds.createCalls.map(call => call.options.stripeAccount), [undefined, "acct_a", "acct_b"]);
});

test("platform-only multi-payment order uses platform context only", async () => {
  const records = [
    paymentRecord({ id: "opr_platform_a", stripePaymentIntentId: "pi_platform_a" }),
    paymentRecord({ id: "opr_platform_b", stripePaymentIntentId: "pi_platform_b" }),
  ];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.deepEqual(stripeMock.refunds.createCalls.map(call => call.options.stripeAccount), [undefined, undefined]);
});

test("seller-only multi-payment order refunds every Direct Charge with connected account", async () => {
  const records = [
    paymentRecord({ id: "opr_seller_a", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_a", stripePaymentIntentId: "pi_a" }),
    paymentRecord({ id: "opr_seller_b", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_b", stripePaymentIntentId: "pi_b" }),
  ];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.deepEqual(stripeMock.refunds.createCalls.map(call => call.options.stripeAccount), ["acct_a", "acct_b"]);
});

test("duplicate cancellation skips already fully refunded payment record", async () => {
  const records = [paymentRecord({ refundStatus: "FULL" })];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.equal(outcome.failed, 0);
  assert.equal(outcome.results[0].reason, "already_refunded");
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("one refund failure is reported while successful payment groups stay refunded", async () => {
  const records = [
    paymentRecord({ id: "opr_platform", stripePaymentIntentId: "pi_platform" }),
    paymentRecord({ id: "opr_seller", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_seller", stripePaymentIntentId: "pi_seller" }),
  ];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock({ failPaymentIntentIds: ["pi_seller"] });
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 1);
  assert.equal(records[0].refundStatus, "FULL");
  assert.equal(records[1].refundStatus, "FAILED");
});

test("non-succeeded PaymentIntent preserves cancel-vs-refund behavior", async () => {
  const records = [paymentRecord({ stripePaymentIntentId: "pi_requires_action" })];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock({ statuses: { pi_requires_action: "requires_action" } });
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.equal(outcome.results[0].status, "cancelled_payment_intent");
  assert.equal(stripeMock.refunds.createCalls.length, 0);
  assert.equal(stripeMock.paymentIntents.cancelCalls[0].paymentIntentId, "pi_requires_action");
});

test("missing stripeAccountId for Direct Charge fails safely without platform refund", async () => {
  const records = [paymentRecord({ paymentFlow: "DIRECT_CHARGE", stripeAccountId: null })];
  const prisma = makePrisma(records);
  const stripeMock = makeStripeMock();
  const controller = loadOrdersController({ prisma, stripeMock });

  const outcome = await controller._refundOrderPaymentsForCancellation({ orderId: "order_1", displayId: "ABC123", reason: "Cancelled" });

  assert.equal(outcome.failed, 1);
  assert.equal(stripeMock.refunds.createCalls.length, 0);
  assert.equal(records[0].refundStatus, "FAILED");
});
