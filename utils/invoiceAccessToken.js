"use strict";

const jwt = require("jsonwebtoken");

const INVOICE_TOKEN_PURPOSE = "invoice-download";
const INVOICE_TOKEN_AUDIENCE = "invoice-download";
const INVOICE_TOKEN_ISSUER = "mia-be";
const INVOICE_TOKEN_TTL = "30d";

function requireSigningSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required for invoice access tokens");
  }
  return process.env.JWT_SECRET;
}

function createInvoiceAccessToken(orderId) {
  if (typeof orderId !== "string" || !orderId) {
    throw new TypeError("A non-empty invoice order identifier is required");
  }

  return jwt.sign(
    { purpose: INVOICE_TOKEN_PURPOSE, invoiceOrderId: orderId },
    requireSigningSecret(),
    {
      algorithm: "HS256",
      audience: INVOICE_TOKEN_AUDIENCE,
      issuer: INVOICE_TOKEN_ISSUER,
      expiresIn: INVOICE_TOKEN_TTL,
    }
  );
}

function verifyInvoiceAccessToken(token, orderId) {
  if (typeof token !== "string" || !token || typeof orderId !== "string" || !orderId) {
    return false;
  }

  try {
    const payload = jwt.verify(token, requireSigningSecret(), {
      algorithms: ["HS256"],
      audience: INVOICE_TOKEN_AUDIENCE,
      issuer: INVOICE_TOKEN_ISSUER,
    });

    return payload.purpose === INVOICE_TOKEN_PURPOSE &&
      payload.invoiceOrderId === orderId;
  } catch (_) {
    return false;
  }
}

module.exports = {
  createInvoiceAccessToken,
  verifyInvoiceAccessToken,
  INVOICE_TOKEN_PURPOSE,
  INVOICE_TOKEN_AUDIENCE,
  INVOICE_TOKEN_ISSUER,
  INVOICE_TOKEN_TTL,
};
