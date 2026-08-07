"use strict";

function resolveAuthUserId(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  return decoded.userId || decoded.uid || decoded.id || decoded.sellerId || null;
}

module.exports = { resolveAuthUserId };
