const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { createMultipleLecturesWorkbook, createSingleLectureWorkbook } = require('../lib/export-workbook');

test('single lecture export uses the selected course field and preserves region colors', async () => {
  const buffer = await createSingleLectureWorkbook([
    { id: 'S-1', fields: { Code: 'S-1', name: 'Student One', 'مبادئ_قانون': true, Region: 'Out region' } },
    { id: 'S-2', fields: { Code: 'S-2', name: 'Student Two', 'مبادئ_قانون': false, Region: 'In region' } }
  ], 8, 'مبادئ قانون');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet('Lecture_8');

  assert.deepEqual(worksheet.getRow(1).values.slice(1), ['الاسم', 'الكود', 'مبادئ قانون', 'المنطقة']);
  assert.equal(worksheet.getRow(2).getCell(3).value, '✓');
  assert.equal(worksheet.getRow(2).getCell(4).value, 'Out region');
  assert.equal(worksheet.getRow(2).getCell(4).fill.fgColor.argb, 'FFDC2626');
  assert.equal(worksheet.getRow(3).getCell(4).fill.fgColor.argb, 'FF16A34A');
});

test('multiple lecture export uses course-specific fields for attendance marks', async () => {
  const buffer = await createMultipleLecturesWorkbook([
    { lectureNumber: 1, records: [{ id: 'S-1', fields: { Code: 'S-1', name: 'Student One', 'مبادئ_قانون': true, Region: 'In region' } }] },
    { lectureNumber: 3, records: [{ id: 'S-1', fields: { Code: 'S-1', name: 'Student One', 'مبادئ_قانون': false, Region: 'Out region' } }] }
  ], 'مبادئ قانون');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet('Attendance');

  assert.deepEqual(worksheet.getRow(1).values.slice(1), ['الاسم', 'الكود', 'Lec 1', 'Lec 3']);
  assert.equal(worksheet.getRow(2).getCell(3).value, 'X');
  assert.equal(worksheet.getRow(2).getCell(4).value, '');
  assert.equal(worksheet.getRow(2).getCell(3).fill.fgColor.argb, 'FF16A34A');
  assert.equal(worksheet.getRow(2).getCell(4).fill.fgColor.argb, 'FFDC2626');
});