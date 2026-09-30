const ExcelJS = require('exceljs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
const WHITE_FONT = { name: 'Segoe UI', size: 10, color: { argb: 'FFFFFFFF' }, bold: true };
const TABLE_BORDER = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } }
};

function getStudentCode(record) {
  return String(record.Code ?? record.code ?? record['Student Code'] ?? record.studentCode ?? record.StudentCode ?? record.id ?? '').trim();
}

function getStudentName(record) {
  const candidate = record.name ?? record.Name ?? record['Student Name'] ?? record['Full Name'] ?? record.studentName ?? record.StudentName;
  return candidate === undefined || candidate === null || !String(candidate).trim() ? '---' : String(candidate).trim();
}

function getRegion(record) {
  return record.Region ?? record.region ?? '---';
}

function isAttended(record) {
  return record.Qr_Live === true || record.Qr_Live === 'true';
}

function formatWorksheet(worksheet) {
  worksheet.getRow(1).eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = { name: 'Segoe UI', size: 11, color: { argb: 'FFFFFFFF' }, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'center' };
    cell.border = TABLE_BORDER;
  });

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    worksheet.getRow(rowNumber).eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF000000' } };
      cell.alignment = { horizontal: 'center', vertical: 'center' };
      cell.border = TABLE_BORDER;
    });
  }
}

function formatSingleLectureRows(worksheet) {
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const attendanceCell = row.getCell(3);
    if (attendanceCell.value === '✓') {
      attendanceCell.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FF16803C' } };
    }

    const regionCell = row.getCell(4);
    if (regionCell.value === 'Out region' || regionCell.value === 'In region') {
      regionCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: regionCell.value === 'Out region' ? 'FFDC2626' : 'FF16A34A' }
      };
      regionCell.font = WHITE_FONT;
    }
  }
}

async function createSingleLectureWorkbook(records, lectureNumber) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(`Lecture_${lectureNumber}`);
  worksheet.addRow(['الاسم', 'الكود', 'Live QR', 'المنطقة']);

  const students = records.map(record => ({
    name: getStudentName(record.fields || {}),
    code: getStudentCode(record.fields || {}) || String(record.id || '---'),
    attended: isAttended(record.fields || {}),
    region: getRegion(record.fields || {})
  })).sort((left, right) => left.name.localeCompare(right.name, 'ar'));

  students.forEach(student => worksheet.addRow([
    student.name,
    student.code,
    student.attended ? '✓' : '',
    student.region
  ]));

  worksheet.getColumn(1).width = 35;
  worksheet.getColumn(2).width = 16;
  worksheet.getColumn(3).width = 12;
  worksheet.getColumn(4).width = 16;
  formatWorksheet(worksheet);
  formatSingleLectureRows(worksheet);
  return workbook.xlsx.writeBuffer();
}

async function createMultipleLecturesWorkbook(lectureData) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Attendance');
  const lectureNumbers = lectureData.map(item => item.lectureNumber);
  worksheet.addRow(['الاسم', 'الكود', ...lectureNumbers.map(number => `Lec ${number}`)]);

  const studentsByCode = new Map();
  lectureData.forEach(({ lectureNumber, records }) => {
    records.forEach(record => {
      const fields = record.fields || {};
      const code = getStudentCode(fields) || String(record.id || '').trim();
      if (!code) return;

      let student = studentsByCode.get(code);
      if (!student) {
        student = { code, name: getStudentName(fields), lectures: new Map() };
        studentsByCode.set(code, student);
      } else if (student.name === '---') {
        student.name = getStudentName(fields);
      }

      student.lectures.set(lectureNumber, {
        attended: isAttended(fields),
        region: getRegion(fields)
      });
    });
  });

  const students = Array.from(studentsByCode.values()).sort((left, right) => left.name.localeCompare(right.name, 'ar'));
  students.forEach(student => worksheet.addRow([
    student.name,
    student.code,
    ...lectureNumbers.map(number => student.lectures.get(number)?.attended ? 'X' : '')
  ]));

  worksheet.getColumn(1).width = 30;
  worksheet.getColumn(2).width = 16;
  lectureNumbers.forEach((number, index) => {
    worksheet.getColumn(index + 3).width = 10;
  });
  formatWorksheet(worksheet);

  students.forEach((student, studentIndex) => {
    const row = worksheet.getRow(studentIndex + 2);
    lectureNumbers.forEach((lectureNumber, lectureIndex) => {
      const attendance = student.lectures.get(lectureNumber);
      if (!attendance) return;
      const cell = row.getCell(lectureIndex + 3);
      if (attendance.region === 'Out region' || attendance.region === 'In region') {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: attendance.region === 'Out region' ? 'FFDC2626' : 'FF16A34A' }
        };
        cell.font = WHITE_FONT;
      }
    });
  });

  return workbook.xlsx.writeBuffer();
}

module.exports = { createMultipleLecturesWorkbook, createSingleLectureWorkbook };