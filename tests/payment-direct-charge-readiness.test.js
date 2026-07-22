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

function makeCartWithSellerCount(sellerCount = 1) {
  return {
    id: "cart_1",
    items: Array.from({ length: sellerCount }, (_, index) => ({
      quantity: 1,
      variantId: null,
      productVariant: null,
      product: {
        id: `prod_${index + 1}`,
        title: `Artwork ${index + 1}`,
        price: 110,
        stock: 5,
        sellerId: `seller_${index + 1}`,
      },
    })),
  };
}

function makePrisma({ sellerProfile, sellerLookupError = null, sellerCount = 1, missingProductIds = [], paymentRecordCreateError = null } = {}) {
  const prisma = {
    _orderCreateCalls: [],
    _orderPaymentRecordCreateCalls: [],
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
      findUnique: async () => makeCartWithSellerCount(sellerCount),
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
          price: 110,
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
      findUnique: async () => null,
    },
    order: {
      findUnique: async () => null,
      create: async ({ data }) => {
        prisma._orderCreateCalls.push({ data });
        return {
          id: "order_1",
          displayId: data.displayId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
        };
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
        return { count: args.data?.length || 0 };
      },
    },
    orderPaymentRecord: {
      create: async (args) => {
        if (paymentRecordCreateError) throw paymentRecordCreateError;
        prisma._orderPaymentRecordCreateCalls.push(args);
        return { id: "payment_record_1", ...args.data };
      },
    },
    $transaction: async (callback) => callback(prisma),
  };
  return prisma;
}

function loadPaymentController({ prisma, stripeAccount }) {
  const stripeMock = {
    accounts: {
      retrieve: async () => stripeAccount,
    },
    paymentIntents: {
      createCalls: [],
      updateCalls: [],
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

test("two seller cart is rejected before PaymentIntent, transfer, stock, or payable order", async () => {
  const prisma = makePrisma({ sellerProfile: null, sellerCount: 2 });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.code, "MIXED_SELLER_CHECKOUT_NOT_SUPPORTED");
  assert.match(reply.payload.message, /one seller at a time/i);
  assertNoFinancialOrOrderSideEffects({ stripeMock, prisma });
});

test("three seller cart is rejected before PaymentIntent, transfer, stock, or payable order", async () => {
  const prisma = makePrisma({ sellerProfile: null, sellerCount: 3 });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreatePaymentIntent(controller);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.code, "MIXED_SELLER_CHECKOUT_NOT_SUPPORTED");
  assertNoFinancialOrOrderSideEffects({ stripeMock, prisma });
});

test("guest two seller cart is rejected before PaymentIntent, transfer, stock, or payable order", async () => {
  const prisma = makePrisma({ sellerProfile: null });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntentWithSellerCount(controller, 2);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.code, "MIXED_SELLER_CHECKOUT_NOT_SUPPORTED");
  assert.match(reply.payload.message, /one seller at a time/i);
  assertNoFinancialOrOrderSideEffects({ stripeMock, prisma });
});

test("guest three seller cart is rejected before PaymentIntent, transfer, stock, or payable order", async () => {
  const prisma = makePrisma({ sellerProfile: null });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntentWithSellerCount(controller, 3);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.code, "MIXED_SELLER_CHECKOUT_NOT_SUPPORTED");
  assertNoFinancialOrOrderSideEffects({ stripeMock, prisma });
});

test("guest sellerId payload tampering cannot bypass database-derived mixed-seller guard", async () => {
  const prisma = makePrisma({ sellerProfile: null });
  const { controller, stripeMock } = loadPaymentController({
    prisma,
    stripeAccount: null,
  });

  const reply = await callCreateGuestPaymentIntentWithItems(controller, [
    { productId: "prod_1", quantity: 1, sellerId: "same_client_seller" },
    { productId: "prod_2", quantity: 1, sellerId: "same_client_seller" },
  ]);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.code, "MIXED_SELLER_CHECKOUT_NOT_SUPPORTED");
  assert.equal(
    reply.payload.message,
    "Your cart contains products from multiple sellers. Please complete checkout for one seller at a time.",
  );
  assertNoFinancialOrOrderSideEffects({ stripeMock, prisma });
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
