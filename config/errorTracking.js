const Sentry = require("@sentry/node");

const SENSITIVE_KEY = /authorization|cookie|session|password|passcode|otp|token|secret|api[_-]?key|dsn|database|connection|card|payment|stripe|cvv|cvc/i;

function scrubString(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[Filtered]")
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+\b/g, "[Filtered]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[Filtered]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[Filtered]")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, "[Filtered]");
}

function scrub(value, seen = new WeakSet()) {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, seen));
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    clean[key] = SENSITIVE_KEY.test(key) ? "[Filtered]" : scrub(item, seen);
  }
  return clean;
}

function sanitizeEvent(event) {
  const clean = scrub(event);
  if (clean.request) {
    if (clean.request.url) clean.request.url = clean.request.url.split("?")[0];
    delete clean.request.headers;
    delete clean.request.cookies;
    delete clean.request.data;
    delete clean.request.query_string;
    delete clean.request.env;
  }
  delete clean.user;
  delete clean.extra;
  delete clean.breadcrumbs;
  return clean;
}

function createErrorTracking(sdk = Sentry, env = process.env) {
  let enabled = false;
  function initialize() {
    if (!env.SENTRY_DSN) return false;
    try {
      sdk.init({
        dsn: env.SENTRY_DSN,
        enabled: true,
        environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || "unknown",
        sendDefaultPii: false,
        tracesSampleRate: 0,
        beforeSend: sanitizeEvent,
      });
      enabled = true;
    } catch (error) {
      console.error("Sentry initialization failed (non-fatal):", error);
    }
    return enabled;
  }
  function captureRequestError(error, request, statusCode) {
    if (!enabled || statusCode < 500) return;
    try {
      sdk.withScope((scope) => {
        scope.setTag("http.method", request.method);
        scope.setTag("http.status_code", String(statusCode));
        scope.setContext("request", {
          method: request.method,
          path: (request.routeOptions && request.routeOptions.url) || String(request.url || "").split("?")[0],
          requestId: request.id,
          timestamp: new Date().toISOString(),
        });
        sdk.captureException(error);
      });
    } catch (trackingError) {
      console.error("Sentry capture failed (non-fatal):", trackingError);
    }
  }
  return { initialize, captureRequestError, isEnabled: () => enabled };
}

const errorTracking = createErrorTracking();
module.exports = { ...errorTracking, createErrorTracking, sanitizeEvent };
