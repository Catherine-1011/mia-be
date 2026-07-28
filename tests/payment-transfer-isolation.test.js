const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const paymentControllerPath = path.resolve(__dirname, "../controllers/payment.js");
const stripeConnectControllerPath = path.resolve(__dirname, "../controllers/stripeConnect.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const cartControllerPath = path.resolve(__dirname, "../controllers/cart.js");
const ordersControllerPath = path.resolve(__dirname, "../controllers/orders.js");
const commissionControllerPath = path.resolve(__dirname, "../controllers/commission.js");
const notificationControllerPath = path.resolve(__dirname, "../controllers/notification.js");
const orderNotificationControllerPath = path.resolve(__dirname, "../controllers/orderNotification.js");
const emailServicePath = path.resolve(__dirname, "../utils/emailService.js");

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

function makeOrder({ isGuest = false } = {}) {
  return {
    id: "order_1",
    displayId: "ABC123",
    userId: isGuest ? null : "user_1",
    sellerId: "seller_1",
    totalAmount: 120,
    paymentStatus: "PENDING",
    paymentMethod: "Credit/Debit Card",
    stripePaymentIntentId: "pi_123",
    customerName: isGuest ? "Guest Buyer" : "Buyer",
    customerEmail: isGuest ? "guest@example.com" : "buyer@example.com",
    customerPhone: "0400000000",
    shippingAddressLine: "1 Test St",
    shippingCity: "Sydney",
    shippingState: "NSW",
    shippingZipCode: "2000",
    shippingCountry: "Australia",
    shippingAddress: {
      orderSummary: {
        shippingCost: "10.00",
        totalShippingCost: "10.00",
        gstPercentage: "10",
      },
    },
    items: [
      {
        id: "item_1",
        orderId: "order_1",
        productId: "prod_1",
        variantId: null,
        quantity: 1,
        price: 110,
        product: {
          id: "prod_1",
          title: "Artwork",
          price: 110,
          sellerId: "seller_1",
        },
        productVariant: null,
      },
    ],
    subOrders: [],
  };
}

function makePrisma({ chargeType = "direct", claimSequence = [1], isGuest = false, commissionsToReverse = [], failDisputeEmailOnce = false, failOutboxOnce = false } = {}) {
  const order = makeOrder({ isGuest });
  const webhookEvents = new Map();
  const prisma = {
    _claimSequence: [...claimSequence],
    _productUpdateCalls: [],
    _productVariantUpdateCalls: [],
    _orderUpdateCalls: [],
    _orderUpdateManyCalls: [],
    _cartDeleteManyCalls: [],
    _executeRawCalls: [],
    _orderPaymentRecordUpdateManyCalls: [],
    _orderPaymentRecordUpdateCalls: [],
    _commissionCreateCalls: [],
    _emailCalls: [],
    _orderNotificationCalls: [],
    _failOutboxOnce: failOutboxOnce,
    _outboxCreateManyCalls: [],
    _failDisputeEmailOnce: failDisputeEmailOnce,
    _webhookEvents: webhookEvents,
    order: {
      updateMany: async (args) => {
        prisma._orderUpdateManyCalls.push(args);
        return { count: prisma._claimSequence.shift() ?? 0 };
      },
      findFirst: async () => order,
      findUnique: async () => ({
        ...order,
        user: { name: order.customerName, email: order.customerEmail, phone: order.customerPhone, isDeleted: false },
      }),
      update: async (args) => {
        prisma._orderUpdateCalls.push(args);
        return {};
      },
    },
    cart: {
      findUnique: async () => (isGuest ? null : { id: "cart_1" }),
    },
    cartItem: {
      deleteMany: async (args) => {
        prisma._cartDeleteManyCalls.push(args);
        return {};
      },
    },
    product: {
      update: async (args) => {
        prisma._productUpdateCalls.push(args);
        return {};
      },
    },
    productVariant: {
      update: async (args) => {
        prisma._productVariantUpdateCalls.push(args);
        return {};
      },
    },
    coupon: {
      updateMany: async () => ({}),
    },
    user: {
      findUnique: async () => ({
        email: "seller@example.com",
        name: "Seller",
        sellerProfile: { storeName: "Store", businessName: "Business" },
      }),
      findMany: async () => [],
    },
    sellerProfile: {
      findUnique: async () => ({
        stripeAccountId: "acct_ready",
        stripePayoutsEnabled: true,
        user: { email: "seller@example.com", name: "Seller" },
      }),
    },
    commissionEarned: {
      updateMany: async () => ({}),
    },
    orderPaymentRecord: {
      findUnique: async ({ where }) => {
        if (where.stripePaymentIntentId !== "pi_123") return null;
        return {
        id: "opr_123",
        orderId: "order_1",
        sellerId: "seller_1",
        paymentFlow: chargeType === "direct" ? "DIRECT_CHARGE" : "SEPARATE_CHARGE_AND_TRANSFER",
        stripeAccountId: chargeType === "direct" ? "acct_ready" : null,
        stripePaymentIntentId: "pi_123",
        grossAmount: 12000,
        commissionBase: 10000,
        applicationFeeAmount: 1000,
        gstAmount: 1000,
        shippingAmount: 1000,
        paymentStatus: "PAID",
        disputeStatus: "NONE",
          order: {
            id: order.id,
            displayId: order.displayId,
            user: { email: order.customerEmail },
          },
          seller: { email: "seller@example.com", name: "Seller" },
        };
      },
      update: async (args) => {
        prisma._orderPaymentRecordUpdateCalls.push(args);
        return {};
      },
      updateMany: async (args) => {
        prisma._orderPaymentRecordUpdateManyCalls.push(args);
        return { count: 1 };
      },
    },
    stripeWebhookEvent: {
      create: async ({ data }) => {
        if (webhookEvents.has(data.eventId)) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { id: `swe_${webhookEvents.size + 1}`, attemptCount: 0, ...data };
        webhookEvents.set(data.eventId, row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = webhookEvents.get(where.eventId);
        const matchesSimpleStatus = () => {
          const statuses = where.status?.in || [];
          return statuses.includes(row.status);
        };
        const matchesOrStatus = () => {
          if (!Array.isArray(where.OR)) return false;
          return where.OR.some((clause) => {
            if (clause.status?.in?.includes(row.status)) return true;
            if (clause.status === row.status && clause.updatedAt?.lt) {
              return new Date(row.updatedAt || 0) < clause.updatedAt.lt;
            }
            return false;
          });
        };
        if (!row || (!matchesSimpleStatus() && !matchesOrStatus())) return { count: 0 };
        Object.assign(row, {
          ...data,
          attemptCount: data.attemptCount?.increment ? row.attemptCount + data.attemptCount.increment : row.attemptCount,
          updatedAt: new Date(),
        });
        return { count: 1 };
      },
      findUnique: async ({ where }) => webhookEvents.get(where.eventId) || null,
      update: async ({ where, data }) => {
        const row = webhookEvents.get(where.eventId);
        if (!row) throw new Error("webhook event not found");
        Object.assign(row, data);
        return row;
      },
    },
    paymentCompletionOutbox: {
      createMany: async (args) => {
        if (prisma._failOutboxOnce) {
          prisma._failOutboxOnce = false;
          throw new Error("outbox unavailable");
        }
        prisma._outboxCreateManyCalls.push(args);
        return { count: args.data.length };
      },
    },
    $executeRaw: async function() {
      prisma._executeRawCalls.push([...arguments]);
      return {};
    },
    $queryRaw: async () => commissionsToReverse,
    $transaction: async (callback) => {
      const snapshots = {
        product: [...prisma._productUpdateCalls],
        productVariant: [...prisma._productVariantUpdateCalls],
        order: [...prisma._orderUpdateCalls],
        cart: [...prisma._cartDeleteManyCalls],
        outbox: [...prisma._outboxCreateManyCalls],
      };
      try {
        return await callback(prisma);
      } catch (error) {
        prisma._productUpdateCalls = snapshots.product;
        prisma._productVariantUpdateCalls = snapshots.productVariant;
        prisma._orderUpdateCalls = snapshots.order;
        prisma._cartDeleteManyCalls = snapshots.cart;
        prisma._outboxCreateManyCalls = snapshots.outbox;
        throw error;
      }
    },
    _chargeType: chargeType,
  };
  return prisma;
}

function loadPaymentController({ prisma, chargeType = "direct", webhookEvent = null, invalidSignature = false }) {
  const stripeMock = {
    accounts: {
      retrieve: async () => ({ id: "acct_ready", charges_enabled: true, payouts_enabled: true }),
    },
    paymentIntents: {
      createCalls: [],
      updateCalls: [],
      retrieveCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        return {
          id: "pi_123",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: body.amount,
          livemode: false,
          client_secret: "pi_123_secret_abc",
          lastResponse: { requestId: "req_123" },
        };
      },
      update: async function(id, body, options) {
        this.updateCalls.push({ id, body, options });
        return { id };
      },
      retrieve: async function(id, options) {
        this.retrieveCalls.push({ id, options });
        return {
          id,
          status: "succeeded",
          latest_charge: "ch_123",
          metadata: { chargeType },
        };
      },
    },
    webhooks: {
      constructEvent: () => {
        if (invalidSignature) throw new Error("invalid signature");
        return webhookEvent || ({
        id: "evt_123",
        type: "payment_intent.succeeded",
        account: chargeType === "direct" ? "acct_ready" : null,
        livemode: false,
        data: { object: { id: "pi_123" } },
        });
      },
    },
    charges: {
      retrieveCalls: [],
      updateCalls: [],
      retrieve: async function(id, options) {
        this.retrieveCalls.push({ id, options });
        return {
          id,
          payment_intent: "pi_123",
          transfer: null,
          balance_transaction: { fee: 300 },
        };
      },
      update: async function(id, body, options) {
        this.updateCalls.push({ id, body, options });
        return { id };
      },
    },
    transfers: {
      createCalls: [],
      updateCalls: [],
      reversalCalls: [],
      retrieveCalls: [],
      create: async function(body) {
        this.createCalls.push({ body });
        return {
          id: "tr_123",
          amount: body.amount,
          livemode: false,
          source_transaction: body.source_transaction || null,
          lastResponse: { requestId: "req_transfer" },
        };
      },
      update: async function(id, body) {
        this.updateCalls.push({ id, body });
        return { id };
      },
      retrieve: async function(id) {
        this.retrieveCalls.push({ id });
        return { id, destination_payment: null };
      },
      createReversal: async function(id, body) {
        this.reversalCalls.push({ id, body });
        return { id: "trr_123" };
      },
    },
  };

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
    if (resolved === cartControllerPath) {
      return {
        calculateCartTotals: async () => ({
          subtotal: "110.00",
          subtotalExGST: "100.00",
          shippingCost: "10.00",
          totalShippingCost: "10.00",
          sellerCount: 1,
          gstPercentage: "10",
          gstAmount: "10.00",
          grandTotal: "120.00",
          gstDetails: [],
        }),
      };
    }
    if (resolved === ordersControllerPath) {
      return {
        generateInvoiceBuffer: async () => Buffer.from(""),
        calcSellerCouponDiscount: () => 0,
      };
    }
    if (resolved === commissionControllerPath) {
      return {
        createCommissionEarned: async function(params) {
          prisma._commissionCreateCalls.push(params);
          return "commission_1";
        },
        getCommissionForSeller: async () => null,
        getDefaultCommission: async () => ({ value: 10 }),
      };
    }
    if (resolved === notificationControllerPath) {
      return {
        notifyAdminNewOrder: async () => {},
        notifySellerNewOrder: async () => {},
      };
    }
    if (resolved === orderNotificationControllerPath) {
      return {
        createOrderNotification: async function() {
          prisma._orderNotificationCalls.push([...arguments]);
          return {};
        },
      };
    }
    if (resolved === emailServicePath) {
      return {
        sendOrderConfirmationEmail: async () => {
          prisma._emailCalls.push({ type: "orderConfirmation", args: [...arguments] });
        },
        sendFinanceOrderInvoiceEmail: async () => {
          prisma._emailCalls.push({ type: "financeInvoice", args: [...arguments] });
        },
        sendDisputeAlertEmail: async () => {
          if (prisma._failDisputeEmailOnce) {
            prisma._failDisputeEmailOnce = false;
            throw new Error("dispute email unavailable");
          }
          prisma._emailCalls.push({ type: "disputeAlert", args: [...arguments] });
        },
        sendSellerPaymentReceivedEmail: async () => {
          prisma._emailCalls.push({ type: "sellerPayout", args: [...arguments] });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[paymentControllerPath];
  const controller = require(paymentControllerPath);
  Module._load = originalLoad;
  return { controller, stripeMock };
}

async function callWebhook(controller) {
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

function loadStripeConnectController({ prisma, webhookEvent, invalidSignature = false }) {
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "whsec_test";
  const stripeMock = {
    webhooks: {
      constructEvent: () => {
        if (invalidSignature) throw new Error("invalid signature");
        return webhookEvent;
      },
    },
    charges: {
      retrieve: async () => ({
        id: "ch_123",
        payment_intent: "pi_123",
        billing_details: { email: "buyer@example.com" },
      }),
    },
    transfers: {
      reversalCalls: [],
      createReversal: async function(id, body) {
        this.reversalCalls.push({ id, body });
        return { id: "trr_123" };
      },
      create: async () => ({ id: "tr_123" }),
    },
    accounts: {
      retrieve: async () => ({ id: "acct_ready", charges_enabled: true, payouts_enabled: true }),
    },
    oauth: {
      token: async () => ({ stripe_user_id: "acct_ready" }),
    },
  };

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
    if (resolved === emailServicePath) {
      return {
        sendSellerStripeApprovedEmail: async () => {
          prisma._emailCalls.push({ type: "sellerStripeApproved", args: [...arguments] });
        },
        sendDisputeAlertEmail: async () => {
          prisma._emailCalls.push({ type: "disputeAlert", args: [...arguments] });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[stripeConnectControllerPath];
  const controller = require(stripeConnectControllerPath);
  Module._load = originalLoad;
  return { controller, stripeMock };
}

async function callConnectWebhook(controller) {
  const reply = makeReply();
  await controller.stripeConnectWebhook(
    {
      headers: { "stripe-signature": "sig" },
      rawBody: Buffer.from("{}"),
    },
    reply,
  );
  return reply;
}

async function callConfirm(controller, { isGuest = false } = {}) {
  const reply = makeReply();
  const fn = isGuest ? controller.confirmGuestPayment : controller.confirmPayment;
  await fn(
    {
      user: isGuest ? undefined : { userId: "user_1" },
      body: isGuest
        ? { paymentIntentId: "pi_123", customerEmail: "guest@example.com" }
        : { paymentIntentId: "pi_123" },
    },
    reply,
  );
  return reply;
}

test("frontend callback alone does not finalize logged-in Direct Charge", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callConfirm(controller);

  assert.equal(reply.statusCode, 202);
  assert.equal(reply.payload.status, "AWAITING_WEBHOOK_CONFIRMATION");
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._productUpdateCalls.length, 0);
  assert.equal(prisma._productVariantUpdateCalls.length, 0);
  assert.equal(prisma._commissionCreateCalls.length, 0);
  assert.equal(prisma._orderUpdateCalls.length, 0);
  assert.equal(prisma._outboxCreateManyCalls.length, 0);
});

test("frontend callback alone does not finalize guest Direct Charge", async () => {
  const prisma = makePrisma({ chargeType: "direct", isGuest: true });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callConfirm(controller, { isGuest: true });

  assert.equal(reply.statusCode, 202);
  assert.equal(reply.payload.status, "AWAITING_WEBHOOK_CONFIRMATION");
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._productUpdateCalls.length, 0);
  assert.equal(prisma._productVariantUpdateCalls.length, 0);
  assert.equal(prisma._commissionCreateCalls.length, 0);
  assert.equal(prisma._orderUpdateCalls.length, 0);
  assert.equal(prisma._outboxCreateManyCalls.length, 0);
});

test("Direct Charge payment-success webhook creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  const event = prisma._webhookEvents.get("evt_123");
  assert.equal(event.status, "PROCESSED");
  assert.equal(event.attemptCount, 1);
  assert.equal(event.stripeAccountId, "acct_ready");
  assert.equal(event.paymentIntentId, "pi_123");
  assert.equal(prisma._outboxCreateManyCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls[0].commissionAmountOverride, 10);
  assert.equal(prisma._commissionCreateCalls[0].netPayableOverride, 0);
  assert.equal(prisma._commissionCreateCalls[0].status, "PAID");
  assert.deepEqual(
    prisma._outboxCreateManyCalls[0].data.map((row) => row.type).sort(),
    [
      "ADMIN_NEW_ORDER_NOTIFICATION",
      "CUSTOMER_CONFIRMATION",
      "SELLER_NEW_ORDER_NOTIFICATION",
      "SELLER_PAYMENT_NOTIFICATION",
    ],
  );
});

test("frontend callback before webhook leaves finalization to verified webhook", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct" });

  const callback = await callConfirm(controller);
  const webhook = await callWebhook(controller);

  assert.equal(callback.statusCode, 202);
  assert.equal(callback.payload.awaitingWebhook, true);
  assert.equal(webhook.statusCode, 200);
  assert.equal(prisma._productUpdateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._outboxCreateManyCalls.length, 1);
});

test("webhook before frontend callback returns already confirmed without duplicate work", async () => {
  const prisma = makePrisma({ chargeType: "direct", claimSequence: [1, 0] });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct" });

  const webhook = await callWebhook(controller);
  prisma.order.findFirst = async () => ({ ...makeOrder(), paymentStatus: "PAID", status: "CONFIRMED" });
  const callback = await callConfirm(controller);

  assert.equal(webhook.statusCode, 200);
  assert.equal(callback.statusCode, 200);
  assert.equal(callback.payload.paymentStatus, "PAID");
  assert.equal(prisma._productUpdateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._outboxCreateManyCalls.length, 1);
});

test("Direct Charge retry creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "direct", claimSequence: [1, 1] });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const first = await callWebhook(controller);
  const retry = await callWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._productUpdateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._outboxCreateManyCalls.length, 1);
  assert.equal(prisma._webhookEvents.get("evt_123").attemptCount, 1);
  assert.equal(retry.payload.duplicate, true);
});

test("payment-completion outbox failure is stored FAILED and retry does not duplicate side effects", async () => {
  const prisma = makePrisma({ chargeType: "direct", claimSequence: [1, 1], failOutboxOnce: true });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const first = await callWebhook(controller);
  const retry = await callWebhook(controller);

  assert.equal(first.statusCode, 500);
  assert.equal(retry.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._webhookEvents.get("evt_123").attemptCount, 2);
  assert.equal(prisma._webhookEvents.get("evt_123").status, "PROCESSED");
  assert.equal(prisma._productUpdateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._outboxCreateManyCalls.length, 1);
});

test("active PROCESSING duplicate returns 200 without side effects", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  prisma._webhookEvents.set("evt_123", {
    id: "swe_1",
    eventId: "evt_123",
    eventType: "payment_intent.succeeded",
    status: "PROCESSING",
    attemptCount: 1,
    updatedAt: new Date(),
  });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.processing, true);
  assert.equal(prisma._productUpdateCalls.length, 0);
  assert.equal(prisma._commissionCreateCalls.length, 0);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("stale PROCESSING event can be reclaimed once", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  prisma._webhookEvents.set("evt_123", {
    id: "swe_1",
    eventId: "evt_123",
    eventType: "payment_intent.succeeded",
    status: "PROCESSING",
    attemptCount: 1,
    updatedAt: new Date(Date.now() - 20 * 60 * 1000),
  });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct" });

  const first = await callWebhook(controller);
  const duplicate = await callWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(prisma._productUpdateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._webhookEvents.get("evt_123").status, "PROCESSED");
  assert.equal(prisma._webhookEvents.get("evt_123").attemptCount, 2);
  assert.equal(duplicate.payload.duplicate, true);
});

test("failed dispute event is stored as FAILED and can be retried", async () => {
  const webhookEvent = {
    id: "evt_dispute",
    type: "charge.dispute.created",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent" } },
  };
  const prisma = makePrisma({ chargeType: "direct", failDisputeEmailOnce: true });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const first = await callWebhook(controller);
  const retry = await callWebhook(controller);

  assert.equal(first.statusCode, 500);
  assert.equal(retry.statusCode, 200);
  const event = prisma._webhookEvents.get("evt_dispute");
  assert.equal(event.status, "PROCESSED");
  assert.equal(event.attemptCount, 2);
  assert.equal(event.lastError, null);
  assert.ok(event.processedAt);
  assert.equal(prisma._emailCalls.filter((call) => call.type === "disputeAlert").length, 1);
  assert.equal(prisma._orderNotificationCalls.length, 1);
  assert.equal(prisma._orderNotificationCalls[0][2], "PAYMENT_DISPUTED");
  assert.equal(stripeMock.charges.retrieveCalls[0].options.stripeAccount, "acct_ready");
  assert.equal(prisma._orderPaymentRecordUpdateCalls.at(-1).data.stripeDisputeId, "dp_123");
  assert.equal(prisma._orderPaymentRecordUpdateCalls.at(-1).data.disputeStatus, "OPEN");
});

test("processing failure stores FAILED with lastError and no processedAt", async () => {
  const webhookEvent = {
    id: "evt_failure",
    type: "charge.dispute.created",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent" } },
  };
  const prisma = makePrisma({ chargeType: "direct", failDisputeEmailOnce: true });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const reply = await callWebhook(controller);

  const event = prisma._webhookEvents.get("evt_failure");
  assert.equal(reply.statusCode, 500);
  assert.equal(event.status, "FAILED");
  assert.match(event.lastError, /dispute email unavailable/);
  assert.equal(event.processedAt, null);
  assert.equal(event.attemptCount, 1);
});

test("two FAILED retries cannot both execute", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  prisma._webhookEvents.set("evt_123", {
    id: "swe_1",
    eventId: "evt_123",
    eventType: "payment_intent.succeeded",
    status: "FAILED",
    attemptCount: 1,
    lastError: "previous failure",
    updatedAt: new Date(),
  });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct" });

  const first = await callWebhook(controller);
  const duplicate = await callWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(prisma._productUpdateCalls.length, 1);
  assert.equal(prisma._commissionCreateCalls.length, 1);
  assert.equal(prisma._webhookEvents.get("evt_123").attemptCount, 2);
  assert.equal(duplicate.payload.duplicate, true);
});

test("invalid signature is rejected before webhook event insertion", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct", invalidSignature: true });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 400);
  assert.equal(prisma._webhookEvents.size, 0);
});

test("Direct Charge dispute.updated stores connected-account dispute details", async () => {
  const webhookEvent = {
    id: "evt_dispute_updated",
    type: "charge.dispute.updated",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent", status: "needs_response" } },
  };
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.charges.retrieveCalls[0].options.stripeAccount, "acct_ready");
  assert.equal(prisma._orderPaymentRecordUpdateCalls[0].data.stripeDisputeId, "dp_123");
  assert.equal(prisma._orderPaymentRecordUpdateCalls[0].data.disputeStatus, "OPEN");
  assert.equal(prisma._emailCalls.length, 0);
});

test("Direct Charge dispute.closed won restores paid state", async () => {
  const webhookEvent = {
    id: "evt_dispute_won",
    type: "charge.dispute.closed",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent", status: "won" } },
  };
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._orderPaymentRecordUpdateCalls[0].data.disputeStatus, "WON");
  assert.deepEqual(prisma._orderUpdateManyCalls[0].data, { status: "CONFIRMED", paymentStatus: "PAID" });
});

test("Direct Charge dispute.closed lost persists loss state", async () => {
  const webhookEvent = {
    id: "evt_dispute_lost",
    type: "charge.dispute.closed",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent", status: "lost" } },
  };
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._orderPaymentRecordUpdateCalls[0].data.disputeStatus, "LOST");
  assert.equal(prisma._orderPaymentRecordUpdateCalls[0].data.paymentStatus, "FAILED");
  assert.deepEqual(prisma._orderUpdateManyCalls[0].data, { status: "CANCELLED", paymentStatus: "REFUNDED" });
});

test("unknown connected account dispute is handled safely without side effects", async () => {
  const webhookEvent = {
    id: "evt_dispute_unknown_account",
    type: "charge.dispute.created",
    account: "acct_wrong",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent" } },
  };
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.charges.retrieveCalls[0].options.stripeAccount, "acct_wrong");
  assert.equal(prisma._orderPaymentRecordUpdateCalls.length, 0);
  assert.equal(prisma._emailCalls.length, 0);
});

test("duplicate refund webhook does not rerun historical transfer reversal", async () => {
  const webhookEvent = {
    id: "evt_refund",
    type: "charge.refunded",
    account: null,
    livemode: false,
    data: { object: { id: "ch_123", payment_intent: "pi_123", amount: 12000, amount_refunded: 6000 } },
  };
  const prisma = makePrisma({
    chargeType: "platform",
    commissionsToReverse: [{ id: "commission_1", stripe_transfer_id: "tr_123" }],
  });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "platform", webhookEvent });

  const first = await callWebhook(controller);
  const duplicate = await callWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(stripeMock.transfers.reversalCalls.length, 1);
  assert.equal(prisma._webhookEvents.get("evt_refund").paymentIntentId, "pi_123");
  assert.equal(prisma._orderPaymentRecordUpdateManyCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordUpdateManyCalls[0].data.refundStatus, "PARTIAL");
});

test("duplicate dispute webhook does not rerun dispute alert", async () => {
  const webhookEvent = {
    id: "evt_dispute_reversal",
    type: "charge.dispute.created",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent" } },
  };
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct", webhookEvent });

  const first = await callWebhook(controller);
  const duplicate = await callWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(stripeMock.transfers.reversalCalls.length, 0);
  assert.equal(prisma._emailCalls.filter((call) => call.type === "disputeAlert").length, 1);
  assert.equal(prisma._orderNotificationCalls.length, 1);
  assert.equal(prisma._webhookEvents.get("evt_dispute_reversal").stripeAccountId, "acct_ready");
});

test("platform dispute remains platform context and reverses historical transfer", async () => {
  const webhookEvent = {
    id: "evt_platform_dispute",
    type: "charge.dispute.created",
    account: null,
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent" } },
  };
  const prisma = makePrisma({
    chargeType: "platform",
    commissionsToReverse: [{ id: "commission_1", stripe_transfer_id: "tr_123" }],
  });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "platform", webhookEvent });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.charges.retrieveCalls[0].options, undefined);
  assert.equal(stripeMock.transfers.reversalCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordUpdateCalls[0].data.disputeStatus, "OPEN");
});

test("malformed metadata on connected-account Direct Charge webhook creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "not-direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "not-direct", webhookEvent: {
    id: "evt_123",
    type: "payment_intent.succeeded",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "pi_123" } },
  } });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.ok(stripeMock.paymentIntents.retrieveCalls.some((call) => call.options?.stripeAccount === "acct_ready"));
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("legacy platform transfer flow remains isolated and unchanged", async () => {
  const prisma = makePrisma({ chargeType: "platform" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "platform" });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 1);
  const transfer = stripeMock.transfers.createCalls[0].body;
  assert.equal(transfer.currency, "aud");
  assert.equal(transfer.destination, "acct_ready");
  assert.equal(transfer.source_transaction, "ch_123");
});

test("Connect duplicate dispute webhook does not rerun historical transfer reversal", async () => {
  const webhookEvent = {
    id: "evt_connect_dispute",
    type: "charge.dispute.created",
    account: "acct_ready",
    livemode: false,
    data: { object: { id: "dp_123", charge: "ch_123", amount: 12000, currency: "aud", reason: "fraudulent" } },
  };
  const prisma = makePrisma({
    chargeType: "platform",
    commissionsToReverse: [{ id: "commission_1", stripe_transfer_id: "tr_123" }],
  });
  const { controller, stripeMock } = loadStripeConnectController({ prisma, webhookEvent });

  const first = await callConnectWebhook(controller);
  const duplicate = await callConnectWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(stripeMock.transfers.reversalCalls.length, 1);
  assert.equal(prisma._emailCalls.filter((call) => call.type === "disputeAlert").length, 1);
  const event = prisma._webhookEvents.get("evt_connect_dispute");
  assert.equal(event.status, "PROCESSED");
  assert.equal(event.stripeAccountId, "acct_ready");
  assert.equal(event.attemptCount, 1);
});
