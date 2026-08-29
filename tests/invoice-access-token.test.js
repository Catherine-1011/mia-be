"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { resolveAuthUserId } = require("../utils/authIdentity");
const {
  createInvoiceAccessToken,
  verifyInvoiceAccessToken,
  INVOICE_TOKEN_AUDIENCE,
  INVOICE_TOKEN_ISSUER,
} = require("../utils/invoiceAccessToken");

const TEST_SECRET = "invoice-token-test-secret-at-least-32-bytes";

test.beforeEach(() => {
  process.env.JWT_SECRET = TEST_SECRET;
});

test("invoice token is exact-order, purpose-bound, isolated from login, and expires in 30 days", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = createInvoiceAccessToken("ORDER-A");
  const payload = jwt.verify(token, TEST_SECRET, {
    algorithms: ["HS256"],
    audience: INVOICE_TOKEN_AUDIENCE,
    issuer: INVOICE_TOKEN_ISSUER,
  });

  assert.equal(payload.purpose, "invoice-download");
  assert.equal(payload.invoiceOrderId, "ORDER-A");
  assert.ok(payload.exp - payload.iat >= 30 * 24 * 60 * 60 - 1);
  assert.ok(payload.exp - before <= 30 * 24 * 60 * 60 + 1);
  assert.equal(resolveAuthUserId(payload), null);
  for (const claim of ["userId", "uid", "id", "sellerId", "role", "jti"]) {
    assert.equal(Object.hasOwn(payload, claim), false);
  }
  assert.equal(verifyInvoiceAccessToken(token, "ORDER-A"), true);
  assert.equal(verifyInvoiceAccessToken(token, "ORDER-B"), false);
});

test("forged, malformed, expired, wrong-purpose, and normal login tokens are rejected", () => {
  const forged = createInvoiceAccessToken("ORDER-A").slice(0, -1) + "x";
  const expired = jwt.sign(
    { purpose: "invoice-download", invoiceOrderId: "ORDER-A" },
    TEST_SECRET,
    { algorithm: "HS256", audience: INVOICE_TOKEN_AUDIENCE, issuer: INVOICE_TOKEN_ISSUER, expiresIn: -1 }
  );
  const wrongPurpose = jwt.sign(
    { purpose: "login", invoiceOrderId: "ORDER-A" },
    TEST_SECRET,
    { algorithm: "HS256", audience: INVOICE_TOKEN_AUDIENCE, issuer: INVOICE_TOKEN_ISSUER, expiresIn: "30d" }
  );
  const loginToken = jwt.sign({ userId: "customer-a", role: "CUSTOMER" }, TEST_SECRET, { expiresIn: "1h" });

  for (const token of [undefined, "not-a-jwt", forged, expired, wrongPurpose, loginToken]) {
    assert.equal(verifyInvoiceAccessToken(token, "ORDER-A"), false);
  }
});
