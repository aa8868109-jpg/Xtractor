const crypto = require('crypto');

const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_STORE = global.__xtractorSessionStore || new Map();
global.__xtractorSessionStore = SESSION_STORE;
const SESSION_COOKIE_NAME = 'xtractor_session';

function makeToken() {
  return `xt_${crypto.randomBytes(24).toString('hex')}`;
}

function createSessionToken(payload = {}) {
  const token = makeToken();
  const safePayload = {
    ...payload,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  SESSION_STORE.set(token, safePayload);
  return token;
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
  const tokenValue = typeof authHeader === 'string'
    ? authHeader.replace(/^Bearer\s+/i, '').trim()
    : (cookieToken || directToken);

  if (!tokenValue || typeof tokenValue !== 'string') {
    return null;
  }

  const session = SESSION_STORE.get(tokenValue);
  if (!session) {
    return null;
  }

  if (Date.now() > Number(session.expiresAt || 0)) {
    SESSION_STORE.delete(tokenValue);
    return null;
  }

  return session;
}

module.exports = {
  SESSION_COOKIE_NAME,
  createSessionToken,
  validateSessionToken
};
