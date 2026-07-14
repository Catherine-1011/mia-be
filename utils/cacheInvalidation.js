const { broadcastCacheInvalidation } = require('./stockSocket');

const ALLOWED_SCOPES = new Set(['products', 'blogs', 'coupons', 'checkout']);
const NEXT_CACHE_TAGS = new Set(['products', 'blogs']);

/**
 * Invalidate public storefront caches after a successful data mutation.
 * Failures are intentionally isolated from the completed business operation.
 */
async function invalidateCache(scope) {
  if (!ALLOWED_SCOPES.has(scope)) {
    console.warn(`[Cache invalidation] Ignoring unsupported scope: ${scope}`);
    return;
  }

  try {
    broadcastCacheInvalidation(scope);
  } catch (error) {
    console.error(`[Cache invalidation] Socket broadcast failed for ${scope}:`, error.message);
  }

  if (!NEXT_CACHE_TAGS.has(scope)) return;

  const secret = process.env.CACHE_REVALIDATION_SECRET;
  if (!secret) {
    console.warn(`[Cache invalidation] CACHE_REVALIDATION_SECRET is not configured; ${scope} will use TTL fallback`);
    return;
  }

  const frontendUrl = (process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au').replace(/\/$/, '');

  try {
    const response = await fetch(`${frontendUrl}/api/cache/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cache-revalidation-secret': secret,
      },
      body: JSON.stringify({ tag: scope }),
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      console.error(`[Cache invalidation] Next.js rejected ${scope} revalidation with status ${response.status}`);
    }
  } catch (error) {
    console.error(`[Cache invalidation] Next.js revalidation failed for ${scope}:`, error.message);
  }
}

module.exports = { invalidateCache };
