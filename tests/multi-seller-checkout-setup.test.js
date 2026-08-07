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

function sellerProduct(id, sellerId, stripeAccountId, overrides = {}) {
  return {
    id,
    title: id,
    price: 110,
    stock: 5,
    sellerId,
    ownerType: "SELLER",
    platformAccountId: null,
    _stripeAccountId: stripeAccountId,
    ...overrides,
  };
}

function platformProduct(id, platformAccountId = "platform_alpa", legacySellerId = "legacy_platform_creator") {
  return sellerProduct(id, legacySellerId, null, {
    ownerType: "PLATFORM",
    platformAccountId,
  });
}

function cartItem(product, overrides = {}) {
  return {
    productId: product.id,
    variantId: null,
    quantity: 1,
    product,
    productVariant: null,
    ...overrides,
  };
}

function makePrisma({
  cartItems = [],
  products = null,
  sellerProfiles = {},
  platformAccounts = {},
  operationStatus = null,
  operationStatuses = null,
  existingSession = null,
  invalidShipping = false,
} = {}) {
  const productMap = new Map((products || cartItems.map((item) => item.product)).map((product) => [product.id, product]));
  const prisma = {
    _sellerProfileLookups: [],
    _orderCreateCalls: [],
    _subOrderCreateCalls: [],
    _orderItemCreateManyCalls: [],
    _orderUpdateCalls: [],
    _sessionCreateCalls: [],
    _apiOperations: new Map(),
    user: {
      findUnique: async () => ({ id: "user_1", name: "Buyer", email: "buyer@example.com", phone: "0400000000", isDeleted: false }),
    },
    cart: {
      findUnique: async () => ({ id: "cart_1", items: cartItems }),
    },
    shippingMethod: {
      findUnique: async () => invalidShipping ? null : ({ id: "ship_1", name: "Standard", cost: 10, estimatedDays: "3-5 business days" }),
    },
    sellerProfile: {
      findUnique: async ({ where }) => {
        prisma._sellerProfileLookups.push(where.userId);
        return sellerProfiles[where.userId] || null;
      },
    },
    platformAccount: {
      findUnique: async ({ where }) => platformAccounts[where.id] || null,
    },
    product: {
      findUnique: async ({ where }) => productMap.get(where.id) || null,
    },
    productVariant: {
      findUnique: async ({ where }) => {
        for (const item of cartItems) {
          if (item.productVariant?.id === where.id) return item.productVariant;
        }
        return null;
      },
    },
    sellerCoupon: { findUnique: async () => null },
    coupon: { findUnique: async () => null },
    order: {
      findUnique: async ({ where }) => {
        if (where.displayId) return null;
        return {
          id: where.id,
          displayId: "ALPA-001",
          shippingAddress: { orderSummary: { multiSellerPlan: [{ sellerId: "seller_a" }] } },
          multiSellerCheckoutSession: existingSession || { platformSetupIntentId: "seti_existing", status: "COLLECTING_PAYMENT_METHOD", createdAt: new Date() },
        };
      },
      create: async ({ data }) => {
        prisma._orderCreateCalls.push({ data });
        return { id: `order_${prisma._orderCreateCalls.length}`, displayId: data.displayId, customerName: data.customerName, customerEmail: data.customerEmail };
      },
      update: async (args) => {
        prisma._orderUpdateCalls.push(args);
        return args;
      },
    },
    subOrder: {
      create: async (args) => {
        prisma._subOrderCreateCalls.push(args);
        return { id: `sub_${prisma._subOrderCreateCalls.length}` };
      },
    },
    orderItem: {
      createMany: async (args) => {
        prisma._orderItemCreateManyCalls.push(args);
        return { count: args.data.length };
      },
    },
    multiSellerCheckoutSession: {
      create: async (args) => {
        prisma._sessionCreateCalls.push(args);
        return { id: "session_1", ...args.data };
      },
    },
    apiIdempotencyOperation: {
      create: async ({ data }) => {
        const configuredStatus = operationStatuses?.[data.attemptNumber] || operationStatus;
        if (configuredStatus === "STARTED" || configuredStatus === "COMPLETED") {
          prisma._lastOperationCreate = data;
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { ...data, status: "STARTED", claimedNew: true };
        prisma._apiOperations.set(data.operationKey, row);
        return row;
      },
      findUnique: async ({ where }) => {
        const attemptNumber = Number(String(where.operationKey).split(":").at(-1));
        const configuredStatus = operationStatuses?.[attemptNumber] || operationStatus;
        if (configuredStatus) {
          return {
            operationKey: where.operationKey,
            operationType: "MULTI_SELLER_SETUP_CREATE",
            requestHash: prisma._lastOperationCreate?.requestHash,
            status: configuredStatus,
            orderId: configuredStatus === "COMPLETED" ? "order_existing" : null,
          };
        }
        return null;
      },
      update: async ({ where, data }) => {
        const row = prisma._apiOperations.get(where.operationKey) || {};
        Object.assign(row, data);
        return row;
      },
    },
    orderPaymentRecord: {
      create: async (args) => args,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (callback) => callback(prisma),
  };
  return prisma;
}

function makeStripe({ setupIntentStatus = "requires_payment_method" } = {}) {
  return {
    accounts: {
      retrieveCalls: [],
      retrieve: async function(accountId) {
        this.retrieveCalls.push(accountId);
        return { id: accountId, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active", transfers: "active" }, requirements: {} };
      },
    },
    customers: {
      createCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        return { id: `cus_${this.createCalls.length}` };
      },
    },
    setupIntents: {
      createCalls: [],
      retrieveCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        return { id: `seti_${this.createCalls.length}`, client_secret: `seti_${this.createCalls.length}_secret`, status: "requires_payment_method" };
      },
      retrieve: async function(id) {
        this.retrieveCalls.push(id);
        return { id, client_secret: `${id}_secret`, status: setupIntentStatus };
      },
    },
    paymentIntents: {
      createCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        return { id: "pi_unexpected" };
      },
    },
    transfers: {
      createCalls: [],
      create: async function() {
        this.createCalls.push([...arguments]);
        throw new Error("transfers.create should not be called");
      },
    },
    webhooks: { constructEvent: () => ({}) },
    charges: { retrieve: async () => ({}), update: async () => ({}) },
  };
}

function loadController({ prisma, stripe }) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = (() => {
      try { return Module._resolveFilename(request, parent); } catch (_) { return request; }
    })();

    if (request === "stripe") return function Stripe() { return stripe; };
    if (resolved === prismaPath) return prisma;
    if (resolved === cartControllerPath) {
      return {
        calculateCartTotals: async (_items, _shippingMethodId, _gstId, intlCost) => ({
          subtotal: "220.00",
          subtotalExGST: "200.00",
          shippingCost: String(intlCost || "10.00"),
          totalShippingCost: "20.00",
          sellerCount: 2,
          gstPercentage: "10",
          gstAmount: "20.00",
          grandTotal: "240.00",
          gstDetails: [],
        }),
      };
    }
    if (resolved === ordersControllerPath) return { generateInvoiceBuffer: async () => Buffer.from(""), calcSellerCouponDiscount: () => 0 };
    if (resolved === commissionControllerPath) return { createCommissionEarned: async () => "commission_1", getCommissionForSeller: async () => null, getDefaultCommission: async () => ({ value: 10 }) };
    if (resolved === notificationControllerPath) return { notifyAdminNewOrder: async () => {}, notifySellerNewOrder: async () => {} };
    if (resolved === orderNotificationControllerPath) return { createOrderNotification: async () => {} };
    if (resolved === emailServicePath) return { sendOrderConfirmationEmail: async () => {}, sendFinanceOrderInvoiceEmail: async () => {}, sendDisputeAlertEmail: async () => {}, sendSellerPaymentReceivedEmail: async () => {} };
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[paymentControllerPath];
  const controller = require(paymentControllerPath);
  Module._load = originalLoad;
  return controller;
}

async function callRegistered(controller, body = {}) {
  const reply = makeReply();
  await controller.createMultiSellerCheckoutSetup({
    id: "req_1",
    user: { userId: "user_1" },
    body: { shippingAddress: { addressLine: "1 Test St" }, shippingMethodId: "ship_1", country: "Australia", city: "Darwin", state: "NT", zipCode: "0800", mobileNumber: "0400000000", ...body },
  }, reply);
  return reply;
}

async function callGuest(controller, items, body = {}) {
  const reply = makeReply();
  await controller.createGuestMultiSellerCheckoutSetup({
    body: {
      items,
      customerName: "Guest",
      customerEmail: "guest@example.com",
      customerPhone: "0400000000",
      shippingAddress: { addressLine: "1 Test St" },
      shippingMethodId: "ship_1",
      country: "Australia",
      city: "Darwin",
      state: "NT",
      zipCode: "0800",
      mobileNumber: "0400000000",
      ...body,
    },
  }, reply);
  return reply;
}

function readyProfiles() {
  return {
    seller_a: { stripeAccountId: "acct_seller_a", stripeChargesEnabled: true, stripePayoutsEnabled: true },
    seller_b: { stripeAccountId: "acct_seller_b", stripeChargesEnabled: true, stripePayoutsEnabled: true },
    platform_operator: { userId: "platform_operator", paymentAccountType: "PLATFORM" },
  };
}

function readyPlatformAccounts() {
  return {
    platform_alpa: { id: "platform_alpa", userId: "platform_operator", active: true, paymentType: "PLATFORM" },
  };
}

test("registered setup keeps owner group keys separate from canonical seller IDs", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const prisma = makePrisma({ cartItems: [cartItem(a), cartItem(b)], sellerProfiles: readyProfiles() });
  const stripe = makeStripe();
  const controller = loadController({ prisma, stripe });

  const reply = await callRegistered(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._subOrderCreateCalls.length, 2);
  assert.deepEqual(prisma._subOrderCreateCalls.map((c) => c.data.sellerId).sort(), ["seller_a", "seller_b"]);
  assert.deepEqual(Array.from(new Set(prisma._sellerProfileLookups)).sort(), ["seller_a", "seller_b"]);
  assert.equal(prisma._sellerProfileLookups.includes("SELLER:seller_a"), false);
  assert.equal(prisma._subOrderCreateCalls.some((c) => String(c.data.sellerId).startsWith("SELLER:")), false);
  assert.deepEqual(stripe.accounts.retrieveCalls.sort(), ["acct_seller_a", "acct_seller_b"]);
  assert.equal(stripe.setupIntents.createCalls.length, 1);
  assert.equal(stripe.paymentIntents.createCalls.length, 0);
  assert.equal(stripe.transfers.createCalls.length, 0);
});

test("platform groups skip seller readiness and connected account routing", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const alpa = platformProduct("prod_alpa", "platform_alpa", "legacy_platform_creator");
  const prisma = makePrisma({
    cartItems: [cartItem(a), cartItem(alpa)],
    sellerProfiles: readyProfiles(),
    platformAccounts: readyPlatformAccounts(),
  });
  const stripe = makeStripe();
  const controller = loadController({ prisma, stripe });

  const reply = await callRegistered(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._subOrderCreateCalls.length, 2);
  assert.deepEqual(Array.from(new Set(prisma._sellerProfileLookups)), ["seller_a", "platform_operator"]);
  assert.deepEqual(stripe.accounts.retrieveCalls, ["acct_seller_a"]);
  const breakdown = prisma._orderUpdateCalls.at(-1).data.shippingAddress.orderSummary.multiSellerPlan;
  const platformLine = breakdown.find((line) => line.paymentAccountType === "PLATFORM");
  assert.equal(platformLine.sellerId, "platform_operator");
  assert.notEqual(platformLine.sellerId, "legacy_platform_creator");
  const platformSubOrder = prisma._subOrderCreateCalls.find((call) => call.data.sellerId === "platform_operator");
  assert.ok(platformSubOrder);
  assert.equal(platformLine.stripeAccountId, null);
  assert.equal(platformLine.commission.applicationFeeAmount, 0);
  assert.equal(stripe.paymentIntents.createCalls.length, 0);
  assert.equal(stripe.transfers.createCalls.length, 0);
});

test("three commercial owners create three groups with external sellers remaining ready", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const alpa = platformProduct("prod_alpa", "platform_alpa", "legacy_platform_creator");
  const prisma = makePrisma({
    cartItems: [cartItem(a), cartItem(b), cartItem(alpa)],
    sellerProfiles: readyProfiles(),
    platformAccounts: readyPlatformAccounts(),
  });
  const stripe = makeStripe();
  const controller = loadController({ prisma, stripe });

  const reply = await callRegistered(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._subOrderCreateCalls.length, 3);
  assert.deepEqual(Array.from(new Set(prisma._sellerProfileLookups)).sort(), ["platform_operator", "seller_a", "seller_b"]);
  assert.deepEqual(stripe.accounts.retrieveCalls.sort(), ["acct_seller_a", "acct_seller_b"]);
});

test("unready external seller fails before order or Stripe object creation while platform groups do not fail readiness", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const alpa = platformProduct("prod_alpa", "platform_alpa", "legacy_platform_creator");
  const prisma = makePrisma({
    cartItems: [cartItem(a), cartItem(b), cartItem(alpa)],
    sellerProfiles: {
      seller_a: readyProfiles().seller_a,
      seller_b: { stripeAccountId: null, stripeChargesEnabled: false, stripePayoutsEnabled: false },
      platform_operator: readyProfiles().platform_operator,
    },
    platformAccounts: readyPlatformAccounts(),
  });
  const stripe = makeStripe();
  const controller = loadController({ prisma, stripe });

  const reply = await callRegistered(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "STRIPE_NOT_CONNECTED");
  assert.deepEqual(Array.from(new Set(prisma._sellerProfileLookups)), ["seller_a", "seller_b"]);
  assert.equal(prisma._orderCreateCalls.length, 0);
  assert.equal(prisma._subOrderCreateCalls.length, 0);
  assert.equal(stripe.setupIntents.createCalls.length, 0);
  assert.equal(stripe.paymentIntents.createCalls.length, 0);
});

test("idempotency returns 202 for started operations and completed setup for completed operations", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const startedPrisma = makePrisma({ cartItems: [cartItem(a), cartItem(b)], sellerProfiles: readyProfiles(), operationStatus: "STARTED" });
  const startedStripe = makeStripe();
  const startedController = loadController({ prisma: startedPrisma, stripe: startedStripe });

  const startedReply = await callRegistered(startedController);
  assert.equal(startedReply.statusCode, 202);
  assert.deepEqual(startedReply.payload, { success: true, status: "PAYMENT_CREATION_IN_PROGRESS", idempotent: true });
  assert.equal(startedPrisma._orderCreateCalls.length, 0);
  assert.equal(startedStripe.setupIntents.createCalls.length, 0);

  const completedPrisma = makePrisma({ cartItems: [cartItem(a), cartItem(b)], sellerProfiles: readyProfiles(), operationStatus: "COMPLETED" });
  const completedStripe = makeStripe();
  const completedController = loadController({ prisma: completedPrisma, stripe: completedStripe });
  const completedReply = await callRegistered(completedController);
  assert.equal(completedReply.statusCode, 200);
  assert.equal(completedReply.payload.orderId, "order_existing");
  assert.equal(completedReply.payload.displayId, "ALPA-001");
  assert.equal(completedReply.payload.clientSecret, "seti_existing_secret");
  assert.equal(completedReply.payload.idempotent, true);
  assert.equal(completedPrisma._orderCreateCalls.length, 0);
  assert.equal(completedStripe.setupIntents.createCalls.length, 0);
});

test("completed registered setup reuses only collectable current SetupIntents", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const prisma = makePrisma({
    cartItems: [cartItem(a), cartItem(b)],
    sellerProfiles: readyProfiles(),
    operationStatus: "COMPLETED",
    existingSession: {
      platformSetupIntentId: "seti_existing",
      status: "COLLECTING_PAYMENT_METHOD",
      createdAt: new Date(),
    },
  });
  const stripe = makeStripe({ setupIntentStatus: "requires_confirmation" });
  const controller = loadController({ prisma, stripe });

  const reply = await callRegistered(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.clientSecret, "seti_existing_secret");
  assert.equal(reply.payload.idempotent, true);
  assert.equal(prisma._orderCreateCalls.length, 0);
  assert.equal(stripe.setupIntents.createCalls.length, 0);
});

test("completed registered setup creates a fresh attempt instead of returning canceled or succeeded SetupIntents", async () => {
  for (const terminalStatus of ["canceled", "succeeded"]) {
    const a = sellerProduct(`prod_a_${terminalStatus}`, "seller_a", "acct_seller_a");
    const b = sellerProduct(`prod_b_${terminalStatus}`, "seller_b", "acct_seller_b");
    const prisma = makePrisma({
      cartItems: [cartItem(a), cartItem(b)],
      sellerProfiles: readyProfiles(),
      operationStatuses: { 1: "COMPLETED" },
      existingSession: {
        platformSetupIntentId: "seti_existing",
        status: "COLLECTING_PAYMENT_METHOD",
        createdAt: new Date(),
      },
    });
    const stripe = makeStripe({ setupIntentStatus: terminalStatus });
    const controller = loadController({ prisma, stripe });

    const reply = await callRegistered(controller);

    assert.equal(reply.statusCode, 200);
    assert.equal(reply.payload.clientSecret, "seti_1_secret");
    assert.equal(reply.payload.idempotent, undefined);
    assert.equal(prisma._orderCreateCalls.length, 1);
    assert.equal(stripe.setupIntents.createCalls.length, 1);
    assert.deepEqual(stripe.setupIntents.retrieveCalls, ["seti_existing"]);
  }
});

test("completed registered setup creates a fresh attempt when checkout session is stale or progressed", async () => {
  const staleDate = new Date(Date.now() - 31 * 60 * 1000);
  for (const session of [
    { platformSetupIntentId: "seti_existing", status: "COLLECTING_PAYMENT_METHOD", createdAt: staleDate },
    { platformSetupIntentId: "seti_existing", status: "COMPLETED", createdAt: new Date() },
  ]) {
    const a = sellerProduct(`prod_a_${session.status}_${session.createdAt.getTime()}`, "seller_a", "acct_seller_a");
    const b = sellerProduct(`prod_b_${session.status}_${session.createdAt.getTime()}`, "seller_b", "acct_seller_b");
    const prisma = makePrisma({
      cartItems: [cartItem(a), cartItem(b)],
      sellerProfiles: readyProfiles(),
      operationStatuses: { 1: "COMPLETED" },
      existingSession: session,
    });
    const stripe = makeStripe({ setupIntentStatus: "requires_payment_method" });
    const controller = loadController({ prisma, stripe });

    const reply = await callRegistered(controller);

    assert.equal(reply.statusCode, 200);
    assert.equal(reply.payload.clientSecret, "seti_1_secret");
    assert.equal(prisma._orderCreateCalls.length, 1);
    assert.equal(stripe.setupIntents.createCalls.length, 1);
  }
});

test("guest setup succeeds for seller plus seller and seller plus platform with canonical seller IDs", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const alpa = platformProduct("prod_alpa", "platform_alpa", "seller_a");
  const products = [a, b, alpa];

  const sellerPrisma = makePrisma({ products, sellerProfiles: readyProfiles() });
  const sellerStripe = makeStripe();
  const sellerController = loadController({ prisma: sellerPrisma, stripe: sellerStripe });
  const sellerReply = await callGuest(sellerController, [{ productId: "prod_a", quantity: 1 }, { productId: "prod_b", quantity: 1 }]);
  assert.equal(sellerReply.statusCode, 200);
  assert.deepEqual(sellerPrisma._subOrderCreateCalls.map((c) => c.data.sellerId).sort(), ["seller_a", "seller_b"]);

  const platformPrisma = makePrisma({ products, sellerProfiles: readyProfiles(), platformAccounts: readyPlatformAccounts() });
  const platformStripe = makeStripe();
  const platformController = loadController({ prisma: platformPrisma, stripe: platformStripe });
  const platformReply = await callGuest(platformController, [{ productId: "prod_a", quantity: 1 }, { productId: "prod_alpa", quantity: 1 }]);
  assert.equal(platformReply.statusCode, 200);
  assert.deepEqual(Array.from(new Set(platformPrisma._sellerProfileLookups)), ["seller_a", "platform_operator"]);
  assert.deepEqual(platformPrisma._subOrderCreateCalls.map((c) => c.data.sellerId).sort(), ["platform_operator", "seller_a"]);
  assert.equal(platformPrisma._subOrderCreateCalls.some((c) => String(c.data.sellerId).startsWith("PLATFORM:")), false);
});

test("platform groups fail clearly when the operational SellerProfile is not configured", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const alpa = platformProduct("prod_alpa", "platform_alpa", "legacy_platform_creator");
  const sellerProfiles = { seller_a: readyProfiles().seller_a };

  const registeredPrisma = makePrisma({
    cartItems: [cartItem(a), cartItem(alpa)],
    sellerProfiles,
    platformAccounts: readyPlatformAccounts(),
  });
  const registeredStripe = makeStripe();
  const registeredController = loadController({ prisma: registeredPrisma, stripe: registeredStripe });
  const registeredReply = await callRegistered(registeredController);

  assert.equal(registeredReply.statusCode, 400);
  assert.equal(registeredReply.payload.code, "PLATFORM_SELLER_PROFILE_NOT_CONFIGURED");
  assert.equal(registeredPrisma._orderCreateCalls.length, 0);
  assert.equal(registeredStripe.customers.createCalls.length, 0);
  assert.equal(registeredStripe.setupIntents.createCalls.length, 0);
  assert.equal(registeredPrisma._subOrderCreateCalls.some((c) => c.data.sellerId === "legacy_platform_creator"), false);

  const guestPrisma = makePrisma({
    products: [a, alpa],
    sellerProfiles,
    platformAccounts: readyPlatformAccounts(),
  });
  const guestStripe = makeStripe();
  const guestController = loadController({ prisma: guestPrisma, stripe: guestStripe });
  const guestReply = await callGuest(guestController, [{ productId: "prod_a", quantity: 1 }, { productId: "prod_alpa", quantity: 1 }]);

  assert.equal(guestReply.statusCode, 400);
  assert.equal(guestReply.payload.code, "PLATFORM_SELLER_PROFILE_NOT_CONFIGURED");
  assert.equal(guestPrisma._orderCreateCalls.length, 0);
  assert.equal(guestStripe.customers.createCalls.length, 0);
  assert.equal(guestStripe.setupIntents.createCalls.length, 0);
});

test("platform products missing platformAccountId are rejected before Stripe setup", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const malformedAlpa = platformProduct("prod_alpa", null, "seller_a");

  const registeredPrisma = makePrisma({ cartItems: [cartItem(a), cartItem(malformedAlpa)], sellerProfiles: readyProfiles() });
  const registeredStripe = makeStripe();
  const registeredController = loadController({ prisma: registeredPrisma, stripe: registeredStripe });
  const registeredReply = await callRegistered(registeredController);

  assert.equal(registeredReply.statusCode, 400);
  assert.equal(registeredReply.payload.code, "INVALID_PRODUCT_OWNERSHIP");
  assert.equal(registeredPrisma._orderCreateCalls.length, 0);
  assert.equal(registeredStripe.setupIntents.createCalls.length, 0);

  const guestPrisma = makePrisma({ products: [a, malformedAlpa], sellerProfiles: readyProfiles() });
  const guestStripe = makeStripe();
  const guestController = loadController({ prisma: guestPrisma, stripe: guestStripe });
  const guestReply = await callGuest(guestController, [{ productId: "prod_a", quantity: 1 }, { productId: "prod_alpa", quantity: 1 }]);

  assert.equal(guestReply.statusCode, 400);
  assert.equal(guestReply.payload.code, "INVALID_PRODUCT_OWNERSHIP");
  assert.equal(guestPrisma._orderCreateCalls.length, 0);
  assert.equal(guestStripe.setupIntents.createCalls.length, 0);
});

test("guest readiness failure occurs before database or Stripe object creation", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");
  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  const prisma = makePrisma({
    products: [a, b],
    sellerProfiles: {
      seller_a: readyProfiles().seller_a,
      seller_b: { stripeAccountId: null, stripeChargesEnabled: false, stripePayoutsEnabled: false },
    },
  });
  const stripe = makeStripe();
  const controller = loadController({ prisma, stripe });
  const reply = await callGuest(controller, [{ productId: "prod_a", quantity: 1 }, { productId: "prod_b", quantity: 1 }]);
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "STRIPE_NOT_CONNECTED");
  assert.equal(prisma._orderCreateCalls.length, 0);
  assert.equal(stripe.setupIntents.createCalls.length, 0);
  assert.equal(stripe.paymentIntents.createCalls.length, 0);
});

test("guardrails reject single owner, missing shipping, invalid shipping, product stock, and variant stock", async () => {
  const a = sellerProduct("prod_a", "seller_a", "acct_seller_a");

  let prisma = makePrisma({ cartItems: [cartItem(a)], sellerProfiles: readyProfiles() });
  let stripe = makeStripe();
  let controller = loadController({ prisma, stripe });
  let reply = await callRegistered(controller);
  assert.equal(reply.statusCode, 400);
  assert.match(reply.payload.message, /create-intent/);

  prisma = makePrisma({ cartItems: [cartItem(a)], sellerProfiles: readyProfiles() });
  stripe = makeStripe();
  controller = loadController({ prisma, stripe });
  reply = await callRegistered(controller, { shippingAddress: null });
  assert.equal(reply.statusCode, 400);

  const b = sellerProduct("prod_b", "seller_b", "acct_seller_b");
  prisma = makePrisma({ cartItems: [cartItem(a), cartItem(b)], sellerProfiles: readyProfiles(), invalidShipping: true });
  stripe = makeStripe();
  controller = loadController({ prisma, stripe });
  reply = await callRegistered(controller);
  assert.equal(reply.statusCode, 400);
  assert.match(reply.payload.message, /Invalid or inactive shipping method/);

  const outOfStock = sellerProduct("prod_oos", "seller_b", "acct_seller_b", { stock: 0 });
  prisma = makePrisma({ cartItems: [cartItem(a), cartItem(outOfStock)], sellerProfiles: readyProfiles() });
  stripe = makeStripe();
  controller = loadController({ prisma, stripe });
  reply = await callRegistered(controller);
  assert.equal(reply.statusCode, 400);
  assert.match(reply.payload.message, /Insufficient stock/);

  const variantProduct = sellerProduct("prod_variant", "seller_b", "acct_seller_b", { stock: 99 });
  const variant = { id: "var_1", stock: 0, price: 110 };
  prisma = makePrisma({ cartItems: [cartItem(a), cartItem(variantProduct, { variantId: "var_1", productVariant: variant })], sellerProfiles: readyProfiles() });
  stripe = makeStripe();
  controller = loadController({ prisma, stripe });
  reply = await callRegistered(controller);
  assert.equal(reply.statusCode, 400);
  assert.match(reply.payload.message, /Insufficient stock/);
});
