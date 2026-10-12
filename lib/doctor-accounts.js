const crypto = require('crypto');
const { normalizeCourseName } = require('./course-policy');

function safePasswordEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function findDoctorAccountMatches(documents, submittedPassword) {
  const matches = [];
  for (const document of documents || []) {
    const account = document?.data?.() || {};
    const password = account.Password;
    if (typeof password === 'string' && password.length > 0 && safePasswordEqual(submittedPassword, password)) {
      matches.push({
        doctorName: String(document.id || '').trim(),
        courseName: normalizeCourseName(account.Course_Name ?? account['Course Name'])
      });
    }
  }
  return matches.filter(Boolean);
}

module.exports = { findDoctorAccountMatches };