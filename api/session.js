const crypto = require('crypto');

const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'xtractor_session';

function getSessionSecret() {
  const secret = process.env.XTRACTOR_SESSION_SECRET || process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('XTRACTOR_SESSION_SECRET must be configured in production');
  }
  return 'xtractor-local-dev-secret-change-me';
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function signToken(payload) {
  const encoded = toBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySignedToken(tokenValue) {
  if (!tokenValue || typeof tokenValue !== 'string') return null;

  const parts = tokenValue.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, suppliedSignature] = parts;
  if (!encodedPayload || !suppliedSignature) return null;

  const expectedSignature = crypto.createHmac('sha256', getSessionSecret()).update(encodedPayload).digest('base64url');
  const expectedBuf = Buffer.from(String(expectedSignature));
  const suppliedBuf = Buffer.from(String(suppliedSignature));

  if (expectedBuf.length !== suppliedBuf.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload || typeof payload !== 'object') return null;
    if (Date.now() > Number(payload.expiresAt || 0)) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

function createSessionToken(payload = {}) {
  const safePayload = {
    ...payload,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  return signToken(safePayload);
}

function getCookieValue(rawCookieHeader, name) {
  if (!rawCookieHeader) return null;
  const cookies = rawCookieHeader.split(';').map(part => part.trim());
  const match = cookies.find(item => item.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function validateSessionToken(req) {
  const authHeader = req?.headers?.authorization || req?.headers?.Authorization || req?.headers?.['x-xtractor-token'];
  const directToken = req?.query?.token || req?.body?.token;
  const cookieToken = getCookieValue(req?.headers?.cookie || req?.headers?.Cookie, SESSION_COOKIE_NAME);

  const headerToken = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  const tokenValue = headerToken || cookieToken || directToken;

  if (!tokenValue || typeof tokenValue !== 'string') {
    return null;
  }

  return verifySignedToken(tokenValue) || null;
}

module.exports = {
  SESSION_COOKIE_NAME,
  createSessionToken,
  validateSessionToken
};
