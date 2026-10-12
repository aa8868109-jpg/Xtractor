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

function getCourseStorageFieldName(courseName) {
  const normalized = normalizeCourseName(courseName);
  return normalized ? normalized.replace(/\s+/g, '_') : null;
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
  buildCourseAttendanceRecords,
  getCourseSourceFieldName,
  getCourseSourceStorageFieldName,
  getCourseStorageFieldName,
  isAttendanceMarked,
  normalizeCourseName
};