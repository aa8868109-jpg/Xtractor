const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSessionToken,
  getCookieValue,
  getDoctorSessionCookieName,
  validateSessionToken
} = require('../lib/session');
const { COURSE_NAMES } = require('../lib/course-policy');

test('validates session tokens from cookies and bearer headers', () => {
  const token = createSessionToken({ role: 'doctor' });
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  const cookieSession = validateSessionToken({
    headers: { cookie: `xtractor_session=${encodeURIComponent(token)}` }
  });
  const bearerSession = validateSessionToken({
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(cookieSession?.role, 'doctor');
  assert.equal(bearerSession?.role, 'doctor');
  assert.equal(payload.userCode, undefined);
});

test('rejects modified session tokens', () => {
  const token = createSessionToken({ role: 'student', userCode: 'test-student' });
  const modifiedToken = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  const session = validateSessionToken({
    headers: { authorization: `Bearer ${modifiedToken}` }
  });

  assert.equal(session, null);
});

test('does not accept session tokens from query or request bodies', () => {
  const token = createSessionToken({ role: 'doctor' });
  assert.equal(validateSessionToken({ query: { token }, headers: {} }), null);
  assert.equal(validateSessionToken({ body: { token }, headers: {} }), null);
  assert.equal(validateSessionToken({ headers: { 'x-xtractor-token': token } }), null);
});

test('requires a session secret in production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.XTRACTOR_SESSION_SECRET;
  const previousLegacySecret = process.env.SESSION_SECRET;
  process.env.NODE_ENV = 'production';
  delete process.env.XTRACTOR_SESSION_SECRET;
  delete process.env.SESSION_SECRET;

  try {
    assert.throws(
      () => createSessionToken({ role: 'doctor' }),
      /XTRACTOR_SESSION_SECRET must be configured in production/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.XTRACTOR_SESSION_SECRET;
    else process.env.XTRACTOR_SESSION_SECRET = previousSecret;
    if (previousLegacySecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousLegacySecret;
  }
});

test('malformed cookie encoding is rejected without throwing', () => {
  assert.equal(getCookieValue('xtractor_session=%E0%A4%A', 'xtractor_session'), null);
});

test('doctor tabs select independent course-scoped sessions', () => {
  const economics = COURSE_NAMES[2];
  const accounting = COURSE_NAMES[1];
  const economicsCookie = getDoctorSessionCookieName(economics);
  const accountingCookie = getDoctorSessionCookieName(accounting);
  const economicsToken = createSessionToken({
    role: 'doctor',
    doctorName: 'Economics Doctor',
    courseName: economics
  });
  const accountingToken = createSessionToken({
    role: 'doctor',
    doctorName: 'Accounting Doctor',
    courseName: accounting
  });
  const cookies = `${economicsCookie}=${encodeURIComponent(economicsToken)}; ${accountingCookie}=${encodeURIComponent(accountingToken)}`;

  const economicsSession = validateSessionToken({
    headers: { cookie: cookies, 'x-xtractor-session-course': String(COURSE_NAMES.indexOf(economics)) }
  });
  const accountingSession = validateSessionToken({
    headers: { cookie: cookies, 'x-xtractor-session-course': String(COURSE_NAMES.indexOf(accounting)) }
  });
  const mismatchedSession = validateSessionToken({
    headers: { cookie: cookies, 'x-xtractor-session-course': String(COURSE_NAMES.indexOf('مبادئ قانون')) }
  });
  const invalidSession = validateSessionToken({
    headers: { cookie: cookies, 'x-xtractor-session-course': '999' }
  });

  assert.equal(economicsSession?.courseName, economics);
  assert.equal(accountingSession?.courseName, accounting);
  assert.equal(mismatchedSession, null);
  assert.equal(invalidSession, null);
  assert.notEqual(economicsCookie, accountingCookie);
});