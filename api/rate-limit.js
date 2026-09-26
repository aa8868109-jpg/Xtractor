const RATE_LIMITS = new Map();

function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || req.headers?.['x-real-ip'] || 'unknown';
}

function checkRateLimit(req, res, options = {}) {
  const {
    endpoint = 'api',
    maxRequests = 60,
    windowMs = 60 * 1000,
    message = 'Too many requests'
  } = options;

  const key = `${endpoint}:${getClientIp(req)}`;
  const now = Date.now();
  const bucket = RATE_LIMITS.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  RATE_LIMITS.set(key, bucket);

  if (bucket.count > maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    console.warn('[rate-limit] blocked request', { endpoint, ip: getClientIp(req), count: bucket.count, retryAfter });
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate_limited', message, retryAfter });
    return false;
  }

  return true;
}

module.exports = {
  checkRateLimit
};
