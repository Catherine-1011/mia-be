const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAuthUserId } = require("../utils/authIdentity");

test("/api/profile identity resolution accepts current customer token fields", () => {
  assert.equal(resolveAuthUserId({ userId: "customer_1", uid: "customer_1" }), "customer_1");
  assert.equal(resolveAuthUserId({ uid: "customer_2" }), "customer_2");
  assert.equal(resolveAuthUserId({ id: "customer_3" }), "customer_3");
});

test("/api/profile identity resolution accepts legacy sellerId token field", () => {
  assert.equal(resolveAuthUserId({ sellerId: "seller_legacy", role: "SELLER" }), "seller_legacy");
});

test("identity resolution rejects tokens without a user identifier", () => {
  assert.equal(resolveAuthUserId({ role: "SELLER" }), null);
  assert.equal(resolveAuthUserId(null), null);
});
