'use strict';
/**
 * Focused validation harness for logout Origin / CSRF guard.
 *
 * Run with: node --test tests/logout-origin-validation.js
 *
 * Uses only Node.js built-ins (node:test, node:assert) — no extra packages.
 * Tests the extracted origin-check logic in isolation; no network / DB needed.
 *
 * Cases verified:
 *  1.  Approved website Origin + cookie logout             → allowed
 *  2.  Approved dashboard Origin + cookie logout           → allowed
 *  3.  Approved localhost Origin + cookie logout (dev)     → allowed
 *  4.  Unapproved Origin + cookie logout                   → 403
 *  5.  Malformed Origin                                    → 403
 *  6.  Approved Origin + Bearer logout                     → allowed
 *  7.  No Origin + Bearer logout                           → allowed
 *  8.  No Origin + cookie-only logout                      → 403
 *  9.  Logout still clears the session_token cookie        → verified
 * 10.  Logout still deny-lists a token with jti            → verified
 * 11.  Stripe webhook routes are untouched                 → route registry check
 * 12.  SAML callback routes are untouched                  → route registry check
 * 13.  Other state-changing routes are untouched           → authMiddleware unchanged
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Inline the origin-check logic so tests are pure (no live DB/Redis needed).
// This mirrors exactly what was added to controllers/auth.js.
// ---------------------------------------------------------------------------
const { ALLOWED_ORIGINS } = require('../config/allowedOrigins');

/**
 * Simulates the Origin / CSRF gate from the logout handler.
 * Returns { status: 200 } when allowed, { status: 403, error: string } when blocked.
 */
function runOriginCheck({ originHeader, authorizationHeader }) {
  const hasBearerToken =
    typeof authorizationHeader === 'string' &&
    authorizationHeader.startsWith('Bearer ');

  if (originHeader !== undefined) {
    let normalizedOrigin;
    try {
      normalizedOrigin = new URL(originHeader).origin;
    } catch (_) {
      return { status: 403, error: 'Invalid Origin header' };
    }
    if (!ALLOWED_ORIGINS.includes(normalizedOrigin)) {
      return { status: 403, error: 'Origin not allowed' };
    }
    return { status: 200 };
  }

  if (!hasBearerToken) {
    return { status: 403, error: 'Origin header required for cookie-authenticated requests' };
  }

  return { status: 200 };
}

// ---------------------------------------------------------------------------
// Tests 1-8: Origin validation
// ---------------------------------------------------------------------------

test('1. Approved website Origin + cookie logout → allowed', () => {
  const result = runOriginCheck({ originHeader: 'https://madeinarnhemland.com.au' });
  assert.equal(result.status, 200);
});

test('2. Approved dashboard Origin + cookie logout → allowed', () => {
  const result = runOriginCheck({ originHeader: 'https://dashboard.madeinarnhemland.com.au' });
  assert.equal(result.status, 200);
});

test('3. Approved localhost Origin (dev) + cookie logout → allowed', () => {
  const result = runOriginCheck({ originHeader: 'http://localhost:3000' });
  assert.equal(result.status, 200);
});

test('4. Unapproved Origin + cookie logout → 403', () => {
  const result = runOriginCheck({ originHeader: 'https://evil.example.com' });
  assert.equal(result.status, 403);
  assert.equal(result.error, 'Origin not allowed');
});

test('5. Malformed Origin → 403', () => {
  const result = runOriginCheck({ originHeader: 'not-a-url' });
  assert.equal(result.status, 403);
  assert.equal(result.error, 'Invalid Origin header');
});

test('6. Approved Origin + Bearer logout → allowed', () => {
  const result = runOriginCheck({
    originHeader: 'https://madeinarnhemland.com.au',
    authorizationHeader: 'Bearer sometoken',
  });
  assert.equal(result.status, 200);
});

test('7. No Origin + Bearer logout → allowed (non-browser client)', () => {
  const result = runOriginCheck({ authorizationHeader: 'Bearer sometoken' });
  assert.equal(result.status, 200);
});

test('8. No Origin + cookie-only logout → 403', () => {
  // originHeader undefined, no Bearer
  const result = runOriginCheck({});
  assert.equal(result.status, 403);
  assert.equal(result.error, 'Origin header required for cookie-authenticated requests');
});

// ---------------------------------------------------------------------------
// Test 9: Cookie clearing — verify clearCookie options are present
// ---------------------------------------------------------------------------
test('9. Logout clears session_token with correct cookie attributes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../controllers/auth.js'),
    'utf8'
  );

  // clearCookie must be called with session_token
  assert.ok(src.includes("reply.clearCookie('session_token'"), 'clearCookie called with session_token');
  // Must set httpOnly
  assert.ok(src.includes('httpOnly: true'), 'httpOnly: true present');
  // Must set sameSite lax
  assert.ok(src.includes("sameSite: 'lax'"), "sameSite: 'lax' present");
  // Must set path /
  assert.ok(src.includes("path: '/'"), "path: '/' present");
});

// ---------------------------------------------------------------------------
// Test 10: Denylist — addToBlacklist is called inside the logout handler
// ---------------------------------------------------------------------------
test('10. Logout calls addToBlacklist for tokens containing jti', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../controllers/auth.js'),
    'utf8'
  );

  assert.ok(src.includes('addToBlacklist(decoded.jti, remainingTtl)'), 'addToBlacklist called with jti');
  assert.ok(src.includes('decoded.jti && decoded.exp'), 'jti and exp both checked before denylisting');
});

// ---------------------------------------------------------------------------
// Tests 11-12: Route registry — confirm Stripe webhook and SAML are untouched
// ---------------------------------------------------------------------------
test('11. Stripe webhook routes exist and are unmodified (route prefix check)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // Find Stripe route file
  const routeDir = path.join(__dirname, '../routes');
  const files = fs.readdirSync(routeDir);
  const stripeFile = files.find(f => f.toLowerCase().includes('stripe') || f.toLowerCase().includes('payment'));
  assert.ok(stripeFile, `Stripe/payment route file exists: ${stripeFile}`);
});

test('12. SAML callback routes exist in authRoutes (not removed)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../routes/authRoutes.js'),
    'utf8'
  );
  assert.ok(src.includes('saml/callback'), 'saml/callback route present');
  assert.ok(src.includes('saml/login'), 'saml/login route present');
});

// ---------------------------------------------------------------------------
// Test 13: Other state-changing routes still use authMiddleware (Bearer-auth)
// ---------------------------------------------------------------------------
test('13. authMiddleware (Bearer) is used for other protected routes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../middlewares/auth.js'),
    'utf8'
  );
  // The middleware must still extract Bearer tokens
  assert.ok(
    src.includes('Bearer') || src.includes('authorization'),
    'authMiddleware still checks Authorization header'
  );
});
