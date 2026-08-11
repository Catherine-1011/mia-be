const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const paymentControllerPath = path.resolve(__dirname, "../controllers/payment.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");

function makeReply() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

// Builds a prisma double that models real filtering semantics for the fields
// the charge.refunded handler actually queries on (orderId / sellerId /
// stripePaymentIntentId / status), so assertions can check final row state
// without hard-coding the exact query shape used by the implementation.
function makePrisma({ orders, paymentRecords, commissionRows }) {
  const webhookEvents = new Map();
  const calls = {
    orderPaymentRecordUpdateMany: [],
    commissionEarnedUpdateMany: [],
    orderUpdate: [],
  };

  const paymentRecordsByPI = new Map(paymentRecords.map((r) => [r.stripePaymentIntentId, { ...r }]));

  const prisma = {
    _calls: calls,
    _webhookEvents: webhookEvents,
    _paymentRecordsByPI: paymentRecordsByPI,
    _commissionRows: commissionRows,
    order: {
      findFirst: async ({ where } = {}) => {
        if (where?.stripePaymentIntentId !== undefined) {
          return orders.find((o) => o.stripePaymentIntentId === where.stripePaymentIntentId) || null;
        }
        return null;
      },
      update: async (args) => {
        calls.orderUpdate.push(args);
        return {};
      },
    },
    orderPaymentRecord: {
      findUnique: async ({ where }) => {
        const rec = paymentRecordsByPI.get(where.stripePaymentIntentId);
        return rec ? { ...rec } : null;
      },
      findMany: async ({ where }) => [...paymentRecordsByPI.values()].filter((r) => r.orderId === where.orderId),
      updateMany: async ({ where, data }) => {
        calls.orderPaymentRecordUpdateMany.push({ where, data });
        let count = 0;
        for (const rec of paymentRecordsByPI.values()) {
          if (where.stripePaymentIntentId !== undefined && rec.stripePaymentIntentId !== where.stripePaymentIntentId) continue;
          Object.assign(rec, data);
          count++;
        }
        return { count };
      },
    },
    commissionEarned: {
      updateMany: async ({ where, data }) => {
        calls.commissionEarnedUpdateMany.push({ where, data });
        let count = 0;
        for (const row of commissionRows) {
          if (where.orderId !== undefined && row.orderId !== where.orderId) continue;
          if (where.sellerId !== undefined && row.sellerId !== where.sellerId) continue;
          if (where.status?.not !== undefined && row.status === where.status.not) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      },
    },
    stripeWebhookEvent: {
      create: async ({ data }) => {
        if (webhookEvents.has(data.eventId)) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { id: `swe_${webhookEvents.size + 1}`, attemptCount: 0, status: "RECEIVED", ...data };
        webhookEvents.set(data.eventId, row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = webhookEvents.get(where.eventId);
        const matches = () => {
          if (where.status?.in?.includes(row.status)) return true;
          if (!Array.isArray(where.OR)) return false;
          return where.OR.some((clause) => {
            if (clause.status?.in?.includes(row.status)) return true;
            if (clause.status === row.status && clause.updatedAt?.lt) {
              return new Date(row.updatedAt || 0) < clause.updatedAt.lt;
            }
            return false;
          });
        };
        if (!row || !matches()) return { count: 0 };
        Object.assign(row, { ...data, updatedAt: new Date() });
        return { count: 1 };
      },
      findUnique: async ({ where }) => webhookEvents.get(where.eventId) || null,
      update: async ({ where, data }) => {
        const row = webhookEvents.get(where.eventId);
        Object.assign(row, data);
        return row;
      },
    },
    $queryRaw: async () => [],
    $executeRaw: async () => ({}),
  };
  return prisma;
}

function makeStripeMock({ chargeType = "direct" } = {}) {
  return {
    paymentIntents: {
      retrieveCalls: [],
      retrieve: async function (id, options) {
        this.retrieveCalls.push({ id, options });
        return { id, metadata: { chargeType } };
      },
    },
    webhooks: {
      constructEvent: (raw, sig, secret, event) => event,
    },
    transfers: {
      createReversal: async () => ({ id: "trr_1" }),
    },
  };
}

function loadPaymentController({ prisma, stripeMock, webhookEvent }) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => {
      try {
        return Module._resolveFilename(request, parent);
      } catch (_) {
        return request;
      }
    })();
    if (request === "stripe") {
      return function Stripe() {
        return {
          ...stripeMock,
          webhooks: { constructEvent: () => webhookEvent },
        };
      };
    }
    if (resolved === prismaPath) return prisma;
    if (request.includes("emailService")) return {};
    if (request.includes("notification")) return {};
    if (request.includes("orderNotification")) return {};
    if (request.includes("cart")) return {};
    if (request.includes("commission")) return {};
    if (request.includes("cloudinary")) return {};
    if (request.includes("orders")) return {};
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[paymentControllerPath];
  const controller = require(paymentControllerPath);
  Module._load = originalLoad;
  return controller;
}

async function sendChargeRefundedWebhook(controller, { eventId, piId, account = null, amount = 12000, amountRefunded = 12000 }) {
  const reply = makeReply();
  await controller.stripeWebhook(
    {
      headers: { "stripe-signature": "sig" },
      rawBody: Buffer.from("{}"),
    },
    reply,
  );
  return reply;
}

function buildEvent({ eventId, piId, account = null, amount = 12000, amountRefunded = 12000 }) {
  return {
    id: eventId,
    type: "charge.refunded",
    account,
    livemode: false,
    data: { object: { id: "ch_1", payment_intent: piId, amount, amount_refunded: amountRefunded } },
  };
}

// ── A. Single-seller Direct Charge refund ──────────────────────────────────
test("single-seller Direct Charge refund reconciles OrderPaymentRecord and cancels its commission", async () => {
  const orders = [{ id: "order_1", stripePaymentIntentId: "pi_seller" }];
  const paymentRecords = [
    { id: "opr_seller", orderId: "order_1", sellerId: "seller_1", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_1", stripePaymentIntentId: "pi_seller", refundStatus: "NONE" },
  ];
  const commissionRows = [{ id: "ce_1", orderId: "order_1", sellerId: "seller_1", status: "PAID" }];
  const prisma = makePrisma({ orders, paymentRecords, commissionRows });
  const stripeMock = makeStripeMock({ chargeType: "direct" });
  const webhookEvent = buildEvent({ eventId: "evt_a", piId: "pi_seller", account: "acct_1" });
  const controller = loadPaymentController({ prisma, stripeMock, webhookEvent });

  const reply = await sendChargeRefundedWebhook(controller, {});

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._paymentRecordsByPI.get("pi_seller").refundStatus, "FULL");
  assert.equal(commissionRows[0].status, "CANCELLED");
});

// ── B. Mixed ALPA + one seller refund ───────────────────────────────────────
test("mixed ALPA + seller order: seller Direct Charge refund cancels only the seller commission, not the platform payment", async () => {
  // Order.stripePaymentIntentId was claimed by the ALPA platform PI succeeding
  // first (real behavior of handlePaymentSucceeded backfilling a null field) —
  // it therefore does NOT match the seller's own PaymentIntent.
  const orders = [{ id: "order_1", stripePaymentIntentId: "pi_platform" }];
  const paymentRecords = [
    { id: "opr_platform", orderId: "order_1", sellerId: null, paymentFlow: "PLATFORM_ACCOUNT", stripeAccountId: null, stripePaymentIntentId: "pi_platform", refundStatus: "NONE" },
    { id: "opr_seller", orderId: "order_1", sellerId: "seller_1", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_1", stripePaymentIntentId: "pi_seller", refundStatus: "NONE" },
  ];
  const commissionRows = [{ id: "ce_1", orderId: "order_1", sellerId: "seller_1", status: "PAID" }];
  const prisma = makePrisma({ orders, paymentRecords, commissionRows });
  const stripeMock = makeStripeMock({ chargeType: "direct" });
  const webhookEvent = buildEvent({ eventId: "evt_b", piId: "pi_seller", account: "acct_1" });
  const controller = loadPaymentController({ prisma, stripeMock, webhookEvent });

  const reply = await sendChargeRefundedWebhook(controller, {});

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._paymentRecordsByPI.get("pi_seller").refundStatus, "FULL");
  assert.equal(commissionRows[0].status, "CANCELLED");
  // Platform payment record must be left completely untouched.
  assert.equal(prisma._paymentRecordsByPI.get("pi_platform").refundStatus, "NONE");
});

// ── C. ALPA + two sellers: independent reconciliation ───────────────────────
test("ALPA + two sellers: refunding seller B does not cancel seller A's commission", async () => {
  const orders = [{ id: "order_1", stripePaymentIntentId: "pi_platform" }];
  const paymentRecords = [
    { id: "opr_platform", orderId: "order_1", sellerId: null, paymentFlow: "PLATFORM_ACCOUNT", stripeAccountId: null, stripePaymentIntentId: "pi_platform", refundStatus: "NONE" },
    { id: "opr_seller_a", orderId: "order_1", sellerId: "seller_a", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_a", stripePaymentIntentId: "pi_seller_a", refundStatus: "NONE" },
    { id: "opr_seller_b", orderId: "order_1", sellerId: "seller_b", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_b", stripePaymentIntentId: "pi_seller_b", refundStatus: "NONE" },
  ];
  const commissionRows = [
    { id: "ce_a", orderId: "order_1", sellerId: "seller_a", status: "PAID" },
    { id: "ce_b", orderId: "order_1", sellerId: "seller_b", status: "PAID" },
  ];
  const prisma = makePrisma({ orders, paymentRecords, commissionRows });
  const stripeMock = makeStripeMock({ chargeType: "direct" });
  const webhookEvent = buildEvent({ eventId: "evt_c", piId: "pi_seller_b", account: "acct_b" });
  const controller = loadPaymentController({ prisma, stripeMock, webhookEvent });

  const reply = await sendChargeRefundedWebhook(controller, {});

  assert.equal(reply.statusCode, 200);
  const commissionA = commissionRows.find((r) => r.sellerId === "seller_a");
  const commissionB = commissionRows.find((r) => r.sellerId === "seller_b");
  assert.equal(commissionB.status, "CANCELLED");
  assert.equal(commissionA.status, "PAID", "seller A commission must be untouched by seller B's refund");
});

// ── D. Order.stripePaymentIntentId != seller PaymentIntent ─────────────────
test("charge.refunded reconciles via OrderPaymentRecord.orderId even when Order.stripePaymentIntentId points at a different PI", async () => {
  const orders = [{ id: "order_1", stripePaymentIntentId: "pi_unrelated_legacy_field" }];
  const paymentRecords = [
    { id: "opr_seller", orderId: "order_1", sellerId: "seller_1", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_1", stripePaymentIntentId: "pi_seller", refundStatus: "NONE" },
  ];
  const commissionRows = [{ id: "ce_1", orderId: "order_1", sellerId: "seller_1", status: "PAID" }];
  const prisma = makePrisma({ orders, paymentRecords, commissionRows });
  const stripeMock = makeStripeMock({ chargeType: "direct" });
  const webhookEvent = buildEvent({ eventId: "evt_d", piId: "pi_seller", account: "acct_1" });
  const controller = loadPaymentController({ prisma, stripeMock, webhookEvent });

  // Sanity: prove the mismatch actually exists in this fixture (this is what
  // the old, buggy `Order.findFirst({ stripePaymentIntentId: piId })` lookup
  // would have failed on).
  assert.notEqual(orders[0].stripePaymentIntentId, "pi_seller");

  const reply = await sendChargeRefundedWebhook(controller, {});

  assert.equal(reply.statusCode, 200);
  assert.equal(commissionRows[0].status, "CANCELLED", "commission must still be reconciled using OrderPaymentRecord.orderId");
});

// ── E. Duplicate charge.refunded event is idempotent ────────────────────────
test("duplicate charge.refunded event does not double-cancel or double-mutate the commission record", async () => {
  const orders = [{ id: "order_1", stripePaymentIntentId: "pi_seller" }];
  const paymentRecords = [
    { id: "opr_seller", orderId: "order_1", sellerId: "seller_1", paymentFlow: "DIRECT_CHARGE", stripeAccountId: "acct_1", stripePaymentIntentId: "pi_seller", refundStatus: "NONE" },
  ];
  const commissionRows = [{ id: "ce_1", orderId: "order_1", sellerId: "seller_1", status: "PAID" }];
  const prisma = makePrisma({ orders, paymentRecords, commissionRows });
  const stripeMock = makeStripeMock({ chargeType: "direct" });
  const webhookEvent = buildEvent({ eventId: "evt_dup", piId: "pi_seller", account: "acct_1" });
  const controller = loadPaymentController({ prisma, stripeMock, webhookEvent });

  const first = await sendChargeRefundedWebhook(controller, {});
  const duplicate = await sendChargeRefundedWebhook(controller, {});

  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(commissionRows[0].status, "CANCELLED");
  assert.equal(prisma._calls.commissionEarnedUpdateMany.length, 1, "handler body must not re-run for a duplicate event id");
});
