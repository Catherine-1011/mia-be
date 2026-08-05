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

function makePrisma({ records: initialRecords = null, sellerPlans = null, sessionStatus = "PARTIALLY_COMPLETED" } = {}) {
  const records = initialRecords || [
    {
      id: "rec_platform_paid",
      orderId: "order_1",
      sellerId: "platform_operator",
      paymentFlow: "PLATFORM_ACCOUNT",
      stripeAccountId: null,
      stripePaymentIntentId: "pi_platform_paid",
      paymentStatus: "PAID",
      grossAmount: 12000,
      currency: "aud",
      refundStatus: "NONE",
    },
  ];
  const prisma = {
    _records: records,
    _sessionUpdates: [],
    _orderUpdates: [],
    order: {
      findFirst: async () => ({
        id: "order_1",
        userId: "user_1",
        displayId: "ALPA-001",
        customerName: "Buyer",
        customerEmail: "buyer@example.com",
        shippingAddress: {
          orderSummary: {
            multiSellerPlan: [
              ...(sellerPlans || [
              {
                sellerId: "platform_operator",
                ownerType: "PLATFORM",
                platformAccountId: "platform_alpa",
                paymentAccountType: "PLATFORM",
                paymentFlow: "PLATFORM_ACCOUNT",
                productAmountCents: 11000,
                shippingAmountCents: 1000,
                gstAmountCents: 1000,
                grossAmountCents: 12000,
                commission: { commissionBase: 0, applicationFeeAmount: 0, currency: "aud" },
              },
              {
                sellerId: "seller_a",
                ownerType: "SELLER",
                platformAccountId: null,
                stripeAccountId: "acct_seller_a",
                paymentAccountType: "CONNECTED",
                paymentFlow: "DIRECT_CHARGE",
                productAmountCents: 11000,
                shippingAmountCents: 1000,
                gstAmountCents: 1000,
                grossAmountCents: 12000,
                commission: { commissionBase: 10000, applicationFeeAmount: 1000, currency: "aud" },
              },
              ]),
            ],
          },
        },
        multiSellerCheckoutSession: {
          orderId: "order_1",
          status: sessionStatus,
          platformCustomerId: "cus_platform",
          platformSetupIntentId: "seti_1",
        },
      }),
      update: async (args) => {
        prisma._orderUpdates.push(args);
        return args;
      },
    },
    multiSellerCheckoutSession: {
      updateMany: async () => ({ count: 0 }),
      update: async (args) => {
        prisma._sessionUpdates.push(args);
        return args;
      },
    },
    orderPaymentRecord: {
      findMany: async ({ where, select } = {}) => {
        const rows = records.filter((record) => !where?.orderId || record.orderId === where.orderId);
        if (!select) return rows;
        return rows.map((record) => Object.fromEntries(Object.keys(select).map((key) => [key, record[key]])));
      },
      create: async ({ data }) => {
        records.push({ id: `rec_${records.length + 1}`, refundStatus: "NONE", ...data });
        return records.at(-1);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const record of records) {
          if (where?.stripePaymentIntentId && record.stripePaymentIntentId !== where.stripePaymentIntentId) continue;
          Object.assign(record, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  return prisma;
}

function makeStripe({ createdStatus = "succeeded", retrieveById = {} } = {}) {
  return {
    setupIntents: {
      retrieve: async () => ({ id: "seti_1", status: "succeeded", payment_method: "pm_platform" }),
    },
    paymentMethods: {
      createCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        return { id: "pm_clone_seller_a" };
      },
    },
    paymentIntents: {
      createCalls: [],
      retrieveCalls: [],
      create: async function(body, options) {
        this.createCalls.push({ body, options });
        return { id: `pi_created_${this.createCalls.length}`, status: createdStatus, client_secret: `pi_created_${this.createCalls.length}_secret` };
      },
      retrieve: async function(id, options) {
        this.retrieveCalls.push({ id, options });
        return retrieveById[id] || { id, status: "succeeded", latest_charge: "ch_existing", client_secret: `${id}_secret` };
      },
    },
    webhooks: { constructEvent: () => ({}) },
    charges: { retrieve: async () => ({}), update: async () => ({}) },
    accounts: { retrieve: async (id) => ({ id, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active" }, requirements: {} }) },
    customers: { create: async () => ({ id: "cus_unused" }) },
    transfers: { create: async () => { throw new Error("transfers.create should not be called"); } },
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
    if (resolved === cartControllerPath) return { calculateCartTotals: async () => ({}) };
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

test("finalize resumes partial checkout without duplicating a successful platform charge", async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadController({ prisma, stripe });
  const reply = makeReply();

  await controller.finalizeMultiSellerCheckout({
    user: { userId: "user_1" },
    body: { orderId: "order_1" },
  }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripe.paymentIntents.createCalls.length, 1);
  assert.equal(stripe.paymentIntents.createCalls[0].options.stripeAccount, "acct_seller_a");
  assert.equal(stripe.paymentIntents.createCalls[0].body.application_fee_amount, 1000);
  assert.equal(stripe.paymentMethods.createCalls.length, 1);
  assert.match(stripe.paymentIntents.createCalls[0].options.idempotencyKey, /^charge:order_1:seller:seller_a$/);
  assert.equal(reply.payload.payments.length, 2);
  assert.equal(reply.payload.payments.find((p) => p.paymentFlow === "PLATFORM_ACCOUNT").idempotent, true);
  assert.equal(prisma._records.filter((record) => record.paymentFlow === "PLATFORM_ACCOUNT").length, 1);
  assert.equal(prisma._records.filter((record) => record.paymentFlow === "DIRECT_CHARGE").length, 1);
});

test("existing pending requires_confirmation PaymentIntent is reused without duplicate charge or record", async () => {
  const prisma = makePrisma({
    records: [
      {
        id: "rec_seller_pending",
        orderId: "order_1",
        sellerId: "seller_a",
        paymentFlow: "DIRECT_CHARGE",
        stripeAccountId: "acct_seller_a",
        stripePaymentIntentId: "pi_existing_confirm",
        paymentStatus: "PENDING",
        grossAmount: 12000,
        currency: "aud",
        refundStatus: "NONE",
      },
    ],
    sellerPlans: [
      {
        sellerId: "seller_a",
        ownerType: "SELLER",
        platformAccountId: null,
        stripeAccountId: "acct_seller_a",
        paymentAccountType: "CONNECTED",
        paymentFlow: "DIRECT_CHARGE",
        productAmountCents: 11000,
        shippingAmountCents: 1000,
        gstAmountCents: 1000,
        grossAmountCents: 12000,
        commission: { commissionBase: 10000, applicationFeeAmount: 1000, currency: "aud" },
      },
    ],
  });
  const stripe = makeStripe({
    retrieveById: {
      pi_existing_confirm: {
        id: "pi_existing_confirm",
        status: "requires_confirmation",
        client_secret: "pi_existing_confirm_secret",
      },
    },
  });
  const controller = loadController({ prisma, stripe });
  const reply = makeReply();

  await controller.finalizeMultiSellerCheckout({
    user: { userId: "user_1" },
    body: { orderId: "order_1" },
  }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(stripe.paymentIntents.createCalls.length, 0);
  assert.equal(stripe.paymentMethods.createCalls.length, 0);
  assert.equal(prisma._records.length, 1);
  assert.equal(prisma._records[0].paymentStatus, "PENDING");
  assert.equal(reply.payload.payments.length, 1);
  assert.equal(reply.payload.payments[0].paymentIntentId, "pi_existing_confirm");
  assert.equal(reply.payload.payments[0].clientSecret, "pi_existing_confirm_secret");
  assert.equal(reply.payload.payments[0].status, "requires_confirmation");
  assert.equal(reply.payload.payments[0].ownerType, "SELLER");
  assert.equal(reply.payload.payments[0].sellerId, "seller_a");
  assert.equal(reply.payload.payments[0].stripeAccountId, "acct_seller_a");
  assert.equal(reply.payload.payments[0].paymentFlow, "DIRECT_CHARGE");
});

test("requires_action results include explicit platform and seller commercial owner identity", async () => {
  const platformPrisma = makePrisma({
    sellerPlans: [
      {
        sellerId: "platform_operator",
        ownerType: "PLATFORM",
        platformAccountId: "platform_alpa",
        paymentAccountType: "PLATFORM",
        paymentFlow: "PLATFORM_ACCOUNT",
        productAmountCents: 11000,
        shippingAmountCents: 1000,
        gstAmountCents: 1000,
        grossAmountCents: 12000,
        commission: { commissionBase: 0, applicationFeeAmount: 0, currency: "aud" },
      },
    ],
    records: [],
  });
  const platformStripe = makeStripe({ createdStatus: "requires_action" });
  const platformController = loadController({ prisma: platformPrisma, stripe: platformStripe });
  const platformReply = makeReply();

  await platformController.finalizeMultiSellerCheckout({
    user: { userId: "user_1" },
    body: { orderId: "order_1" },
  }, platformReply);

  const platformPayment = platformReply.payload.payments[0];
  assert.equal(platformPayment.ownerType, "PLATFORM");
  assert.equal(platformPayment.platformAccountId, "platform_alpa");
  assert.equal(platformPayment.sellerId, "platform_operator");
  assert.equal(platformPayment.stripeAccountId, null);
  assert.equal(platformPayment.paymentFlow, "PLATFORM_ACCOUNT");
  assert.equal(platformPayment.paymentIntentId, "pi_created_1");
  assert.equal(platformPayment.clientSecret, "pi_created_1_secret");
  assert.equal(platformPayment.status, "requires_action");

  const sellerPrisma = makePrisma({
    records: [],
    sellerPlans: [
      {
        sellerId: "seller_a",
        ownerType: "SELLER",
        platformAccountId: null,
        stripeAccountId: "acct_seller_a",
        paymentAccountType: "CONNECTED",
        paymentFlow: "DIRECT_CHARGE",
        productAmountCents: 11000,
        shippingAmountCents: 1000,
        gstAmountCents: 1000,
        grossAmountCents: 12000,
        commission: { commissionBase: 10000, applicationFeeAmount: 1000, currency: "aud" },
      },
    ],
  });
  const sellerStripe = makeStripe({ createdStatus: "requires_action" });
  const sellerController = loadController({ prisma: sellerPrisma, stripe: sellerStripe });
  const sellerReply = makeReply();

  await sellerController.finalizeMultiSellerCheckout({
    user: { userId: "user_1" },
    body: { orderId: "order_1" },
  }, sellerReply);

  const sellerPayment = sellerReply.payload.payments[0];
  assert.equal(sellerPayment.ownerType, "SELLER");
  assert.equal(sellerPayment.platformAccountId, null);
  assert.equal(sellerPayment.sellerId, "seller_a");
  assert.equal(sellerPayment.stripeAccountId, "acct_seller_a");
  assert.equal(sellerPayment.paymentFlow, "DIRECT_CHARGE");
  assert.equal(sellerPayment.paymentIntentId, "pi_created_1");
  assert.equal(sellerPayment.clientSecret, "pi_created_1_secret");
  assert.equal(sellerPayment.status, "requires_action");
});
