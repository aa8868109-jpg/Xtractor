const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_IDENTIFIER = 6;

function getIdentifierHashKey() {
  if (process.env.LOGIN_IDENTIFIER_HMAC_KEY) {
    return process.env.LOGIN_IDENTIFIER_HMAC_KEY;
  }

  if (process.env.FIREBASE_PRIVATE_KEY) {
    return process.env.FIREBASE_PRIVATE_KEY;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (typeof serviceAccount === 'string') serviceAccount = JSON.parse(serviceAccount);
    if (serviceAccount.private_key) return serviceAccount.private_key;
  }

  throw new Error('Login identifier HMAC key is not configured');
}

function hashLoginIdentifier(identifier) {
  return crypto
    .createHmac('sha256', getIdentifierHashKey())
    .update(String(identifier || '').trim().toLowerCase())
    .digest('hex');
}

function getRequestIp(req = {}) {
  const headers = req.headers || {};
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  const direct = headers['x-real-ip'] || headers['X-Real-IP'] ||
    headers['cf-connecting-ip'] || headers['CF-Connecting-IP'];
  const ip = direct || (typeof forwarded === 'string' && forwarded.trim()
    ? forwarded.split(',')[0].trim()
    : req.socket?.remoteAddress || 'Unknown');
  return String(ip).replace(/^::ffff:/, '').trim() || 'Unknown';
}

function timestampToMs(timestamp) {
  if (timestamp && typeof timestamp.toDate === 'function') return timestamp.toDate().getTime();
  if (timestamp instanceof Date) return timestamp.getTime();
  return Number.NaN;
}

async function getRecentFailures(db, field, value, maxFailures, windowMs, now) {
  const snapshot = await db.collection('LOGIN')
    .where(field, '==', value)
    .where('Time', '>=', new Date(now - windowMs))
    .orderBy('Time', 'desc')
    .limit(maxFailures)
    .get();

  let failureCount = 0;
  let oldestFailureAt = null;
  for (const document of snapshot.docs) {
    const attempt = document.data();
    if (attempt.Stutes === true) break;
    if (attempt.Stutes !== false) continue;
    failureCount += 1;
    oldestFailureAt = timestampToMs(attempt.Time);
  }

  return { failureCount, oldestFailureAt };
}

async function checkLoginRateLimit(db, req, identifier, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
  const maxIpFailures = options.maxIpFailures ?? MAX_FAILURES_PER_IP;
  const maxIdentifierFailures = options.maxIdentifierFailures ?? MAX_FAILURES_PER_IDENTIFIER;
  const ip = getRequestIp(req);
  const identifierHash = hashLoginIdentifier(identifier);

  const [ipResult, identifierResult] = await Promise.all([
    getRecentFailures(db, 'IP', ip, maxIpFailures, windowMs, now),
    getRecentFailures(db, 'Identifier', identifierHash, maxIdentifierFailures, windowMs, now)
  ]);

  const limited = [
    { ...ipResult, reason: 'ip', maximum: maxIpFailures },
    { ...identifierResult, reason: 'identifier', maximum: maxIdentifierFailures }
  ].filter(result => result.failureCount >= result.maximum);

  if (limited.length === 0) return { allowed: true, identifierHash };

  const retryAfter = Math.max(...limited.map(result => {
    const expiresAt = result.oldestFailureAt + windowMs;
    return Number.isFinite(expiresAt)
      ? Math.max(1, Math.ceil((expiresAt - now) / 1000))
      : Math.ceil(windowMs / 1000);
  }));
  return {
    allowed: false,
    identifierHash,
    reason: limited.some(result => result.reason === 'ip') ? 'ip' : 'identifier',
    retryAfter
  };
}

async function recordLoginAttempt(db, req, identifier, success, identifierHash = null) {
  const headers = req.headers || {};
  const userAgent = headers['user-agent'] || headers['User-Agent'] || '';
  await db.collection('LOGIN').add({
    IP: getRequestIp(req),
    Identifier: identifierHash || hashLoginIdentifier(identifier),
    Stutes: success === true,
    Time: FieldValue.serverTimestamp(),
    'User Agent': String(userAgent).slice(0, 512)
  });
}

async function respondToLogin(
  db,
  req,
  res,
  identifier,
  status,
  body,
  success = false,
  beforeResponse = null,
  identifierHash = null
) {
  try {
    await recordLoginAttempt(db, req, identifier, success, identifierHash);
  } catch (error) {
    console.error('Login attempt audit write failed:', error.message || error);
    return res.status(503).json({ error: 'login_audit_unavailable' });
  }

  if (typeof beforeResponse === 'function') beforeResponse();
  return res.status(status).json(body);
}

module.exports = {
  LOGIN_WINDOW_MS,
  MAX_FAILURES_PER_IDENTIFIER,
  MAX_FAILURES_PER_IP,
  checkLoginRateLimit,
  hashLoginIdentifier,
  recordLoginAttempt,
  respondToLogin
};
