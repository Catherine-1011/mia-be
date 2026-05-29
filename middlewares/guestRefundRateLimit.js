const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 5;

const ipBuckets = new Map();

const getClientIp = (request) => {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return request.ip || request.socket?.remoteAddress || 'unknown';
};

const guestRefundRateLimit = async (request, reply) => {
  const ip = getClientIp(request);
  const now = Date.now();

  const existing = ipBuckets.get(ip) || [];
  const validTimestamps = existing.filter(ts => now - ts < WINDOW_MS);

  if (validTimestamps.length >= MAX_REQUESTS) {
    return reply.status(429).send({
      success: false,
      message: 'Too many requests. Please try again in a minute.'
    });
  }

  validTimestamps.push(now);
  ipBuckets.set(ip, validTimestamps);

  if (ipBuckets.size > 10000) {
    const cutoff = now - WINDOW_MS;
    for (const [key, timestamps] of ipBuckets.entries()) {
      const filtered = timestamps.filter(ts => ts > cutoff);
      if (filtered.length === 0) {
        ipBuckets.delete(key);
      } else {
        ipBuckets.set(key, filtered);
      }
    }
  }
};

module.exports = guestRefundRateLimit;