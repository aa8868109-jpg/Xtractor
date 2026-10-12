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
const {
  buildAttendanceSummary,
  buildCourseModeUpdates,
  buildCourseAttendanceRecords,
  getCourseQrFieldName,
  getCourseStorageFieldName,
  getModeCourseMap,
  normalizeCourseName
} = require('../lib/course-policy');

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
  const liveQr = `XTRACTOR-${Date.now()}-C0-abc12345-xy99`;
  const courseName = 'مبادئ قانون';
  const request = {
    collection: 'LEC_4',
    session: { role: 'student', userCode: 'S-4', lecture: 4, courseName },
    documentId: 'S-4',
    currentRecord: { id: 'S-4', data: () => ({ Code: 'S-4' }) },
    modeRecord: {
      Student_Mode: true,
      [courseName]: 4,
      QR_Selected: liveQr,
      [getCourseQrFieldName(courseName)]: liveQr
    },
    fields: { [courseName]: true },
    qrToken: liveQr
  };

  assert.equal(validateStudentPatch(request), null);
  assert.equal(validateStudentPatch({ ...request, qrToken: 'XTRACTOR-1234567890123-abc12345-xy99' }), 'student_invalid_live_qr');
  const expiredQr = `XTRACTOR-${Date.now() - 25000}-abc12345-xy99`;
  assert.equal(validateStudentPatch({
    ...request,
    modeRecord: {
      ...request.modeRecord,
      QR_Selected: expiredQr,
      [getCourseQrFieldName(courseName)]: expiredQr
    },
    qrToken: expiredQr
  }), 'student_expired_live_qr');
  assert.equal(validateStudentPatch({ ...request, fields: { [courseName]: true, Code: 'S-4' } }), 'student_forbidden_fields');
  assert.equal(validateStudentPatch({ ...request, documentId: 'S-5' }), 'student_forbidden_record');
  assert.equal(validateStudentPatch({ ...request, collection: 'LEC_5' }), 'student_forbidden_lecture');
  assert.equal(validateStudentPatch({ ...request, fields: { 'مبادئ اقتصاد': true } }), 'student_forbidden_fields');
  assert.equal(validateStudentPatch({ ...request, modeRecord: { ...request.modeRecord, [courseName]: 5 } }), 'student_attendance_disabled');
});

test('per-course MODE lecture values support multiple concurrent doctor sessions', () => {
  const liveQr = `XTRACTOR-${Date.now()}-C3-abc12345-xy99`;
  const courseName = 'إدارة أعمال';
  const request = {
    collection: 'LEC_5',
    session: { role: 'student', userCode: 'S-20', lecture: 5, courseName },
    documentId: 'S-20',
    currentRecord: { id: 'S-20', data: () => ({ Code: 'S-20' }) },
    modeRecord: {
      Student_Mode: true,
      'إدارة أعمال': '5',
      'مبادئ قانون': '3',
      QR_Selected: liveQr,
      [getCourseQrFieldName(courseName)]: liveQr
    },
    fields: { [courseName]: true },
    qrToken: liveQr
  };

  assert.equal(validateStudentPatch(request), null);
  assert.equal(validateStudentPatch({
    ...request,
    modeRecord: { ...request.modeRecord, 'إدارة أعمال': '6' }
  }), 'student_attendance_disabled');
  assert.equal(validateStudentPatch({
    ...request,
    modeRecord: { ...request.modeRecord, 'مبادئ قانون': '7' }
  }), null);
  assert.equal(validateStudentPatch({
    ...request,
    qrToken: `XTRACTOR-${Date.now()}-C0-abc12345-xy99`,
    modeRecord: {
      ...request.modeRecord,
      [getCourseQrFieldName(courseName)]: `XTRACTOR-${Date.now()}-C0-abc12345-xy99`
    }
  }), 'student_invalid_live_qr');
  const { [getCourseQrFieldName(courseName)]: scopedQr, ...unscopedMode } = request.modeRecord;
  assert.equal(scopedQr, liveQr);
  assert.equal(validateStudentPatch({
    ...request,
    modeRecord: unscopedMode
  }), 'student_invalid_live_qr');
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
    { id: 'Dr Ehab Younes', data: () => ({ Password: 'secret-one', 'Course Name': 'مبادئ قانون' }) },
    { id: 'Dr Other', data: () => ({ Password: 'secret-two', 'Course Name': 'مبادئ اقتصاد' }) }
  ];
  assert.deepEqual(findDoctorAccountMatches(documents, 'secret-one'), [
    { doctorName: 'Dr Ehab Younes', courseName: 'مبادئ قانون' }
  ]);
  assert.deepEqual(findDoctorAccountMatches(documents, 'wrong-password'), []);
  assert.deepEqual(findDoctorAccountMatches([
    ...documents,
    { id: 'Dr Duplicate', data: () => ({ Password: 'secret-one', 'Course Name': 'مبادئ قانون' }) }
  ], 'secret-one'), [
    { doctorName: 'Dr Ehab Younes', courseName: 'مبادئ قانون' },
    { doctorName: 'Dr Duplicate', courseName: 'مبادئ قانون' }
  ]);
  assert.deepEqual(findDoctorAccountMatches([
    { id: 'Dr Missing Course', data: () => ({ Password: 'secret-three', 'Course Name': 'Unknown Subject' }) }
  ], 'secret-three'), [{ doctorName: 'Dr Missing Course', courseName: null }]);
});

test('course attendance uses one supported course field and a fifteen-lecture denominator', () => {
  const supportedCourses = ['مبادئ قانون', 'مبادئ محاسبة مالية', 'مبادئ اقتصاد', 'إدارة أعمال', 'لغة انجليزية'];
  supportedCourses.forEach(courseName => assert.ok(getCourseStorageFieldName(courseName)));
  assert.equal(getCourseStorageFieldName('مبادئ قانون'), 'مبادئ_قانون');
  assert.equal(normalizeCourseName('مادة غير معتمدة'), null);
  assert.deepEqual(buildAttendanceSummary(3), {
    attendanceCount: 3,
    totalLectures: 15,
    attendancePercent: 20
  });
});

test('MODE course map exposes every active course lecture and course-specific QR fields', () => {
  assert.deepEqual(getModeCourseMap({
    'مبادئ قانون': '2',
    'إدارة أعمال': '5',
    'لغة انجليزية': null
  }), {
    'مبادئ قانون': 2,
    'إدارة أعمال': 5
  });
  assert.equal(getCourseQrFieldName('إدارة أعمال'), 'QR_Selected_إدارة_أعمال');
  assert.equal(getCourseQrFieldName('غير معروف'), null);
});

test('MODE writes only the authenticated doctor course fields', () => {
  const economicsQr = `XTRACTOR-${Date.now()}-C2-abc12345-xy99`;
  const businessQr = `XTRACTOR-${Date.now()}-C3-def67890-xy99`;

  assert.deepEqual(buildCourseModeUpdates('مبادئ اقتصاد', {
    'Student Mode': 'ON',
    'مبادئ اقتصاد': '4',
    'QR Selected': economicsQr
  }), {
    'مبادئ اقتصاد': '4',
    QR_Selected_مبادئ_اقتصاد: economicsQr
  });
  assert.deepEqual(buildCourseModeUpdates('إدارة أعمال', {
    'Student Mode': 'ON',
    'إدارة أعمال': '7',
    'QR Selected': businessQr
  }), {
    'إدارة أعمال': '7',
    QR_Selected_إدارة_أعمال: businessQr
  });
  assert.deepEqual(buildCourseModeUpdates('مبادئ اقتصاد', {
    'Student Mode': 'OFF',
    'QR Selected': 'NONE'
  }), {
    'مبادئ اقتصاد': null,
    QR_Selected_مبادئ_اقتصاد: 'NONE'
  });
});

test('course summary counts each lecture once and reports current lecture source', () => {
  const summary = buildCourseAttendanceRecords([
    {
      lectureNumber: 1,
      records: [{ id: 'S-1', fields: { Code: 'S-1', name: 'Student One', مبادئ_قانون: true } }]
    },
    {
      lectureNumber: 2,
      records: [
        { id: 'S-1', fields: { Code: 'S-1', name: 'Student One', مبادئ_قانون: true } },
        { id: 'duplicate', fields: { Code: 'S-1', 'مبادئ قانون': true } }
      ]
    },
    {
      lectureNumber: 3,
      records: [{ id: 'S-1', fields: { Code: 'S-1', name: 'Student One', مبادئ_قانون: true, مبادئ_قانون_Source: 'doctor' } }]
    }
  ], 'مبادئ قانون', 3);

  assert.equal(summary.length, 1);
  assert.equal(summary[0].fields.AttendanceCount, 3);
  assert.equal(summary[0].fields.AttendancePercent, 20);
  assert.equal(summary[0].fields.CurrentLectureAttended, true);
  assert.equal(summary[0].fields.AttendanceSource, 'doctor');

  const migratedFieldSummary = buildCourseAttendanceRecords([{
    lectureNumber: 1,
    records: [{ id: 'S-2', fields: { Code: 'S-2', مبادئ_قانون: false, 'مبادئ قانون': true } }]
  }], 'مبادئ قانون', 1);
  assert.equal(migratedFieldSummary[0].fields.AttendanceCount, 1);
});