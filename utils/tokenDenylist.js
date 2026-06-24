/**
 * tokenDenylist.js
 *
 * Maintains a denylist of invalidated JWT IDs (jti claims) so that tokens
 * belonging to logged-out users cannot be reused (e.g. to create SSO tickets).
 *
 * Strategy:
 *   • If REDIS_URL is set in the environment → persists in Redis (recommended
 *     for multi-instance deployments).  TTL is set to the token's remaining
 *     lifetime so Redis auto-evicts expired entries.
 *   • Otherwise → falls back to an in-memory Map with a periodic cleanup job.
 *     This survives only for the lifetime of the process but is sufficient for
 *     single-instance / development setups.
 */

const DENYLIST_PREFIX = 'jwt_deny:';

// ─── Redis backend ────────────────────────────────────────────────────────────
let redisClient = null;
let useRedis = false;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      // Disable ALL automatic reconnect attempts — we handle fallback ourselves
      retryStrategy: () => null,
      reconnectOnError: () => false,
      maxRetriesPerRequest: 0,
    });

    redisClient.on('connect', () => {
      useRedis = true;
    });

    // Only log once; then disconnect so ioredis never retries again
    redisClient.once('error', (err) => {
      console.warn(`⚠️  [TokenDenylist] Redis unavailable (${err.message}) — using in-memory fallback`);
      useRedis = false;
      // Fully shut down the client so no further reconnect/error events fire
      redisClient.disconnect();
      redisClient = null;
    });

    redisClient.connect().catch(() => {
      // Error already handled by the 'error' listener above
    });
  } catch (err) {
    console.warn('⚠️  [TokenDenylist] ioredis not available — using in-memory fallback');
  }
} else {
}

// ─── In-memory fallback ───────────────────────────────────────────────────────
// Map<jti, expiresAtMs>
const memoryDenylist = new Map();

// Cleanup expired entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [jti, expiresAt] of memoryDenylist) {
    if (now >= expiresAt) {
      memoryDenylist.delete(jti);
      removed++;
    }
  }
  if (removed > 0) {
  }
}, 15 * 60 * 1000).unref(); // unref so it doesn't block process exit

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a JWT ID to the denylist.
 *
 * @param {string} jti        - The jti claim from the JWT
 * @param {number} ttlSeconds - Time-to-live in seconds (= remaining token lifetime)
 */
async function addToBlacklist(jti, ttlSeconds) {
  if (!jti) return;
  const ttl = Math.max(1, Math.ceil(ttlSeconds)); // at least 1 second

  if (useRedis && redisClient) {
    try {
      await redisClient.set(`${DENYLIST_PREFIX}${jti}`, '1', 'EX', ttl);
      return;
    } catch (err) {
      console.error('⚠️  [TokenDenylist] Redis write failed — falling back to in-memory:', err.message);
    }
  }

  // In-memory fallback
  memoryDenylist.set(jti, Date.now() + ttl * 1000);
}

/**
 * Check whether a JWT ID is in the denylist.
 *
 * @param  {string}  jti
 * @returns {Promise<boolean>}
 */
async function isBlacklisted(jti) {
  if (!jti) return false;

  if (useRedis && redisClient) {
    try {
      const result = await redisClient.get(`${DENYLIST_PREFIX}${jti}`);
      return result !== null;
    } catch (err) {
      console.error('⚠️  [TokenDenylist] Redis read failed — falling back to in-memory:', err.message);
    }
  }

  // In-memory fallback
  const expiresAt = memoryDenylist.get(jti);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    memoryDenylist.delete(jti); // lazy eviction
    return false;
  }
  return true;
}

module.exports = { addToBlacklist, isBlacklisted };
