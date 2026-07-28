const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// controllers/payment.js -> controllers/orders.js instantiates the Stripe SDK
// at module load time with process.env.STRIPE_SECRET_KEY. In the full app
// this is populated by server.js's dotenv.config() before any controller
// loads; replicate that here so requiring payment.js standalone doesn't throw.
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const paymentPath = path.resolve(__dirname, "../controllers/payment.js");

// controllers/payment.js requires ../config/prisma at module load time, which
// (in the real module) opens a live DB connection via prisma.$connect(). Stub
// it out before requiring payment.js so this stays a pure unit test.
require.cache[prismaPath] = {
  exports: new Proxy({}, { get: () => async () => null }),
};

const { buildPaymentCompletionOutboxRows } = require(paymentPath);

const EXPECTED_TYPES = [
  "CUSTOMER_CONFIRMATION",
  "ADMIN_NEW_ORDER_NOTIFICATION",
  "SELLER_NEW_ORDER_NOTIFICATION",
  "SELLER_PAYMENT_NOTIFICATION",
];

function baseOrder(overrides = {}) {
  return {
    id: "order_1",
    displayId: "ABC123",
    customerEmail: "customer@example.com",
    customerName: "Customer",
    items: [{ product: { sellerId: "seller_a" } }],
    ...overrides,
  };
}

test("row builder creates exactly one row per outbox event type", () => {
  const order = baseOrder();
  const rows = buildPaymentCompletionOutboxRows({ order, paymentIntentId: "pi_1", sellerIds: ["seller_a"] });

  assert.equal(rows.length, EXPECTED_TYPES.length);
  assert.deepEqual(rows.map((r) => r.type).sort(), [...EXPECTED_TYPES].sort());
  for (const row of rows) {
    assert.equal(row.orderId, order.id);
    assert.equal(row.stripePaymentIntentId, "pi_1");
  }
});

test("multi-seller payment carries every sellerId into the seller-scoped rows", () => {
  const order = baseOrder({
    items: [{ product: { sellerId: "seller_a" } }, { product: { sellerId: "seller_b" } }],
  });
  const rows = buildPaymentCompletionOutboxRows({ order, paymentIntentId: "pi_multi", sellerIds: ["seller_a", "seller_b"] });

  const sellerNewOrder = rows.find((r) => r.type === "SELLER_NEW_ORDER_NOTIFICATION");
  const sellerPayment = rows.find((r) => r.type === "SELLER_PAYMENT_NOTIFICATION");

  assert.deepEqual(sellerNewOrder.payload.sellerIds.sort(), ["seller_a", "seller_b"]);
  assert.deepEqual(sellerPayment.payload.sellerIds.sort(), ["seller_a", "seller_b"]);
});

test("single-seller payment carries exactly one sellerId", () => {
  const order = baseOrder();
  const rows = buildPaymentCompletionOutboxRows({ order, paymentIntentId: "pi_single", sellerIds: ["seller_a"] });

  const sellerPayment = rows.find((r) => r.type === "SELLER_PAYMENT_NOTIFICATION");
  assert.deepEqual(sellerPayment.payload.sellerIds, ["seller_a"]);
});

test("guest order (no account) still carries customerEmail/customerName into CUSTOMER_CONFIRMATION payload", () => {
  const order = baseOrder({ id: "order_guest", customerEmail: "guest@example.com", customerName: "Guest Shopper", userId: null });
  const rows = buildPaymentCompletionOutboxRows({ order, paymentIntentId: "pi_guest", sellerIds: ["seller_a"] });

  const customerRow = rows.find((r) => r.type === "CUSTOMER_CONFIRMATION");
  assert.equal(customerRow.payload.customerEmail, "guest@example.com");
  assert.equal(customerRow.payload.customerName, "Guest Shopper");
});

test("re-running the row builder for the same order+paymentIntent produces identical (orderId,type) pairs, so DB skipDuplicates prevents duplicate rows on webhook redelivery", () => {
  const order = baseOrder();
  const first = buildPaymentCompletionOutboxRows({ order, paymentIntentId: "pi_dup", sellerIds: ["seller_a"] });
  const second = buildPaymentCompletionOutboxRows({ order, paymentIntentId: "pi_dup", sellerIds: ["seller_a"] });

  const key = (rows) => rows.map((r) => `${r.orderId}:${r.type}`).sort();
  assert.deepEqual(key(first), key(second));

  // Simulate the schema's @@unique([orderId, type]) + createMany({ skipDuplicates: true })
  // that the webhook transaction relies on (prisma/schema.prisma: payment_completion_outbox).
  const seen = new Set();
  let inserted = 0;
  for (const row of [...first, ...second]) {
    const dedupeKey = `${row.orderId}:${row.type}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    inserted += 1;
  }
  assert.equal(inserted, EXPECTED_TYPES.length);
});
