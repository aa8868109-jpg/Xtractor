const { getModeActiveCourse, getModeCourseLecture, normalizeCourseName } = require('./course-policy');

function validateStudentPatch({ collection, session, documentId, currentRecord, modeRecord, fields, qrToken }) {
  const liveQrMaxAgeMs = 10000;
  if (!/^LEC_\d+$/.test(collection)) return 'student_forbidden_collection';
  if (Number(session.lecture) !== Number(collection.slice(4))) return 'student_forbidden_lecture';

  const data = currentRecord?.data?.() || {};
  const courseName = normalizeCourseName(session.courseName);
  if (!courseName) return 'student_course_not_configured';
  const recordCode = String(data.Code || currentRecord?.id || '').trim();
  if (recordCode !== String(session.userCode || '').trim() || String(documentId) !== String(currentRecord?.id)) {
    return 'student_forbidden_record';
  }

  const fieldNames = Object.keys(fields || {});
  if (fieldNames.length === 0 || fieldNames.some(key => ![courseName, 'Location'].includes(key))) {
    return 'student_forbidden_fields';
  }

  if (fields[courseName] !== undefined) {
    if (fields[courseName] !== true) return 'student_invalid_attendance_value';
    const mode = modeRecord || {};
    const modeEnabled = mode.Student_Mode === true || String(mode.Student_Mode || '').toLowerCase() === 'on';
    const activeLecture = getModeCourseLecture(mode, courseName);
    const activeCourse = getModeActiveCourse(mode);
    const token = String(qrToken || '').trim();
    if (!modeEnabled || activeLecture !== Number(session.lecture)) return 'student_attendance_disabled';
    if (activeCourse && activeCourse !== courseName) return 'student_course_mismatch';
    if (!token || token.length > 256 || !token.startsWith('XTRACTOR-') || mode.QR_Selected !== token) {
      return 'student_invalid_live_qr';
    }
    const issuedAtMatch = token.match(/^XTRACTOR-(\d{13})-/);
    const issuedAt = Number(issuedAtMatch?.[1]);
    const tokenAge = Date.now() - issuedAt;
    if (!issuedAtMatch || tokenAge < -30000 || tokenAge > liveQrMaxAgeMs) return 'student_expired_live_qr';
  }

  if (fields.Location !== undefined && (typeof fields.Location !== 'string' || fields.Location.length > 500)) {
    return 'student_invalid_location';
  }

  return null;
}

module.exports = { validateStudentPatch };