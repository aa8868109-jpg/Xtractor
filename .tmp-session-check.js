const s = require('./api/session');
const token = s.createSessionToken({ role: 'doctor', userCode: 'ABC123' });
const same = s.validateSessionToken({ headers: { cookie: 'xtractor_session=' + encodeURIComponent(token) } });
const auth = s.validateSessionToken({ headers: { authorization: 'Bearer ' + token } });
console.log(JSON.stringify({ same: !!same, sameRole: same && same.role, auth: !!auth, authRole: auth && auth.role }));
