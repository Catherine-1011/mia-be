const test = require("node:test");
const assert = require("node:assert/strict");
const fastify = require("fastify");
const { createErrorTracking, sanitizeEvent } = require("../config/errorTracking");
const { registerFastifyErrorHandler } = require("../config/fastifyErrorHandler");

function makeSdk({ failCapture = false } = {}) {
  const calls = { init: [], captured: [], scope: null };
  return {
    calls,
    init(options) { calls.init.push(options); },
    withScope(callback) {
      const scope = {
        tags: {}, context: {},
        setTag(key, value) { this.tags[key] = value; },
        setContext(key, value) { this.context[key] = value; },
      };
      calls.scope = scope;
      callback(scope);
    },
    captureException(error) {
      if (failCapture) throw new Error("transport unavailable");
      calls.captured.push(error);
    },
  };
}

test("configured tracking captures a controlled Fastify exception without changing the response", async () => {
  const sdk = makeSdk();
  const tracker = createErrorTracking(sdk, { SENTRY_DSN: "https://public@example.invalid/1", NODE_ENV: "test" });
  assert.equal(tracker.initialize(), true);
  const app = fastify({ logger: false });
  registerFastifyErrorHandler(app, tracker);
  app.get("/controlled", async () => { throw new Error("controlled failure"); });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await app.inject({ method: "GET", url: "/controlled" });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { success: false, error: "controlled failure" });
    assert.equal(sdk.calls.captured.length, 1);
    assert.equal(sdk.calls.scope.context.request.path, "/controlled");
  } finally {
    console.error = originalError;
    await app.close();
  }
});

test("tracking is a no-op without SENTRY_DSN", () => {
  const sdk = makeSdk();
  const tracker = createErrorTracking(sdk, { NODE_ENV: "production" });
  assert.equal(tracker.initialize(), false);
  tracker.captureRequestError(new Error("ignored"), { method: "GET", url: "/" }, 500);
  assert.equal(sdk.calls.init.length, 0);
  assert.equal(sdk.calls.captured.length, 0);
});

test("Sentry capture failure never changes the API response", async () => {
  const tracker = createErrorTracking(makeSdk({ failCapture: true }), { SENTRY_DSN: "https://public@example.invalid/1" });
  tracker.initialize();
  const app = fastify({ logger: false });
  registerFastifyErrorHandler(app, tracker);
  app.get("/failure", async () => { throw new Error("application failure"); });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await app.inject({ method: "GET", url: "/failure" });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { success: false, error: "application failure" });
  } finally {
    console.error = originalError;
    await app.close();
  }
});

test("events remove sensitive headers, bodies, user data, secrets, and connection strings", () => {
  const clean = sanitizeEvent({
    request: {
      method: "POST", url: "/api/payments?otp=123456", query_string: "otp=123456",
      headers: { authorization: "Bearer abc", cookie: "session=secret" },
      data: { password: "secret", cardNumber: "4242424242424242" }, env: { DATABASE_URL: "secret" },
    },
    user: { email: "customer@example.com" },
    extra: { otp: "123456", note: "postgresql://user:pass@host/db", stripeSecretKey: "sk_live_secret" },
  });
  assert.equal(clean.request.method, "POST");
  assert.equal(clean.request.url, "/api/payments");
  assert.equal(clean.request.headers, undefined);
  assert.equal(clean.request.data, undefined);
  assert.equal(clean.request.query_string, undefined);
  assert.equal(clean.request.env, undefined);
  assert.equal(clean.user, undefined);
  assert.equal(clean.extra, undefined);
});
