const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');

const FIRST_STAGE_FAILURES = 3;
const SECOND_STAGE_FAILURES = 3;
const FIRST_BLOCK_MS = 5 * 60 * 1000;
const FINAL_BLOCK_MS = 24 * 60 * 60 * 1000;

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

function hashValue(value, purpose) {
  return crypto
    .createHmac('sha256', getIdentifierHashKey())
    .update(`${purpose}:${String(value || '').trim().toLowerCase()}`)
    .digest('hex');
}

function hashLoginIdentifier(identifier) {
  return hashValue(identifier, 'login-identifier');
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
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function getIpLimitRef(db, ip) {
  return db.collection('LOGIN_IP_LIMITS').doc(hashValue(ip, 'login-ip'));
}

function getBlacklistRef(db, ip) {
  return db.collection('Blacklist').doc(hashValue(ip, 'blacklist-ip'));
}

function getCurrentStage(data = {}, now = Date.now()) {
  const blockedUntil = timestampToMs(data.blockedUntil);
  if (Number.isFinite(blockedUntil) && blockedUntil > now) {
    return { stage: Number(data.stage) === 2 ? 2 : 1, failureCount: Number(data.failureCount) || 0, blockedUntil };
  }

  if (Number.isFinite(blockedUntil)) {
    if (Number(data.stage) === 1) return { stage: 2, failureCount: 0, blockedUntil: null };
    return { stage: 1, failureCount: 0, blockedUntil: null };
  }

  return {
    stage: Number(data.stage) === 2 ? 2 : 1,
    failureCount: Number(data.failureCount) || 0,
    blockedUntil: null
  };
}

async function checkLoginRateLimit(db, req, identifier, options = {}) {
  const now = options.now ?? Date.now();
  const identifierHash = hashLoginIdentifier(identifier);
  const ip = getRequestIp(req);
  const limitRef = getIpLimitRef(db, ip);
  const blacklistRef = getBlacklistRef(db, ip);
  let result = { allowed: true, identifierHash };

  await db.runTransaction(async transaction => {
    const [snapshot, blacklistSnapshot] = await Promise.all([
      transaction.get(limitRef),
      transaction.get(blacklistRef)
    ]);

    if (blacklistSnapshot.exists) {
      const expiresAt = timestampToMs(blacklistSnapshot.data().expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > now) {
        result = {
          allowed: false,
          identifierHash,
          reason: 'ip_24_hour_block',
          retryAfter: Math.max(1, Math.ceil((expiresAt - now) / 1000))
        };
        return;
      }
      transaction.delete(blacklistRef);
    }

    if (!snapshot.exists) return;

    const current = getCurrentStage(snapshot.data(), now);
    if (current.blockedUntil) {
      result = {
        allowed: false,
        identifierHash,
        reason: current.stage === 2 ? 'ip_24_hour_block' : 'ip_5_minute_block',
        retryAfter: Math.max(1, Math.ceil((current.blockedUntil - now) / 1000))
      };
      return;
    }

    transaction.set(limitRef, {
      stage: current.stage,
      failureCount: current.failureCount,
      blockedUntil: null
    });
  });

  return result;
}

async function recordLoginAttempt(
  db,
  req,
  identifier,
  success,
  identifierHash = null,
  countFailure = success === false,
  options = {}
) {
  const now = options.now ?? Date.now();
  const ip = getRequestIp(req);
  const headers = req.headers || {};
  const userAgent = headers['user-agent'] || headers['User-Agent'] || '';
  const attemptRef = db.collection('LOGIN').doc();
  const limitRef = getIpLimitRef(db, ip);
  const blacklistRef = getBlacklistRef(db, ip);
  const attempt = {
    IP: ip,
    Identifier: identifierHash || hashLoginIdentifier(identifier),
    Stutes: success === true,
    Time: FieldValue.serverTimestamp(),
    'User Agent': String(userAgent).slice(0, 512)
  };

  if (!success && !countFailure) {
    await attemptRef.set(attempt);
    return;
  }

  await db.runTransaction(async transaction => {
    const [snapshot, blacklistSnapshot] = await Promise.all([
      transaction.get(limitRef),
      transaction.get(blacklistRef)
    ]);
    transaction.set(attemptRef, attempt);

    if (success) {
      if (snapshot.exists) transaction.delete(limitRef);
      if (blacklistSnapshot.exists) transaction.delete(blacklistRef);
      return;
    }

    if (blacklistSnapshot.exists) {
      const blacklistExpiresAt = timestampToMs(blacklistSnapshot.data().expiresAt);
      if (Number.isFinite(blacklistExpiresAt) && blacklistExpiresAt > now) return;
      transaction.delete(blacklistRef);
    }

    const current = getCurrentStage(snapshot.exists ? snapshot.data() : {}, now);
    if (current.blockedUntil) return;

    const failureCount = current.failureCount + 1;
    const maximum = current.stage === 1 ? FIRST_STAGE_FAILURES : SECOND_STAGE_FAILURES;
    const blockDuration = current.stage === 1 ? FIRST_BLOCK_MS : FINAL_BLOCK_MS;
    const blockedUntil = failureCount >= maximum ? new Date(now + blockDuration) : null;
    transaction.set(limitRef, {
      stage: current.stage,
      failureCount,
      blockedUntil
    });
    if (current.stage === 2 && blockedUntil) {
      transaction.set(blacklistRef, {
        IP: ip,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: blockedUntil,
        reason: 'six_failed_login_attempts'
      });
    }
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
  identifierHash = null,
  countFailure = status === 401
) {
  try {
    await recordLoginAttempt(db, req, identifier, success, identifierHash, countFailure);
  } catch (error) {
    console.error('Login attempt audit write failed:', error.message || error);
    return res.status(503).json({ error: 'login_audit_unavailable' });
  }

  if (typeof beforeResponse === 'function') beforeResponse();
  return res.status(status).json(body);
}

module.exports = {
  FIRST_BLOCK_MS,
  FIRST_STAGE_FAILURES,
  FINAL_BLOCK_MS,
  SECOND_STAGE_FAILURES,
  checkLoginRateLimit,
  hashLoginIdentifier,
  recordLoginAttempt,
  respondToLogin
};
