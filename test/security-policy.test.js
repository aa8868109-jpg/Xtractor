const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const { enforceSameOrigin } = require('../lib/request-security');
const { validateStudentPatch } = require('../lib/data-policy');
const {
  createDeviceToken,
  hasDeviceIdConflict,
  hasFingerprintConflict,
  hashDeviceToken,
  isValidDeviceFingerprint,
  isValidDeviceToken
} = require('../lib/device-policy');
const { findDoctorAccountMatches } = require('../lib/doctor-accounts');

const workspaceRoot = path.join(__dirname, '..');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('same-origin browser writes pass and cross-origin writes are rejected', () => {
  const sameOriginResponse = createResponse();
  const sameOriginAllowed = enforceSameOrigin({
    method: 'PATCH',
    headers: { origin: 'https://attendance.example', host: 'attendance.example', 'x-forwarded-proto': 'https' }
  }, sameOriginResponse);
  assert.equal(sameOriginAllowed, true);

  const crossOriginResponse = createResponse();
  const crossOriginAllowed = enforceSameOrigin({
    method: 'PATCH',
    headers: { origin: 'https://attacker.example', host: 'attendance.example', 'x-forwarded-proto': 'https' }
  }, crossOriginResponse);
  assert.equal(crossOriginAllowed, false);
  assert.equal(crossOriginResponse.statusCode, 403);
});

test('cookie-authenticated writes without Origin are rejected', () => {
  const response = createResponse();
  const allowed = enforceSameOrigin({ method: 'POST', headers: { cookie: 'xtractor_session=token' } }, response);
  assert.equal(allowed, false);
  assert.equal(response.body.error, 'origin_required');
});

test('students can only mark their own current lecture with the active live QR', () => {
  const liveQr = `XTRACTOR-${Date.now()}-abc12345-xy99`;
  const request = {
    collection: 'LEC_4',
    session: { role: 'student', userCode: 'S-4', lecture: 4 },
    documentId: 'S-4',
    currentRecord: { id: 'S-4', data: () => ({ Code: 'S-4' }) },
    modeRecord: { Student_Mode: true, Lecture: 4, QR_Selected: liveQr },
    fields: { Qr_Live: true },
    qrToken: liveQr
  };

  assert.equal(validateStudentPatch(request), null);
  assert.equal(validateStudentPatch({ ...request, qrToken: 'XTRACTOR-1234567890123-abc12345-xy99' }), 'student_invalid_live_qr');
  const expiredQr = `XTRACTOR-${Date.now() - 15000}-abc12345-xy99`;
  assert.equal(validateStudentPatch({
    ...request,
    modeRecord: { ...request.modeRecord, QR_Selected: expiredQr },
    qrToken: expiredQr
  }), 'student_expired_live_qr');
  assert.equal(validateStudentPatch({ ...request, fields: { Qr_Live: true, Code: 'S-4' } }), 'student_forbidden_fields');
  assert.equal(validateStudentPatch({ ...request, documentId: 'S-5' }), 'student_forbidden_record');
  assert.equal(validateStudentPatch({ ...request, collection: 'LEC_5' }), 'student_forbidden_lecture');
});

test('CSP disallows dynamic and inline scripts and HTML has no inline handlers', () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'vercel.json'), 'utf8'));
  const csp = vercelConfig.headers[0].headers.find(header => header.key === 'Content-Security-Policy')?.value || '';
  const html = fs.readFileSync(path.join(workspaceRoot, 'index.html'), 'utf8');

  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(html, /\son(?:click|input|change|submit)\s*=/i);
  assert.doesNotMatch(html, /<script\s*>/i);
});

test('Firestore client security rules deny all direct client access', () => {
  const rules = fs.readFileSync(path.join(workspaceRoot, 'firestore.rules'), 'utf8');
  assert.match(rules, /rules_version\s*=\s*'2'/);
  assert.match(rules, /allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;/);
  assert.doesNotMatch(rules, /allow\s+read\s*,\s*write\s*:\s*if\s+true\s*;/);
});

test('a device fingerprint cannot be reused across student codes, even on the same IP', () => {
  const currentCode = 'S-2';
  const matchingDeviceStudentCodes = ['S-1', 'S-2'];
  assert.equal(hasFingerprintConflict(matchingDeviceStudentCodes, currentCode), true);
  assert.equal(hasFingerprintConflict(['S-2', 'S-2'], currentCode), false);
});

test('rejects short or malformed client-provided device fingerprints', () => {
  assert.equal(isValidDeviceFingerprint('dGVzdHN0dWRlbnQ='), false);
  assert.equal(isValidDeviceFingerprint('x'.repeat(64)), true);
  assert.equal(isValidDeviceFingerprint('!'.repeat(64)), false);
});

test('device binding uses a random opaque cookie and stores only its hash', () => {
  const deviceToken = createDeviceToken();
  const deviceHash = hashDeviceToken(deviceToken);
  assert.equal(isValidDeviceToken(deviceToken), true);
  assert.equal(deviceToken.length, 43);
  assert.notEqual(deviceHash, deviceToken);
  assert.equal(hashDeviceToken(deviceToken), deviceHash);
  assert.equal(hasDeviceIdConflict(['S-1'], 'S-2'), true);
  assert.equal(hasDeviceIdConflict(['S-2'], 'S-2'), false);
});

test('doctor authentication resolves exactly the document matching its Password field', () => {
  const documents = [
    { id: 'Dr Ehab Younes', data: () => ({ Password: 'secret-one' }) },
    { id: 'Dr Other', data: () => ({ Password: 'secret-two' }) }
  ];
  assert.deepEqual(findDoctorAccountMatches(documents, 'secret-one'), ['Dr Ehab Younes']);
  assert.deepEqual(findDoctorAccountMatches(documents, 'wrong-password'), []);
  assert.deepEqual(findDoctorAccountMatches([
    ...documents,
    { id: 'Dr Duplicate', data: () => ({ Password: 'secret-one' }) }
  ], 'secret-one'), ['Dr Ehab Younes', 'Dr Duplicate']);
});