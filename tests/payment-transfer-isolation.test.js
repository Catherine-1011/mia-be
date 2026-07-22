const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const paymentControllerPath = path.resolve(__dirname, "../controllers/payment.js");
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

function makePrisma({ chargeType = "direct", claimSequence = [1], isGuest = false } = {}) {
  const order = makeOrder({ isGuest });
  const prisma = {
    _claimSequence: [...claimSequence],
    _productUpdateCalls: [],
    _productVariantUpdateCalls: [],
    _orderUpdateCalls: [],
    _cartDeleteManyCalls: [],
    _executeRawCalls: [],
    order: {
      updateMany: async () => ({ count: prisma._claimSequence.shift() ?? 0 }),
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
    $executeRaw: async function() {
      prisma._executeRawCalls.push([...arguments]);
      return {};
    },
    $queryRaw: async () => [],
    $transaction: async (callback) => callback(prisma),
    _chargeType: chargeType,
  };
  return prisma;
}

function loadPaymentController({ prisma, chargeType = "direct", webhookEvent = null }) {
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
      constructEvent: () => webhookEvent || ({
        id: "evt_123",
        type: "payment_intent.succeeded",
        account: chargeType === "direct" ? "acct_ready" : null,
        livemode: false,
        data: { object: { id: "pi_123" } },
      }),
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
        createCommissionEarned: async () => "commission_1",
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
      return { createOrderNotification: async () => {} };
    }
    if (resolved === emailServicePath) {
      return {
        sendOrderConfirmationEmail: async () => {},
        sendFinanceOrderInvoiceEmail: async () => {},
        sendDisputeAlertEmail: async () => {},
        sendSellerPayoutTransferEmail: async () => {},
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

test("new logged-in Direct Charge success creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callConfirm(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("new guest Direct Charge success creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "direct", isGuest: true });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callConfirm(controller, { isGuest: true });

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("Direct Charge payment-success webhook creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "direct" });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const reply = await callWebhook(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("Direct Charge retry creates no transfer", async () => {
  const prisma = makePrisma({ chargeType: "direct", claimSequence: [1, 0] });
  const { controller, stripeMock } = loadPaymentController({ prisma, chargeType: "direct" });

  const first = await callWebhook(controller);
  const retry = await callWebhook(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
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
