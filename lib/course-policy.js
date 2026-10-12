const COURSE_NAMES = Object.freeze([
  'مبادئ قانون',
  'مبادئ محاسبة مالية',
  'مبادئ اقتصاد',
  'إدارة أعمال',
  'لغة انجليزية'
]);

const TOTAL_COURSE_LECTURES = 15;

function normalizeCourseName(value) {
  const courseName = String(value || '').trim();
  return COURSE_NAMES.includes(courseName) ? courseName : null;
}

function normalizeModeLectureValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const asNumber = Number(value);
  if (!Number.isInteger(asNumber) || asNumber < 1 || asNumber > TOTAL_COURSE_LECTURES) return null;
  return asNumber;
}

function getModeCourseLecture(modeRecord = {}, courseName) {
  const normalizedCourse = normalizeCourseName(courseName);
  if (!normalizedCourse) return null;

  const candidateKeys = [
    normalizedCourse,
    normalizedCourse.replace(/\s+/g, '_'),
    normalizedCourse.replace(/\s+/g, ' '),
    courseName
  ];

  for (const key of candidateKeys) {
    const lectureNumber = normalizeModeLectureValue(modeRecord?.[key]);
    if (lectureNumber !== null) return lectureNumber;
  }

  return null;
}

function getModeCourseMap(modeRecord = {}) {
  const courseMap = {};
  for (const courseName of COURSE_NAMES) {
    const lectureNumber = getModeCourseLecture(modeRecord, courseName);
    if (lectureNumber !== null) courseMap[courseName] = lectureNumber;
  }
  return courseMap;
}

function getModeActiveCourse(modeRecord = {}) {
  const courseMap = getModeCourseMap(modeRecord);
  if (Object.keys(courseMap).length > 0) {
    const [courseName] = Object.entries(courseMap).sort((a, b) => b[1] - a[1])[0] || [];
    return courseName || null;
  }

  return null;
}

function hasAnyActiveCourseLecture(modeRecord = {}) {
  return Object.keys(getModeCourseMap(modeRecord)).length > 0;
}

function getCourseStorageFieldName(courseName) {
  const normalized = normalizeCourseName(courseName);
  return normalized ? normalized.replace(/\s+/g, '_') : null;
}

function getCourseQrFieldName(courseName) {
  const storageField = getCourseStorageFieldName(courseName);
  return storageField ? `QR_Selected_${storageField}` : null;
}

function buildCourseModeUpdates(courseName, sourceFields = {}) {
  const normalizedCourse = normalizeCourseName(courseName);
  if (!normalizedCourse) return null;

  const updates = {};
  const qrField = getCourseQrFieldName(normalizedCourse);
  if (sourceFields['QR Selected'] !== undefined && qrField) {
    updates[qrField] = sourceFields['QR Selected'] || 'NONE';
  }

  if (sourceFields[normalizedCourse] !== undefined) {
    const lectureValue = Number(sourceFields[normalizedCourse]);
    updates[normalizedCourse] = Number.isInteger(lectureValue) &&
      lectureValue > 0 &&
      lectureValue <= TOTAL_COURSE_LECTURES
      ? String(lectureValue)
      : null;
  }

  if (sourceFields['Student Mode'] === 'OFF' || sourceFields['Student Mode'] === false) {
    updates[normalizedCourse] = null;
  }

  return updates;
}

function getCourseSourceFieldName(courseName) {
  const normalized = normalizeCourseName(courseName);
  return normalized ? `${normalized} Source` : null;
}

function getCourseSourceStorageFieldName(courseName) {
  const sourceField = getCourseSourceFieldName(courseName);
  return sourceField ? sourceField.replace(/\s+/g, '_') : null;
}

function isAttendanceMarked(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function buildAttendanceSummary(attendedLectures, totalLectures = TOTAL_COURSE_LECTURES) {
  const attendanceCount = Math.max(0, Number(attendedLectures) || 0);
  const lectureTotal = Math.max(1, Number(totalLectures) || TOTAL_COURSE_LECTURES);
  return {
    attendanceCount,
    totalLectures: lectureTotal,
    attendancePercent: Math.round((attendanceCount / lectureTotal) * 100)
  };
}

function buildCourseAttendanceRecords(lectureData, courseName, currentLectureNumber) {
  const normalizedCourse = normalizeCourseName(courseName);
  if (!normalizedCourse) return [];

  const storageField = getCourseStorageFieldName(normalizedCourse);
  const sourceStorageField = getCourseSourceStorageFieldName(normalizedCourse);
  const sourceLiteralField = getCourseSourceFieldName(normalizedCourse);
  const studentsByCode = new Map();

  for (const { lectureNumber, records } of lectureData || []) {
    const seenCodesThisLecture = new Set();
    for (const record of records || []) {
      const fields = record.fields || {};
      const attendedInStorageField = isAttendanceMarked(fields[storageField]);
      const attendedInLiteralField = isAttendanceMarked(fields[normalizedCourse]);
      if (!attendedInStorageField && !attendedInLiteralField) continue;

      const code = String(fields.Code ?? fields.code ?? fields['Student Code'] ?? record.id ?? '').trim();
      if (!code || seenCodesThisLecture.has(code)) continue;
      seenCodesThisLecture.add(code);

      let student = studentsByCode.get(code);
      if (!student) {
        student = {
          id: code,
          name: String(fields.name ?? fields.Name ?? fields.Student_Name ?? ''),
          region: String(fields.Region || 'Unknown'),
          attendedLectures: new Set(),
          currentLectureAttended: false,
          attendanceSource: ''
        };
        studentsByCode.set(code, student);
      } else if (!student.name) {
        student.name = String(fields.name ?? fields.Name ?? fields.Student_Name ?? '');
      }

      student.attendedLectures.add(Number(lectureNumber));
      if (Number(lectureNumber) === Number(currentLectureNumber)) {
        student.currentLectureAttended = true;
        student.attendanceSource = String(fields[sourceStorageField] ?? fields[sourceLiteralField] ?? '');
        student.region = String(fields.Region || student.region);
      }
    }
  }

  return Array.from(studentsByCode.values()).map(student => {
    const attendance = buildAttendanceSummary(student.attendedLectures.size);
    return {
      id: student.id,
      fields: {
        Code: student.id,
        Name: student.name,
        Region: student.region,
        AttendanceCount: attendance.attendanceCount,
        AttendanceTotal: attendance.totalLectures,
        AttendancePercent: attendance.attendancePercent,
        CurrentLectureAttended: student.currentLectureAttended,
        AttendanceSource: student.attendanceSource
      }
    };
  });
}

module.exports = {
  COURSE_NAMES,
  TOTAL_COURSE_LECTURES,
  buildAttendanceSummary,
  buildCourseModeUpdates,
  buildCourseAttendanceRecords,
  getCourseQrFieldName,
  getCourseSourceFieldName,
  getCourseSourceStorageFieldName,
  getCourseStorageFieldName,
  getModeActiveCourse,
  getModeCourseLecture,
  getModeCourseMap,
  hasAnyActiveCourseLecture,
  isAttendanceMarked,
  normalizeCourseName,
  normalizeModeLectureValue
};