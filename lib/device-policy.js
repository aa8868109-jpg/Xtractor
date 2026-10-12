const crypto = require('crypto');

const DEVICE_COOKIE_NAME = 'xtractor_device';

function isValidDeviceFingerprint(value) {
  const fingerprint = String(value || '').trim();
  return fingerprint.length >= 40 && fingerprint.length <= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(fingerprint);
}

function hasFingerprintConflict(studentCodes, currentStudentCode) {
  const currentCode = String(currentStudentCode || '').trim();
  return studentCodes.some(code => {
    const normalizedCode = String(code || '').trim();
    return normalizedCode && normalizedCode !== currentCode;
  });
}

function createDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isValidDeviceToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function hashDeviceToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

function hasDeviceIdConflict(studentCodes, currentStudentCode) {
  return hasFingerprintConflict(studentCodes, currentStudentCode);
}

module.exports = {
  DEVICE_COOKIE_NAME,
  createDeviceToken,
  hasDeviceIdConflict,
  hasFingerprintConflict,
  hashDeviceToken,
  isValidDeviceFingerprint,
  isValidDeviceToken
};