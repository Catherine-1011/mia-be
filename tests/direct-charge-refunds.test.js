const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const adminControllerPath = path.resolve(__dirname, "../controllers/admin.js");

function makeStripeMock({ failRefund = false } = {}) {
  return {
    refunds: {
      createCalls: [],
      create: async function(params, options) {
        this.createCalls.push({ params, options });
        if (failRefund) throw new Error("stripe unavailable");
        return {
          id: "re_123",
          status: "succeeded",
          payment_intent: params.payment_intent,
          amount: params.amount || 12000,
          application_fee_amount_refunded: params.amount ? 500 : 1000,
        };
      },
    },
    transfers: {
      createReversalCalls: [],
      createReversal: async function(transferId, params, options) {
        this.createReversalCalls.push({ transferId, params, options });
        return { id: `trr_${transferId}` };
      },
    },
  };
}

function makePrisma({ transferRows = [] } = {}) {
  return {
    _paymentRecordUpdates: [],
    _transferRows: transferRows,
    _executeRawCalls: [],
    orderPaymentRecord: {
      update: async function(args) {
        this._lastUpdate = args;
        return args;
      },
    },
    $queryRaw: async function() {
      return this._transferRows;
    },
    $executeRaw: async function(strings, ...values) {
      this._executeRawCalls.push({ strings, values });
      return 1;
    },
  };
}

function loadAdminController({ prisma, stripeMock }) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = (() => {
      try {
        return Module._resolveFilename(request, parent);
      } catch (_) {
        return request;
      }
    })();
    if (request === "stripe") {
      return function Stripe() {
        return stripeMock;
      };
    }
    if (resolved === prismaPath) return prisma;
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[adminControllerPath];
  const controller = require(adminControllerPath);
  Module._load = originalLoad;
  return controller;
}

function directPaymentRecord(overrides = {}) {
  return {
    id: "opr_123",
    orderId: "order_1",
    sellerId: "seller_1",
    paymentFlow: "DIRECT_CHARGE",
    stripeAccountId: "acct_original",
    stripePaymentIntentId: "pi_original",
    grossAmount: 12000,
    refundStatus: "NONE",
    ...overrides,
  };
}

const order = { id: "order_1" };
const ticket = { id: "ticket_1" };

test("full Direct Charge refund uses seller Stripe account and refunds application fee", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await controller._createStripeRefundFromPaymentRecord({
    order,
    ticket,
    paymentRecord: directPaymentRecord(),
    refundAmountCents: 12000,
    isFullRefund: true,
  });

  assert.equal(stripeMock.refunds.createCalls.length, 1);
  const call = stripeMock.refunds.createCalls[0];
  assert.equal(call.params.payment_intent, "pi_original");
  assert.equal(call.params.amount, undefined);
  assert.equal(call.params.refund_application_fee, true);
  assert.equal(call.options.stripeAccount, "acct_original");
  assert.equal(call.options.idempotencyKey, "refund:opr_123:ticket_1");
  assert.equal(prisma.orderPaymentRecord._lastUpdate.data.refundStatus, "FULL");
});

test("partial Direct Charge refund uses seller Stripe account and proportional application fee flag", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  const refund = await controller._createStripeRefundFromPaymentRecord({
    order,
    ticket,
    paymentRecord: directPaymentRecord(),
    refundAmountCents: 6000,
    isFullRefund: false,
  });

  const call = stripeMock.refunds.createCalls[0];
  assert.equal(call.params.amount, 6000);
  assert.equal(call.params.refund_application_fee, true);
  assert.equal(call.options.stripeAccount, "acct_original");
  assert.equal(refund.application_fee_amount_refunded, 500);
  assert.equal(prisma.orderPaymentRecord._lastUpdate.data.refundStatus, "PARTIAL");
});

test("duplicate refund request uses deterministic idempotency key", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });
  const args = {
    order,
    ticket,
    paymentRecord: directPaymentRecord(),
    refundAmountCents: 12000,
    isFullRefund: true,
  };

  await controller._createStripeRefundFromPaymentRecord(args);
  await controller._createStripeRefundFromPaymentRecord(args);

  assert.equal(stripeMock.refunds.createCalls.length, 2);
  assert.equal(stripeMock.refunds.createCalls[0].options.idempotencyKey, "refund:opr_123:ticket_1");
  assert.equal(stripeMock.refunds.createCalls[1].options.idempotencyKey, "refund:opr_123:ticket_1");
});

test("already fully refunded payment does not create another Stripe refund", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord({ refundStatus: "FULL" }),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /already been fully refunded/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("refund amount cannot exceed refundable balance", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord(),
      refundAmountCents: 12001,
      isFullRefund: false,
    }),
    /exceeds refundable balance/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("frontend cannot override or swap Stripe account context", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await controller._createStripeRefundFromPaymentRecord({
    order: { id: "order_1", sellerId: "seller_changed", stripeAccountId: "acct_frontend" },
    ticket: { id: "ticket_1", stripeAccountId: "acct_frontend" },
    paymentRecord: directPaymentRecord({ stripeAccountId: "acct_original" }),
    refundAmountCents: 12000,
    isFullRefund: true,
  });

  assert.equal(stripeMock.refunds.createCalls[0].options.stripeAccount, "acct_original");
});

test("Destination Charge refund uses platform context with application fee and transfer reversal flags", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await controller._createStripeRefundFromPaymentRecord({
    order,
    ticket,
    paymentRecord: directPaymentRecord({
      paymentFlow: "DESTINATION_CHARGE",
      stripeAccountId: "acct_current_seller",
    }),
    refundAmountCents: 12000,
    isFullRefund: true,
  });

  const call = stripeMock.refunds.createCalls[0];
  assert.equal(call.params.refund_application_fee, true);
  assert.equal(call.params.reverse_transfer, true);
  assert.equal(call.options.stripeAccount, undefined);
  assert.equal(stripeMock.transfers.createReversalCalls.length, 0);
});

test("Separate Charge and Transfer refund uses platform refund and reverses stored transfer", async () => {
  const prisma = makePrisma({ transferRows: [{ id: "ce_1", stripe_transfer_id: "tr_1" }] });
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await controller._createStripeRefundFromPaymentRecord({
    order,
    ticket,
    paymentRecord: directPaymentRecord({
      paymentFlow: "SEPARATE_CHARGE_AND_TRANSFER",
      stripeAccountId: "acct_current_seller",
    }),
    refundAmountCents: 12000,
    isFullRefund: true,
  });

  const refundCall = stripeMock.refunds.createCalls[0];
  assert.equal(refundCall.options.stripeAccount, undefined);
  assert.equal(refundCall.params.refund_application_fee, undefined);
  assert.equal(refundCall.params.reverse_transfer, undefined);
  assert.equal(stripeMock.transfers.createReversalCalls.length, 1);
  assert.equal(stripeMock.transfers.createReversalCalls[0].transferId, "tr_1");
  assert.equal(
    stripeMock.transfers.createReversalCalls[0].options.idempotencyKey,
    "refund-reversal:opr_123:ticket_1:ce_1",
  );
  assert.equal(prisma._executeRawCalls.length, 1);
});

test("LEGACY_OR_UNKNOWN blocks automated refund safely", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord({ paymentFlow: "LEGACY_OR_UNKNOWN" }),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /manual refund review/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
  assert.equal(stripeMock.transfers.createReversalCalls.length, 0);
});

test("missing payment record blocks automated refund safely", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: null,
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /Missing payment record/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("missing stripeAccountId blocks Direct Charge refund", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord({ stripeAccountId: null }),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /missing stored Stripe account/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("missing stripePaymentIntentId blocks Direct Charge refund", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord({ stripePaymentIntentId: null }),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /missing stored PaymentIntent/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("missing PaymentIntent blocks Destination Charge refund", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord({
        paymentFlow: "DESTINATION_CHARGE",
        stripePaymentIntentId: null,
      }),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /Destination Charge refund blocked: missing stored PaymentIntent/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
});

test("missing transfer identifiers block Separate Charge and Transfer refund before Stripe", async () => {
  const prisma = makePrisma({ transferRows: [] });
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord({ paymentFlow: "SEPARATE_CHARGE_AND_TRANSFER" }),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /missing historical transfer identifiers/,
  );
  assert.equal(stripeMock.refunds.createCalls.length, 0);
  assert.equal(stripeMock.transfers.createReversalCalls.length, 0);
});

test("seller profile changes do not affect historical refund routing", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock();
  const controller = loadAdminController({ prisma, stripeMock });

  await controller._createStripeRefundFromPaymentRecord({
    order: { id: "order_1", sellerId: "seller_new", stripeAccountId: "acct_new" },
    ticket,
    paymentRecord: directPaymentRecord({
      paymentFlow: "DESTINATION_CHARGE",
      stripeAccountId: null,
    }),
    refundAmountCents: 12000,
    isFullRefund: true,
  });

  assert.equal(stripeMock.refunds.createCalls[0].options.stripeAccount, undefined);
});

test("refund failure leaves recoverable state", async () => {
  const prisma = makePrisma();
  const stripeMock = makeStripeMock({ failRefund: true });
  const controller = loadAdminController({ prisma, stripeMock });

  await assert.rejects(
    controller._createStripeRefundFromPaymentRecord({
      order,
      ticket,
      paymentRecord: directPaymentRecord(),
      refundAmountCents: 12000,
      isFullRefund: true,
    }),
    /stripe unavailable/,
  );
  assert.equal(prisma.orderPaymentRecord._lastUpdate, undefined);
});
