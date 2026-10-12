const crypto = require('crypto');
const { COURSE_NAMES, normalizeCourseName } = require('./course-policy');

const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'xtractor_session';
const DOCTOR_SESSION_COOKIE_PREFIX = 'xtractor_doctor_session_';

function getDoctorSessionCookieName(courseName) {
  const normalizedCourse = normalizeCourseName(courseName);
  const courseIndex = COURSE_NAMES.indexOf(normalizedCourse);
  return courseIndex < 0 ? null : `${DOCTOR_SESSION_COOKIE_PREFIX}${courseIndex}`;
}

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

  if (expectedBuf.length !== suppliedBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, suppliedBuf)) return null;

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload || typeof payload !== 'object') return null;
    if (Date.now() > Number(payload.expiresAt || 0)) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function createSessionToken(payload = {}) {
  const safePayload = { ...payload, expiresAt: Date.now() + SESSION_TTL_MS };
  return signToken(safePayload);
}

function getCookieValue(rawCookieHeader, name) {
  if (!rawCookieHeader) return null;
  const cookies = rawCookieHeader.split(';').map(part => part.trim());
  const match = cookies.find(item => item.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch (error) {
    return null;
  }
}

function validateSessionToken(req) {
  const authHeader = req?.headers?.authorization || req?.headers?.Authorization;
  const headerToken = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  const headers = req?.headers || {};
  const requestedCourse = headers['x-xtractor-session-course'] || headers['X-Xtractor-Session-Course'];
  if (headerToken) return verifySignedToken(headerToken) || null;

  const cookieHeader = headers.cookie || headers.Cookie;
  if (requestedCourse !== undefined) {
    const cookieName = getDoctorSessionCookieName(requestedCourse);
    if (!cookieName) return null;
    const scopedToken = getCookieValue(cookieHeader, cookieName);
    const scopedSession = verifySignedToken(scopedToken);
    return scopedSession?.role === 'doctor' &&
      normalizeCourseName(scopedSession.courseName) === normalizeCourseName(requestedCourse)
      ? scopedSession
      : null;
  }

  const tokenValue = getCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (!tokenValue || typeof tokenValue !== 'string') return null;
  return verifySignedToken(tokenValue) || null;
}

module.exports = {
  DOCTOR_SESSION_COOKIE_PREFIX,
  SESSION_COOKIE_NAME,
  createSessionToken,
  getCookieValue,
  getDoctorSessionCookieName,
  validateSessionToken
};