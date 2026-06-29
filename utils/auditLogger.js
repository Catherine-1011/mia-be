'use strict';

/**
 * auditLogger.js — Central, append-only audit logging utility.
 *
 * Design goals:
 *  • NEVER throws or crashes the calling request — all errors are swallowed & logged to console.
 *  • Strips sensitive fields before storing snapshots.
 *  • Works for any entity (Product, Order, User …) — just extend ENTITY_TYPES / AUDIT_ACTIONS.
 *  • request.user shape expected: { userId, email, role }  (set by authMiddleware.js)
 */

const prisma = require('../config/prisma');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ENTITY_TYPES = {
  PRODUCT:       'PRODUCT',
  ORDER:         'ORDER',
  USER:          'USER',
  CATEGORY:      'CATEGORY',
  COUPON:        'COUPON',
  SELLER_COUPON: 'SELLER_COUPON',
  SAML_APPROVAL: 'SAML_APPROVAL',
};

const AUDIT_ACTIONS = {
  // ── Product lifecycle ──────────────────────────────────────────────────────
  PRODUCT_CREATED:       'PRODUCT_CREATED',
  PRODUCT_UPDATED:       'PRODUCT_UPDATED',
  PRODUCT_DELETED:       'PRODUCT_DELETED',

  // ── Product approval workflow ──────────────────────────────────────────────
  PRODUCT_APPROVED:      'PRODUCT_APPROVED',
  PRODUCT_REJECTED:      'PRODUCT_REJECTED',
  PRODUCT_BULK_APPROVED: 'PRODUCT_BULK_APPROVED',

  // ── Product visibility ─────────────────────────────────────────────────────
  PRODUCT_ACTIVATED:     'PRODUCT_ACTIVATED',
  PRODUCT_DEACTIVATED:   'PRODUCT_DEACTIVATED',

  // ── Recycle bin ───────────────────────────────────────────────────────────
  PRODUCT_RESTORED:                   'PRODUCT_RESTORED',
  PRODUCT_PERMANENTLY_DELETED:        'PRODUCT_PERMANENTLY_DELETED',

  // ── Automated / system actions ─────────────────────────────────────────────
  PRODUCT_AUTO_DEACTIVATED_LOW_STOCK: 'PRODUCT_AUTO_DEACTIVATED_LOW_STOCK',

  // ── Category lifecycle ─────────────────────────────────────────────────────
  CATEGORY_CREATED:      'CATEGORY_CREATED',       // Admin created directly (APPROVED)
  CATEGORY_REQUESTED:    'CATEGORY_REQUESTED',      // Seller/Admin submitted request
  CATEGORY_APPROVED:     'CATEGORY_APPROVED',       // Admin approved a PENDING request
  CATEGORY_REJECTED:     'CATEGORY_REJECTED',       // Admin rejected a PENDING request
  CATEGORY_EDITED:       'CATEGORY_EDITED',         // Admin edited an APPROVED category directly
  CATEGORY_RESUBMITTED:  'CATEGORY_RESUBMITTED',    // Seller re-edited and resubmitted after rejection
  CATEGORY_SOFT_DELETED: 'CATEGORY_SOFT_DELETED',   // Moved to recycle bin
  CATEGORY_RESTORED:     'CATEGORY_RESTORED',       // Recovered from recycle bin
  CATEGORY_HARD_DELETED: 'CATEGORY_HARD_DELETED',   // Permanently deleted (row gone; log entry remains)

  // ── Coupon lifecycle ───────────────────────────────────────────────────────
  COUPON_CREATED:      'COUPON_CREATED',       // Admin created a new coupon
  COUPON_UPDATED:      'COUPON_UPDATED',       // Admin edited coupon fields
  COUPON_SOFT_DELETED: 'COUPON_SOFT_DELETED',  // Moved to recycle bin
  COUPON_RESTORED:     'COUPON_RESTORED',      // Recovered from recycle bin
  COUPON_HARD_DELETED: 'COUPON_HARD_DELETED',  // Permanently deleted (row gone; log entry remains)

  // ── Seller coupon lifecycle ────────────────────────────────────────────────
  SELLER_COUPON_CREATED:      'SELLER_COUPON_CREATED',
  SELLER_COUPON_UPDATED:      'SELLER_COUPON_UPDATED',
  SELLER_COUPON_SOFT_DELETED: 'SELLER_COUPON_SOFT_DELETED',
  SELLER_COUPON_RESTORED:     'SELLER_COUPON_RESTORED',
  SELLER_COUPON_HARD_DELETED: 'SELLER_COUPON_HARD_DELETED',

  // ── SAML approval workflow ──────────────────────────────────────────────────
  SAML_USER_CREATED:      'SAML_USER_CREATED',
  SAML_USER_APPROVED:     'SAML_USER_APPROVED',
  SAML_USER_REJECTED:     'SAML_USER_REJECTED',
  SAML_USER_BLOCKED:      'SAML_USER_BLOCKED',
  SAML_USER_UNBLOCKED:    'SAML_USER_UNBLOCKED',
  SAML_USER_ROLE_CHANGED: 'SAML_USER_ROLE_CHANGED',

  // ── Future entities — add when ready ──────────────────────────────────────
  // ORDER_CREATED, ORDER_STATUS_CHANGED, ORDER_CANCELLED, ORDER_REFUNDED ...
  // USER_ROLE_CHANGED, USER_BANNED ...
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Strip sensitive keys from a record snapshot before storing it.
 */
const ALWAYS_OMIT = new Set(['password', 'passwordHash', 'otp', 'otpExpiry', 'refreshToken', 'bankDetails', 'kycDocuments']);

const sanitizeSnapshot = (data, extraOmit = []) => {
  if (!data) return null;
  const omitSet = extraOmit.length ? new Set([...ALWAYS_OMIT, ...extraOmit]) : ALWAYS_OMIT;
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !omitSet.has(key))
  );
};

/**
 * Return the list of top-level keys whose values differ between two objects.
 * Uses JSON serialisation for deep equality — good enough for audit snapshots.
 */
const getChangedFields = (prev, next) => {
  if (!prev || !next) return [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter(k => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
};

/**
 * Extract actor + HTTP metadata from a Fastify request object.
 * Spread this directly into log(): ...extractRequestMeta(req)
 *
 * request.user shape (from authMiddleware.js): { userId, email, role }
 */
const extractRequestMeta = (req) => ({
  actor: req?.user
    ? { id: req.user.userId, email: req.user.email, role: req.user.role }
    : null,
  actorIp:   req?.ip ?? null,
  userAgent: req?.headers?.['user-agent'] ?? null,
  requestId: req?.headers?.['x-request-id'] ?? null,
});

// ─── CORE LOG WRITER ──────────────────────────────────────────────────────────

/**
 * Append one immutable entry to the audit_logs table.
 *
 * @param {object} params
 * @param {string}        params.entityType     - ENTITY_TYPES constant
 * @param {string}        params.entityId       - PK of the affected record
 * @param {string}        params.action         - AUDIT_ACTIONS constant
 * @param {{ id, email, role } | null} [params.actor]       - Who performed the action
 * @param {string|null}   [params.actorIp]      - Client IP (req.ip)
 * @param {string|null}   [params.userAgent]    - User-Agent header
 * @param {string|null}   [params.requestId]    - x-request-id header
 * @param {object|null}   [params.previousData] - Record snapshot BEFORE change
 * @param {object|null}   [params.newData]      - Record snapshot AFTER change
 * @param {string|null}   [params.reason]       - Optional human-readable note
 */
const log = async ({
  entityType,
  entityId,
  action,
  actor      = null,
  actorIp    = null,
  userAgent  = null,
  requestId  = null,
  previousData = null,
  newData      = null,
  reason     = null,
}) => {
  try {
    const sanitizedPrev = sanitizeSnapshot(previousData);
    const sanitizedNew  = sanitizeSnapshot(newData);
    const changedFields = getChangedFields(sanitizedPrev, sanitizedNew);

    await prisma.auditLog.create({
      data: {
        entityType,
        entityId:     String(entityId),
        action,
        actorId:      actor?.id    ?? null,
        actorEmail:   actor?.email ?? null,
        actorRole:    actor?.role  ?? 'SYSTEM',
        actorIp:      actorIp      ?? null,
        userAgent:    userAgent    ?? null,
        requestId:    requestId    ?? null,
        previousData: sanitizedPrev,
        newData:      sanitizedNew,
        changedFields,
        reason:       reason ?? null,
      },
    });
  } catch (err) {
    // Audit log failure must NEVER crash the main request
    console.error('[AuditLog] ❌ Failed to write audit log:', err.message);
    console.error('[AuditLog]    Entry attempted:', { entityType, entityId, action });
  }
};

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  log,
  extractRequestMeta,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
};
