const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");
const fs = require("node:fs");

const paymentControllerPath = path.resolve(__dirname, "../controllers/payment.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const cartControllerPath = path.resolve(__dirname, "../controllers/cart.js");
const ordersControllerPath = path.resolve(__dirname, "../controllers/orders.js");
const commissionControllerPath = path.resolve(__dirname, "../controllers/commission.js");
const notificationControllerPath = path.resolve(__dirname, "../controllers/notification.js");
const orderNotificationControllerPath = path.resolve(__dirname, "../controllers/orderNotification.js");
const emailServicePath = path.resolve(__dirname, "../utils/emailService.js");
const phase4MigrationPath = path.resolve(__dirname, "../prisma/migrations/20260722000001_add_order_payment_records/migration.sql");

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

function makeCartWithSellerCount(sellerCount = 1, productPrice = 110) {
  return {
    id: "cart_1",
    items: Array.from({ length: sellerCount }, (_, index) => ({
      quantity: 1,
      variantId: null,
      productVariant: null,
      product: {
        id: `prod_${index + 1}`,
        title: `Artwork ${index + 1}`,
        price: productPrice,
        stock: 5,
        sellerId: `seller_${index + 1}`,
      },
    })),
  };
}

function makePrisma({ sellerProfile, sellerLookupError = null, sellerCount = 1, productPrice = 110, missingProductIds = [], paymentRecordCreateError = null, coupon = null } = {}) {
  const prisma = {
    _orderCreateCalls: [],
    _orderPaymentRecordCreateCalls: [],
    _apiOperations: new Map(),
    _subOrderCreateCalls: [],
    _orderItemCreateManyCalls: [],
    _productUpdateCalls: [],
    _productVariantUpdateCalls: [],
    user: {
      findUnique: async () => ({
        id: "user_1",
        name: "Buyer",
        email: "buyer@example.com",
        phone: "0400000000",
        isDeleted: false,
      }),
    },
    cart: {
      findUnique: async () => makeCartWithSellerCount(sellerCount, productPrice),
    },
    shippingMethod: {
      findUnique: async () => ({
        id: "ship_1",
        name: "Standard",
        cost: 10,
        estimatedDays: "3-5 business days",
      }),
    },
    sellerProfile: {
      findUnique: async () => {
        if (sellerLookupError) throw sellerLookupError;
        return sellerProfile;
      },
    },
    product: {
      findUnique: async ({ where }) => {
        if (missingProductIds.includes(where.id)) return null;
        return {
          id: where.id,
          title: "Artwork",
          price: productPrice,
          stock: 5,
          sellerId: where.id.replace("prod", "seller"),
        };
      },
      update: async (args) => {
        prisma._productUpdateCalls.push(args);
        return {};
      },
    },
    productVariant: {
      findUnique: async () => null,
      update: async (args) => {
        prisma._productVariantUpdateCalls.push(args);
        return {};
      },
    },
    sellerCoupon: {
      findUnique: async () => null,
    },
    coupon: {
      findUnique: async () => coupon,
    },
    order: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }) => {
        prisma._orderCreateCalls.push({ data });
        return {
          id: "order_1",
          displayId: data.displayId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
        };
      },
      update: async (args) => args,
      updateMany: async () => ({ count: 1 }),
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
        return { count: args.data?.length || 0 };
      },
    },
    orderPaymentRecord: {
      create: async (args) => {
        if (paymentRecordCreateError) throw paymentRecordCreateError;
        prisma._orderPaymentRecordCreateCalls.push(args);
        return { id: `payment_record_${prisma._orderPaymentRecordCreateCalls.length}`, ...args.data };
      },
      findMany: async ({ where }) => prisma._orderPaymentRecordCreateCalls
        .map((call, index) => ({ id: `payment_record_${index + 1}`, ...call.data }))
        .filter((record) => !where?.orderId || record.orderId === where.orderId),
      findUnique: async ({ where }) => prisma._orderPaymentRecordCreateCalls
        .map((call, index) => ({ id: `payment_record_${index + 1}`, ...call.data }))
        .find((record) => record.stripePaymentIntentId === where.stripePaymentIntentId) || null,
      update: async (args) => args,
      updateMany: async () => ({ count: 1 }),
    },
    apiIdempotencyOperation: {
      create: async ({ data }) => {
        if (prisma._apiOperations.has(data.operationKey)) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { id: `aio_${prisma._apiOperations.size + 1}`, ...data };
        prisma._apiOperations.set(data.operationKey, row);
        return row;
      },
      findUnique: async ({ where }) => prisma._apiOperations.get(where.operationKey) || null,
      update: async ({ where, data }) => {
        const row = prisma._apiOperations.get(where.operationKey);
        if (!row) throw new Error("operation not found");
        Object.assign(row, data);
        return row;
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  return prisma;
}

function loadPaymentController({ prisma, stripeAccount, cartTotals = null }) {
  const stripeMock = {
    accounts: {
      retrieve: async () => {
        if (stripeAccount instanceof Error) throw stripeAccount;
        return stripeAccount;
      },
    },
    paymentIntents: {
      createCalls: [],
      updateCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        const n = this.createCalls.length;
        return {
          id: n === 1 ? "pi_123" : `pi_${n}`,
          object: "payment_intent",
          status: "requires_payment_method",
          amount: body.amount,
          livemode: false,
          client_secret: n === 1 ? "pi_123_secret_abc" : `pi_${n}_secret_abc`,
          lastResponse: { requestId: `req_${n}` },
        };
      },
      update: async function(id, body, options) {
        this.updateCalls.push({ id, body, options });
        return { id };
      },
      retrieve: async () => ({ id: "pi_123", status: "succeeded" }),
    },
    webhooks: {
      constructEvent: () => ({}),
    },
    charges: {
      retrieve: async () => ({}),
      update: async () => ({}),
    },
    transfers: {
      createCalls: [],
      create: async function() {
        this.createCalls.push([...arguments]);
        throw new Error("transfers.create should not be called in Phase 1 tests");
      },
      retrieve: async () => ({}),
      update: async () => ({}),
      createReversal: async () => ({}),
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
        calculateCartTotals: async () => cartTotals || ({
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
        sendSellerPaymentReceivedEmail: async () => {},
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[paymentControllerPath];
  const controller = require(paymentControllerPath);
  Module._load = originalLoad;
  return { controller, stripeMock };
}

async function callCreatePaymentIntent(controller) {
  const reply = makeReply();
  await controller.createPaymentIntent(
    {
      user: { userId: "user_1" },
      body: {
        shippingAddress: { addressLine: "1 Test St" },
        shippingMethodId: "ship_1",
        country: "Australia",
        city: "Sydney",
        state: "NSW",
        zipCode: "2000",
        mobileNumber: "0400000000",
      },
    },
    reply,
  );
  return reply;
}

async function callCreateGuestPaymentIntent(controller) {
  const reply = makeReply();
  await controller.createGuestPaymentIntent(
    {
      body: {
        items: [{ productId: "prod_1", quantity: 1 }],
        customerName: "Guest Buyer",
        customerEmail: "guest@example.com",
        customerPhone: "0400000000",
        shippingAddress: { addressLine: "1 Test St" },
        shippingMethodId: "ship_1",
        country: "Australia",
        city: "Sydney",
        state: "NSW",
        zipCode: "2000",
        mobileNumber: "0400000000",
      },
    },
    reply,
  );
  return reply;
}

async function callCreateGuestPaymentIntentWithCoupon(controller, couponCode) {
  const reply = makeReply();
  await controller.createGuestPaymentIntent(
    {
      body: {
        items: [{ productId: "prod_1", quantity: 1 }],
        customerName: "Guest Buyer",
        customerEmail: "guest@example.com",
        customerPhone: "0400000000",
        shippingAddress: { addressLine: "1 Test St" },
        shippingMethodId: "ship_1",
        country: "Australia",
        city: "Sydney",
        state: "NSW",
        zipCode: "2000",
        mobileNumber: "0400000000",
        couponCode,
      },
    },
    reply,
  );
  return reply;
}

async function callCreateGuestPaymentIntentWithSellerCount(controller, sellerCount) {
  const reply = makeReply();
  await controller.createGuestPaymentIntent(
    {
      body: {
        items: Array.from({ length: sellerCount }, (_, index) => ({
          productId: `prod_${index + 1}`,
          quantity: 1,
        })),
        customerName: "Guest Buyer",
        customerEmail: "guest@example.com",
        customerPhone: "0400000000",
        shippingAddress: { addressLine: "1 Test St" },
        shippingMethodId: "ship_1",
        country: "Australia",
        city: "Sydney",
        state: "NSW",
        zipCode: "2000",
        mobileNumber: "0400000000",
      },
    },
    reply,
  );
  return reply;
}

async function callCreateGuestPaymentIntentWithItems(controller, items) {
  const reply = makeReply();
  await controller.createGuestPaymentIntent(
    {
      body: {
        items,
        customerName: "Guest Buyer",
        customerEmail: "guest@example.com",
        customerPhone: "0400000000",
        shippingAddress: { addressLine: "1 Test St" },
        shippingMethodId: "ship_1",
        country: "Australia",
        city: "Sydney",
        state: "NSW",
        zipCode: "2000",
        mobileNumber: "0400000000",
      },
    },
    reply,
  );
  return reply;
}

function assertBlockedBeforeStripe(reply, stripeMock, prisma, code) {
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, code);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 0);
}

function assertNoFinancialOrOrderSideEffects({ stripeMock, prisma }) {
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 0);
  assert.equal(prisma._subOrderCreateCalls.length, 0);
  assert.equal(prisma._orderItemCreateManyCalls.length, 0);
  assert.equal(prisma._productUpdateCalls.length, 0);
  assert.equal(prisma._productVariantUpdateCalls.length, 0);
}

test("valid seller creates Direct Charge with connected-account request options", async () => {
  const prisma = makePrisma({
      sellerProfile: {
        stripeAccountId: "acct_ready",
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      },
    });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  const call = stripeMock.paymentIntents.createCalls[0];
  assert.equal(call.body.amount, 12000);
  assert.equal(call.body.currency, "aud");
  assert.equal(call.body.metadata.chargeType, "direct");
  assert.equal(call.body.metadata.userId, "user_1");
  assert.equal(call.body.metadata.cartId, "cart_1");
  assert.equal(call.body.application_fee_amount, 1000);
  assert.equal(call.options.stripeAccount, "acct_ready");
  assert.ok(call.options.idempotencyKey);
  assert.equal(call.body.transfer_data, undefined);
  assert.equal(call.body.transfer_data?.destination, undefined);
  assert.equal(call.body.on_behalf_of, undefined);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 1);
  const record = prisma._orderPaymentRecordCreateCalls[0].data;
  assert.equal(record.orderId, "order_1");
  assert.equal(record.sellerId, "seller_1");
  assert.equal(record.paymentFlow, "DIRECT_CHARGE");
  assert.equal(record.stripeAccountId, "acct_ready");
  assert.equal(record.stripePaymentIntentId, "pi_123");
  assert.equal(record.currency, "aud");
  assert.equal(record.grossAmount, 12000);
  assert.equal(record.commissionBase, 10000);
  assert.equal(record.applicationFeeAmount, 1000);
  assert.equal(record.gstAmount, 1000);
  assert.equal(record.shippingAmount, 1000);
  assert.equal(record.paymentStatus, "PENDING");
  assert.equal(record.refundStatus, "NONE");
  assert.equal(record.disputeStatus, "NONE");
});

test("AUD 100 product plus AUD 15 shipping Direct Charge sends only AUD 9.09 application fee", async () => {
  const prisma = makePrisma({
    productPrice: 100,
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
    cartTotals: {
      subtotal: "100.00",
      subtotalExGST: "90.91",
      shippingCost: "15.00",
      totalShippingCost: "15.00",
      sellerCount: 1,
      gstPercentage: "10",
      gstAmount: "9.09",
      grandTotal: "115.00",
      gstDetails: [],
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 200);
  const call = stripeMock.paymentIntents.createCalls[0];
  assert.equal(call.body.amount, 11500);
  assert.equal(call.body.application_fee_amount, 909);
  assert.equal(call.options.stripeAccount, "acct_ready");
  assert.equal(call.body.transfer_data, undefined);
  assert.equal(stripeMock.transfers.createCalls.length, 0);

  const record = prisma._orderPaymentRecordCreateCalls[0].data;
  assert.equal(record.grossAmount, 11500);
  assert.equal(record.commissionBase, 9091);
  assert.equal(record.applicationFeeAmount, 909);
  assert.equal(record.gstAmount, 909);
  assert.equal(record.shippingAmount, 1500);

  const exampleStripeFeeCents = 226;
  const expectedSellerBalanceCents = call.body.amount - call.body.application_fee_amount - exampleStripeFeeCents;
  assert.equal(expectedSellerBalanceCents, 10365);
});

test("same logged-in checkout retry reuses one PaymentIntent and payment record", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const first = await callCreatePaymentIntent(controller);
  const retry = await callCreatePaymentIntent(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.payload.idempotent, true);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 1);
  assert.match(stripeMock.paymentIntents.createCalls[0].options.idempotencyKey, /^payment:create:user:/);
});

test("failed PaymentIntent checkout retry reuses existing PaymentIntent safely", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });
  stripeMock.paymentIntents.retrieve = async () => ({
    id: "pi_123",
    status: "requires_payment_method",
    client_secret: "pi_123_secret_retry",
  });

  const first = await callCreatePaymentIntent(controller);
  const retry = await callCreatePaymentIntent(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.payload.idempotent, true);
  assert.equal(retry.payload.paymentIntentId, "pi_123");
  assert.equal(retry.payload.clientSecret, "pi_123_secret_retry");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 1);
});

test("duplicate failed-payment retry creates no duplicate PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });
  stripeMock.paymentIntents.retrieve = async () => ({
    id: "pi_123",
    status: "requires_payment_method",
    client_secret: "pi_123_secret_retry",
  });

  await callCreatePaymentIntent(controller);
  const retryA = await callCreatePaymentIntent(controller);
  const retryB = await callCreatePaymentIntent(controller);

  assert.equal(retryA.statusCode, 200);
  assert.equal(retryB.statusCode, 200);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 1);
});

test("different legitimate checkout request identity creates a different PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    coupon: {
      code: "SAVE20",
      isActive: true,
      expiresAt: new Date(Date.now() + 86400000),
      usageLimit: null,
      discountType: "fixed",
      discountValue: 20,
      minCartValue: null,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const first = await callCreateGuestPaymentIntent(controller);
  const second = await callCreateGuestPaymentIntentWithCoupon(controller, "SAVE20");

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 2);
  assert.notEqual(
    stripeMock.paymentIntents.createCalls[0].options.idempotencyKey,
    stripeMock.paymentIntents.createCalls[1].options.idempotencyKey,
  );
});

test("client cannot override logged-in checkout idempotency identity", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });
  const reply = makeReply();

  await controller.createPaymentIntent(
    {
      user: { userId: "user_1" },
      body: {
        shippingAddress: { addressLine: "1 Test St" },
        shippingMethodId: "ship_1",
        country: "Australia",
        city: "Sydney",
        state: "NSW",
        zipCode: "2000",
        mobileNumber: "0400000000",
        idempotencyKey: "client_supplied_key",
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 200);
  assert.notEqual(stripeMock.paymentIntents.createCalls[0].options.idempotencyKey, "client_supplied_key");
  assert.match(stripeMock.paymentIntents.createCalls[0].options.idempotencyKey, /^payment:create:user:/);
});

test("missing stripeAccountId blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
      sellerProfile: {
        stripeAccountId: null,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      },
    });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "STRIPE_NOT_CONNECTED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("stripeChargesEnabled false blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
      sellerProfile: {
        stripeAccountId: "acct_disabled",
        stripeChargesEnabled: false,
        stripePayoutsEnabled: true,
      },
    });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "CHARGES_DISABLED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("Stripe charges disabled blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
      sellerProfile: {
        stripeAccountId: "acct_charges_disabled",
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      },
    });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_charges_disabled",
      charges_enabled: false,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "CHARGES_DISABLED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("DB payouts disabled blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_payouts_disabled",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: false,
    },
  });
  const { controller, stripeMock } = loadPaymentController({ prisma, stripeAccount: null });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "PAYOUTS_DISABLED");
});

test("Stripe payouts disabled blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_stripe_payouts_disabled",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_stripe_payouts_disabled",
      charges_enabled: true,
      payouts_enabled: false,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
      country: "AU",
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "PAYOUTS_DISABLED");
});

test("card payments inactive blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_card_inactive",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_card_inactive",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "inactive" },
      requirements: { currently_due: [] },
      country: "AU",
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "CAPABILITY_INACTIVE");
});

test("requirements currently due block checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_requirements_due",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_requirements_due",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: ["company.tax_id"] },
      country: "AU",
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "VERIFICATION_REQUIRED");
});

test("restricted account blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_restricted",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_restricted",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [], disabled_reason: "requirements.past_due" },
      country: "AU",
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "ACCOUNT_RESTRICTED");
});

test("unsupported Stripe account country blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_us",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_us",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
      country: "US",
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "UNSUPPORTED_COUNTRY");
});

test("unsupported Stripe account currency blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_currency",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_currency",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
      country: "AU",
      settings: { card_payments: { supported_currencies: ["usd"] } },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "UNSUPPORTED_CURRENCY");
});

test("Stripe API unavailable fails safely before PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_api_down",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: new Error("stripe unavailable"),
  });

  const reply = await callCreatePaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "SELLER_LOOKUP_FAILED");
});

test("seller lookup failure blocks checkout with no platform fallback", async () => {
  const prisma = makePrisma({
      sellerLookupError: new Error("database unavailable"),
    });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "SELLER_LOOKUP_FAILED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("valid guest seller creates Direct Charge with connected-account request options", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntent(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  const call = stripeMock.paymentIntents.createCalls[0];
  assert.equal(call.body.metadata.chargeType, "direct");
  assert.equal(call.body.metadata.isGuest, "true");
  assert.equal(call.body.metadata.customerEmail, "guest@example.com");
  assert.equal(call.body.application_fee_amount, 1000);
  assert.equal(call.options.stripeAccount, "acct_guest_ready");
  assert.ok(call.options.idempotencyKey);
  assert.equal(call.body.transfer_data, undefined);
  assert.equal(call.body.transfer_data?.destination, undefined);
  assert.equal(call.body.on_behalf_of, undefined);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 1);
  const record = prisma._orderPaymentRecordCreateCalls[0].data;
  assert.equal(record.orderId, "order_1");
  assert.equal(record.sellerId, "seller_1");
  assert.equal(record.paymentFlow, "DIRECT_CHARGE");
  assert.equal(record.stripeAccountId, "acct_guest_ready");
  assert.equal(record.stripePaymentIntentId, "pi_123");
  assert.equal(record.currency, "aud");
  assert.equal(record.grossAmount, 12000);
  assert.equal(record.commissionBase, 10000);
  assert.equal(record.applicationFeeAmount, 1000);
  assert.equal(record.gstAmount, 1000);
  assert.equal(record.shippingAmount, 1000);
});

test("same guest checkout retry reuses one PaymentIntent and payment record", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const first = await callCreateGuestPaymentIntent(controller);
  const retry = await callCreateGuestPaymentIntent(controller);

  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.payload.idempotent, true);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 1);
  assert.match(stripeMock.paymentIntents.createCalls[0].options.idempotencyKey, /^payment:create:guest:/);
});

test("guest Direct Charge application fee and payment record use discounted product subtotal", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    coupon: {
      code: "SAVE20",
      isActive: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      usageLimit: null,
      usageCount: 0,
      minCartValue: null,
      discountType: "fixed",
      discountValue: 20,
      maxDiscount: null,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntentWithCoupon(controller, "SAVE20");

  assert.equal(reply.statusCode, 200);
  const call = stripeMock.paymentIntents.createCalls[0];
  assert.equal(call.body.application_fee_amount, 800);
  const record = prisma._orderPaymentRecordCreateCalls[0].data;
  assert.equal(record.commissionBase, 8000);
  assert.equal(record.applicationFeeAmount, 800);
  assert.equal(record.grossAmount, 10000);
  assert.equal(record.shippingAmount, 1000);
  assert.equal(record.gstAmount, 1000);
});

test("guest missing stripeAccountId blocks checkout and creates no order or PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: null,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "STRIPE_NOT_CONNECTED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("guest stripeChargesEnabled false blocks checkout and creates no order or PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_disabled",
      stripeChargesEnabled: false,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "CHARGES_DISABLED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("guest Stripe charges disabled blocks checkout and creates no order or PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_charges_disabled",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_charges_disabled",
      charges_enabled: false,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "CHARGES_DISABLED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("guest checkout uses shared readiness service for Stripe payout disabled", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_payouts_disabled",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_payouts_disabled",
      charges_enabled: true,
      payouts_enabled: false,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
      country: "AU",
    },
  });

  const reply = await callCreateGuestPaymentIntent(controller);

  assertBlockedBeforeStripe(reply, stripeMock, prisma, "PAYOUTS_DISABLED");
});

test("guest seller lookup failure blocks checkout and creates no order or PaymentIntent", async () => {
  const prisma = makePrisma({
    sellerLookupError: new Error("database unavailable"),
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntent(controller);

  assert.equal(reply.statusCode, 409);
  assert.equal(reply.payload.code, "SELLER_LOOKUP_FAILED");
  assert.equal(stripeMock.paymentIntents.createCalls.length, 0);
  assert.equal(prisma._orderCreateCalls.length, 0);
});

test("one seller cart succeeds for Phase 2 backend guard", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    sellerCount: 1,
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(prisma._orderCreateCalls.length, 1);
});

test("two seller cart creates one Direct Charge PaymentIntent and payment record per seller", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    sellerCount: 2,
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.paymentFlow, "DIRECT_CHARGE");
  assert.equal(reply.payload.payments.length, 2);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 2);
  assert.equal(prisma._orderCreateCalls.length, 1);
  assert.equal(prisma._subOrderCreateCalls.length, 2);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 2);
  for (const call of stripeMock.paymentIntents.createCalls) {
    assert.equal(call.options.stripeAccount, "acct_ready");
    assert.equal(call.body.transfer_data, undefined);
    assert.equal(call.body.on_behalf_of, undefined);
    assert.equal(call.body.metadata.paymentFlow, "DIRECT_CHARGE");
    assert.equal(call.body.metadata.sellerStripeAccountId, "acct_ready");
    assert.ok(call.body.application_fee_amount > 0);
  }
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("three seller cart creates three Direct Charge PaymentIntents without transfers", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    sellerCount: 3,
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.payments.length, 3);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 3);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 3);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("guest two seller cart creates one Direct Charge PaymentIntent and payment record per seller", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntentWithSellerCount(controller, 2);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.paymentFlow, "DIRECT_CHARGE");
  assert.equal(reply.payload.payments.length, 2);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 2);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 2);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("guest three seller cart creates three Direct Charge PaymentIntents without transfers", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntentWithSellerCount(controller, 3);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.payments.length, 3);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 3);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 3);
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("guest sellerId payload tampering still uses database-derived seller grouping", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_guest_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_guest_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntentWithItems(controller, [
    { productId: "prod_1", quantity: 1, sellerId: "same_client_seller" },
    { productId: "prod_2", quantity: 1, sellerId: "same_client_seller" },
  ]);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.payments.length, 2);
  assert.deepEqual(
    prisma._orderPaymentRecordCreateCalls.map((call) => call.data.sellerId),
    ["seller_1", "seller_2"],
  );
});

test("guest omitted or duplicated sellerId payload cannot change database-derived one-seller success", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_payload_ignored",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_payload_ignored",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreateGuestPaymentIntentWithItems(controller, [
    { productId: "prod_1", quantity: 1 },
    { productId: "prod_1", quantity: 1, sellerId: "fake_other_seller" },
  ]);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(stripeMock.paymentIntents.createCalls[0].options.stripeAccount, "acct_payload_ignored");
  assert.equal(stripeMock.transfers.createCalls.length, 0);
});

test("guest invalid product fails safely before Stripe, order, suborder, stock, or transfer side effects", async () => {
  const prisma = makePrisma({
    sellerProfile: null,
    missingProductIds: ["prod_missing"],
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntentWithItems(controller, [
    { productId: "prod_missing", quantity: 1, sellerId: "client_seller" },
  ]);

  assert.equal(reply.statusCode, 404);
  assert.match(reply.payload.message, /Product prod_missing not found/);
  assertNoFinancialOrOrderSideEffects({ stripeMock, prisma });
});

test("duplicate PaymentIntent cannot create a duplicate payment record", async () => {
  const duplicateError = new Error("Unique constraint failed on the fields: (`stripe_payment_intent_id`,`seller_id`)");
  duplicateError.code = "P2002";
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    paymentRecordCreateError: duplicateError,
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(reply.statusCode, 500);
  assert.equal(reply.payload.success, false);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 0);
});

test("failed payment-flow persistence does not silently mark order safely payable", async () => {
  const prisma = makePrisma({
    sellerProfile: {
      stripeAccountId: "acct_ready",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    paymentRecordCreateError: new Error("database unavailable"),
  });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: {
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { card_payments: "active" },
      requirements: { currently_due: [] },
    },
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(stripeMock.paymentIntents.createCalls.length, 1);
  assert.equal(reply.statusCode, 500);
  assert.equal(reply.payload.success, false);
  assert.equal(reply.payload.clientSecret, undefined);
  assert.equal(prisma._orderPaymentRecordCreateCalls.length, 0);
});

test("historical backfill keeps uncertain payments LEGACY_OR_UNKNOWN and preserves legacy identifiers", () => {
  const sql = fs.readFileSync(phase4MigrationPath, "utf8");

  assert.match(sql, /'LEGACY_OR_UNKNOWN'::"PaymentFlow"/);
  assert.match(sql, /'SEPARATE_CHARGE_AND_TRANSFER'::"PaymentFlow"/);
  assert.match(sql, /BOOL_OR\(/);
  assert.match(sql, /ce\."stripe_transfer_id" IS NOT NULL/);
  assert.match(sql, /ce\."stripe_transfer_status" IN \('transferred', 'failed', 'reversed'\)/);
  assert.doesNotMatch(sql, /THEN 'DIRECT_CHARGE'::"PaymentFlow"/);
  assert.match(sql, /o\."stripePaymentIntentId"/);
  assert.match(sql, /DISTINCT ON \(o\."stripePaymentIntentId"\)/);
  assert.doesNotMatch(sql, /UPDATE\s+"?commission_earned"?\s+SET\s+"?stripe_transfer_id"?/i);
});

test("payment records globally prevent duplicate Stripe PaymentIntent IDs across sellers", () => {
  const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
  const sql = fs.readFileSync(phase4MigrationPath, "utf8");

  assert.match(schema, /@@unique\(\[stripePaymentIntentId\]\)/);
  assert.doesNotMatch(schema, /@@unique\(\[stripePaymentIntentId,\s*sellerId\]\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "order_payment_records_stripe_payment_intent_id_key" ON "order_payment_records"\("stripe_payment_intent_id"\)/);
  assert.doesNotMatch(sql, /stripe_payment_intent_id_seller_id_key/);
});
