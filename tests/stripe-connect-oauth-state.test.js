const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");
const crypto = require("crypto");

const stripeConnectControllerPath = path.resolve(__dirname, "../controllers/stripeConnect.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const emailServicePath = path.resolve(__dirname, "../utils/emailService.js");
const notificationControllerPath = path.resolve(__dirname, "../controllers/notification.js");

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

function hashOAuthState(state) {
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

function operationKeyForState(state) {
  return `stripe-connect-oauth:${hashOAuthState(state)}`;
}

function makeStripe({ tokenError = null } = {}) {
  return {
    oauth: {
      tokenCalls: [],
      token: async function(body) {
        this.tokenCalls.push(body);
        if (tokenError) throw tokenError;
        return { stripe_user_id: `acct_${body.code}` };
      },
    },
    accounts: {
      retrieveCalls: [],
      retrieve: async function(accountId) {
        this.retrieveCalls.push(accountId);
        return {
          id: accountId,
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          company: { tax_id_provided: true },
          external_accounts: { total_count: 1 },
        };
      },
    },
    webhooks: {
      constructEvent: () => ({}),
    },
    charges: {
      retrieve: async () => ({}),
    },
    transfers: {
      create: async () => ({}),
      createReversal: async () => ({}),
    },
  };
}

function makePrisma({ users = null, sellerProfiles = null } = {}) {
  const profiles = sellerProfiles || new Map([
    ["seller_a", { userId: "seller_a", stripeAccountId: null, abn: null }],
    ["seller_b", { userId: "seller_b", stripeAccountId: null, abn: null }],
  ]);
  const userRows = users || new Map([
    ["seller_a", { id: "seller_a", email: "seller-a@example.test" }],
    ["seller_b", { id: "seller_b", email: "seller-b@example.test" }],
  ]);

  const prisma = {
    _apiOperations: new Map(),
    _sellerProfileUpdates: [],
    user: {
      findUnique: async ({ where, include, select }) => {
        const user = userRows.get(where.id);
        if (!user) return null;
        if (include?.sellerProfile) {
          return { ...user, sellerProfile: profiles.get(where.id) || null };
        }
        if (select?.email) return { email: user.email };
        return user;
      },
      findMany: async () => [],
    },
    sellerProfile: {
      findUnique: async ({ where, select }) => {
        const profile = profiles.get(where.userId);
        if (!profile) return null;
        if (!select) return profile;
        return Object.fromEntries(Object.keys(select).map((key) => [key, profile[key]]));
      },
      findFirst: async ({ where }) => {
        if (where?.stripeAccountId) {
          for (const profile of profiles.values()) {
            if (profile.stripeAccountId === where.stripeAccountId) return profile;
          }
        }
        return null;
      },
      update: async ({ where, data }) => {
        const profile = profiles.get(where.userId);
        if (!profile) throw new Error(`missing profile ${where.userId}`);
        Object.assign(profile, data);
        prisma._sellerProfileUpdates.push({ where, data });
        return profile;
      },
      updateMany: async () => ({ count: 0 }),
    },
    apiIdempotencyOperation: {
      create: async ({ data }) => {
        if (prisma._apiOperations.has(data.operationKey)) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const now = new Date();
        const row = {
          id: `aio_${prisma._apiOperations.size + 1}`,
          attemptNumber: 1,
          stripePaymentIntentId: null,
          orderId: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        prisma._apiOperations.set(data.operationKey, row);
        return row;
      },
      findUnique: async ({ where }) => prisma._apiOperations.get(where.operationKey) || null,
      updateMany: async ({ where, data }) => {
        const row = prisma._apiOperations.get(where.operationKey);
        if (!row) return { count: 0 };
        if (row.operationType !== where.operationType) return { count: 0 };
        if (row.status !== where.status) return { count: 0 };
        if (where.createdAt?.gt && !(row.createdAt > where.createdAt.gt)) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    stripeWebhookEvent: {
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
    },
    payoutRequest: {
      findFirst: async () => null,
      update: async () => ({}),
    },
    order: {
      findFirst: async () => null,
    },
    $queryRaw: async () => [],
    $executeRaw: async () => ({}),
  };

  return prisma;
}

function loadStripeConnectController({ prisma, stripe }) {
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
        return stripe;
      };
    }
    if (resolved === prismaPath) return prisma;
    if (resolved === emailServicePath) {
      return {
        sendSellerStripeApprovedEmail: async () => ({ success: true }),
        sendDisputeAlertEmail: async () => ({ success: true }),
      };
    }
    if (resolved === notificationControllerPath) {
      return { createNotification: async () => ({ success: true }) };
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[stripeConnectControllerPath];
  delete require.cache[prismaPath];
  delete require.cache[emailServicePath];
  delete require.cache[notificationControllerPath];
  const controller = require(stripeConnectControllerPath);
  Module._load = originalLoad;
  return controller;
}

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function issueOAuthState(controller, userId, prisma) {
  const reply = makeReply();
  await controller.getOAuthUrl({ user: { userId }, query: {}, body: {} }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.success, true);
  const url = new URL(reply.payload.url);
  const state = url.searchParams.get("state");
  const operation = prisma._apiOperations.get(operationKeyForState(state));
  assert.ok(operation);
  return { state, operation, reply, url };
}

test("OAuth initiation generates opaque persisted state and preserves Stripe OAuth parameters", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
  FRONTEND_URL: "https://frontend.example.test",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });

  const first = await issueOAuthState(controller, "seller_a", prisma);
  const second = await issueOAuthState(controller, "seller_a", prisma);

  assert.equal(first.url.origin, "https://connect.stripe.com");
  assert.equal(first.url.pathname, "/oauth/authorize");
  assert.equal(first.url.searchParams.get("response_type"), "code");
  assert.equal(first.url.searchParams.get("client_id"), "ca_test_123");
  assert.equal(first.url.searchParams.get("scope"), "read_write");
  assert.equal(first.url.searchParams.get("redirect_uri"), "https://frontend.example.test/seller/stripe/callback");
  assert.equal(first.url.searchParams.get("stripe_user[email]"), "seller-a@example.test");
  assert.equal(first.url.searchParams.get("stripe_user[country]"), "AU");
  assert.equal(first.url.searchParams.get("stripe_user[currency]"), "aud");

  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.state, "seller_a");
  assert.equal(first.state.includes("seller_a"), false);
  assert.notEqual(first.state, second.state);
  assert.equal(first.operation.operationType, "STRIPE_CONNECT_OAUTH_STATE");
  assert.equal(first.operation.requestHash, "seller_a");
  assert.equal(first.operation.status, "STARTED");
  assert.equal(first.operation.operationKey, operationKeyForState(first.state));
  assert.ok(Date.now() - first.operation.createdAt.getTime() < 10 * 60 * 1000);
}));

test("OAuth initiation preserves submitted ABN persistence and Stripe prefill", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const reply = makeReply();

  await controller.getOAuthUrl({
    user: { userId: "seller_a" },
    query: { abn: "12 345 678 901" },
    body: {},
  }, reply);

  assert.equal(reply.statusCode, 200);
  const url = new URL(reply.payload.url);
  assert.equal(url.searchParams.get("stripe_user[business_tax_id]"), "12345678901");
  assert.equal(prisma._sellerProfileUpdates.length, 1);
  assert.deepEqual(prisma._sellerProfileUpdates[0], {
    where: { userId: "seller_a" },
    data: { abn: "12345678901" },
  });
}));

test("valid callback consumes state and writes returned Stripe account only to bound seller", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state, operation } = await issueOAuthState(controller, "seller_a", prisma);

  const reply = makeReply();
  await controller.handleOAuthCallback({ query: { code: "code_a", state } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.success, true);
  assert.equal(reply.payload.message, "Stripe account connected successfully.");
  assert.equal(reply.payload.stripeAccountId, "acct_code_a");
  assert.equal(operation.status, "CONSUMED");
  assert.deepEqual(stripe.oauth.tokenCalls, [{ grant_type: "authorization_code", code: "code_a" }]);
  assert.equal(prisma._sellerProfileUpdates.length, 1);
  assert.equal(prisma._sellerProfileUpdates[0].where.userId, "seller_a");
  assert.equal(prisma._sellerProfileUpdates[0].data.stripeAccountId, "acct_code_a");
  assert.equal(prisma._sellerProfileUpdates[0].data.stripeChargesEnabled, true);
  assert.equal(prisma._sellerProfileUpdates[0].data.stripePayoutsEnabled, true);
}));

test("seller A state cannot be redirected to seller B by callback query tampering", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state } = await issueOAuthState(controller, "seller_a", prisma);

  const reply = makeReply();
  await controller.handleOAuthCallback({
    query: {
      code: "code_for_a",
      state,
      userId: "seller_b",
      sellerId: "seller_b",
      accountId: "seller_b",
    },
  }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(prisma._sellerProfileUpdates.length, 1);
  assert.equal(prisma._sellerProfileUpdates[0].where.userId, "seller_a");
  assert.equal(prisma._sellerProfileUpdates.some((call) => call.where.userId === "seller_b"), false);
}));

test("unknown forged state is rejected before Stripe exchange or seller update", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const reply = makeReply();

  await controller.handleOAuthCallback({ query: { code: "code_forged", state: "A".repeat(43) } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.success, false);
  assert.equal(reply.payload.message, "Invalid or expired state parameter.");
  assert.equal(stripe.oauth.tokenCalls.length, 0);
  assert.equal(prisma._sellerProfileUpdates.length, 0);
}));

test("missing state is rejected before Stripe exchange or seller update", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const reply = makeReply();

  await controller.handleOAuthCallback({ query: { code: "code_missing_state" } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.message, "Invalid or expired state parameter.");
  assert.equal(stripe.oauth.tokenCalls.length, 0);
  assert.equal(prisma._sellerProfileUpdates.length, 0);
}));

test("expired state is rejected before Stripe exchange or seller update", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state, operation } = await issueOAuthState(controller, "seller_a", prisma);
  operation.createdAt = new Date(Date.now() - 10 * 60 * 1000 - 1000);
  const reply = makeReply();

  await controller.handleOAuthCallback({ query: { code: "code_expired", state } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.message, "Invalid or expired state parameter.");
  assert.equal(operation.status, "STARTED");
  assert.equal(stripe.oauth.tokenCalls.length, 0);
  assert.equal(prisma._sellerProfileUpdates.length, 0);
}));

test("OAuth state is single-use and replay cannot assign a second account", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state, operation } = await issueOAuthState(controller, "seller_a", prisma);

  const firstReply = makeReply();
  await controller.handleOAuthCallback({ query: { code: "code_first", state } }, firstReply);
  const secondReply = makeReply();
  await controller.handleOAuthCallback({ query: { code: "code_second", state } }, secondReply);

  assert.equal(firstReply.statusCode, 200);
  assert.equal(secondReply.statusCode, 400);
  assert.equal(operation.status, "CONSUMED");
  assert.equal(stripe.oauth.tokenCalls.length, 1);
  assert.equal(prisma._sellerProfileUpdates.length, 1);
  assert.equal(prisma._sellerProfileUpdates[0].data.stripeAccountId, "acct_code_first");
}));

test("seller cancellation consumes valid state and preserves cancellation response without Stripe exchange", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state, operation } = await issueOAuthState(controller, "seller_a", prisma);
  const reply = makeReply();

  await controller.handleOAuthCallback({
    query: {
      state,
      error: "access_denied",
      error_description: "Seller cancelled onboarding.",
    },
  }, reply);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.payload.success, false);
  assert.equal(reply.payload.message, "Seller cancelled onboarding.");
  assert.equal(reply.payload.error, "access_denied");
  assert.equal(operation.status, "CONSUMED");
  assert.equal(stripe.oauth.tokenCalls.length, 0);
  assert.equal(prisma._sellerProfileUpdates.length, 0);
}));

test("concurrent callbacks for the same state result in one Stripe exchange and one seller update", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state } = await issueOAuthState(controller, "seller_a", prisma);

  const firstReply = makeReply();
  const secondReply = makeReply();
  await Promise.all([
    controller.handleOAuthCallback({ query: { code: "code_first", state } }, firstReply),
    controller.handleOAuthCallback({ query: { code: "code_second", state, userId: "seller_b" } }, secondReply),
  ]);

  assert.equal([firstReply.statusCode, secondReply.statusCode].filter((code) => code === 200).length, 1);
  assert.equal([firstReply.statusCode, secondReply.statusCode].filter((code) => code === 400).length, 1);
  assert.equal(stripe.oauth.tokenCalls.length, 1);
  assert.equal(prisma._sellerProfileUpdates.length, 1);
  assert.equal(prisma._sellerProfileUpdates[0].where.userId, "seller_a");
}));

test("Stripe exchange failure after valid state consumption burns the state without updating seller", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const prisma = makePrisma();
  const stripe = makeStripe({ tokenError: new Error("invalid_grant") });
  const controller = loadStripeConnectController({ prisma, stripe });
  const { state, operation } = await issueOAuthState(controller, "seller_a", prisma);

  const reply = makeReply();
  await controller.handleOAuthCallback({ query: { code: "bad_code", state } }, reply);

  assert.equal(reply.statusCode, 500);
  assert.equal(reply.payload.success, false);
  assert.equal(reply.payload.message, "Failed to complete Stripe connection.");
  assert.equal(operation.status, "CONSUMED");
  assert.equal(stripe.oauth.tokenCalls.length, 1);
  assert.equal(prisma._sellerProfileUpdates.length, 0);

  const retryReply = makeReply();
  await controller.handleOAuthCallback({ query: { code: "bad_code", state } }, retryReply);
  assert.equal(retryReply.statusCode, 400);
  assert.equal(stripe.oauth.tokenCalls.length, 1);
}));

test("already connected sellers cannot initiate or overwrite through callback", async () => withEnv({
  STRIPE_CLIENT_ID: "ca_test_123",
}, async () => {
  const profiles = new Map([
    ["seller_a", { userId: "seller_a", stripeAccountId: "acct_existing_a", abn: null }],
    ["seller_b", { userId: "seller_b", stripeAccountId: null, abn: null }],
  ]);
  const prisma = makePrisma({ sellerProfiles: profiles });
  const stripe = makeStripe();
  const controller = loadStripeConnectController({ prisma, stripe });

  const initiateReply = makeReply();
  await controller.getOAuthUrl({ user: { userId: "seller_a" }, query: {}, body: {} }, initiateReply);
  assert.equal(initiateReply.statusCode, 200);
  assert.equal(initiateReply.payload.alreadyConnected, true);
  assert.equal(prisma._apiOperations.size, 0);

  const operationKey = operationKeyForState("B".repeat(43));
  prisma._apiOperations.set(operationKey, {
    id: "manual_state",
    operationKey,
    operationType: "STRIPE_CONNECT_OAUTH_STATE",
    requestHash: "seller_a",
    status: "STARTED",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const callbackReply = makeReply();
  await controller.handleOAuthCallback({ query: { code: "new_code", state: "B".repeat(43) } }, callbackReply);

  assert.equal(callbackReply.statusCode, 409);
  assert.equal(callbackReply.payload.message, "Stripe account is already connected.");
  assert.equal(stripe.oauth.tokenCalls.length, 0);
  assert.equal(prisma._sellerProfileUpdates.length, 0);
  assert.equal(profiles.get("seller_a").stripeAccountId, "acct_existing_a");
}));
