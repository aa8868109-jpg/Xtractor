const { createSessionToken, validateSessionToken } = require('./api/session');

const token = createSessionToken({ role: 'doctor', userCode: 'admin' });
const cookieReq = { headers: { cookie: 'xtractor_session=' + encodeURIComponent(token) } };
const authReq = { headers: { authorization: 'Bearer ' + token } };

const fromCookie = validateSessionToken(cookieReq);
const fromHeader = validateSessionToken(authReq);

if (!fromCookie || fromCookie.role !== 'doctor') {
  console.error('COOKIE_SESSION_INVALID', JSON.stringify(fromCookie));
  process.exit(1);
}

if (!fromHeader || fromHeader.role !== 'doctor') {
  console.error('HEADER_SESSION_INVALID', JSON.stringify(fromHeader));
  process.exit(1);
}

console.log('SESSION_OK', JSON.stringify({ role: fromCookie.role, expiresAt: fromCookie.expiresAt }));
