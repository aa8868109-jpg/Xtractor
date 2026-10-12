const crypto = require('crypto');

function safePasswordEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function findDoctorAccountMatches(documents, submittedPassword) {
  const matches = [];
  for (const document of documents || []) {
    const password = document?.data?.()?.Password;
    if (typeof password === 'string' && password.length > 0 && safePasswordEqual(submittedPassword, password)) {
      matches.push(String(document.id || '').trim());
    }
  }
  return matches.filter(Boolean);
}

module.exports = { findDoctorAccountMatches };