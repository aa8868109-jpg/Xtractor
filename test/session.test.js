const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionToken, validateSessionToken } = require('../lib/session');

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