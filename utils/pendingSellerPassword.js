const bcrypt = require("bcryptjs");

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const SELLER_PASSWORD_COST = 10;

function isBcryptHash(value) {
  return typeof value === "string" && BCRYPT_HASH_PATTERN.test(value);
}

async function hashNewPendingSellerPassword(password) {
  return bcrypt.hash(password, SELLER_PASSWORD_COST);
}

async function normalizePendingSellerPassword(password) {
  if (isBcryptHash(password)) return password;
  return bcrypt.hash(password, SELLER_PASSWORD_COST);
}

module.exports = {
  hashNewPendingSellerPassword,
  isBcryptHash,
  normalizePendingSellerPassword,
};
