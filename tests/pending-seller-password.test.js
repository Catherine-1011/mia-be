const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const {
  hashNewPendingSellerPassword,
  isBcryptHash,
  normalizePendingSellerPassword,
} = require("../utils/pendingSellerPassword");

test("new seller passwords are bcrypt-hashed before pending persistence", async () => {
  const plaintext = "new-seller-secret";
  const stored = await hashNewPendingSellerPassword(plaintext);

  assert.notEqual(stored, plaintext);
  assert.equal(isBcryptHash(stored), true);
  assert.equal(await bcrypt.compare(plaintext, stored), true);
});

test("already-hashed pending passwords are used directly and not double-hashed", async () => {
  const plaintext = "already-hashed-secret";
  const pendingHash = await bcrypt.hash(plaintext, 4);
  const userPassword = await normalizePendingSellerPassword(pendingHash);

  assert.equal(userPassword, pendingHash);
  assert.equal(await bcrypt.compare(plaintext, userPassword), true);
});

test("legacy plaintext pending passwords are hashed once at OTP completion", async () => {
  const legacyPendingPassword = "legacy-seller-secret";
  const userPassword = await normalizePendingSellerPassword(legacyPendingPassword);

  assert.notEqual(userPassword, legacyPendingPassword);
  assert.equal(isBcryptHash(userPassword), true);
  assert.equal(await bcrypt.compare(legacyPendingPassword, userPassword), true);
});

test("a bcrypt-shaped password submitted by a new seller is still hashed as plaintext", async () => {
  const bcryptShapedPlaintext = "$2b$10$.....................................................";
  const stored = await hashNewPendingSellerPassword(bcryptShapedPlaintext);

  assert.notEqual(stored, bcryptShapedPlaintext);
  assert.equal(await bcrypt.compare(bcryptShapedPlaintext, stored), true);
});
