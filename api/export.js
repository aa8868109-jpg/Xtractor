const { getFirestore } = require('./firebase');
const { validateSessionToken } = require('./session');
const { checkRateLimit } = require('./rate-limit');
const { enforceSameOrigin } = require('./request-security');
const { createMultipleLecturesWorkbook, createSingleLectureWorkbook } = require('./export-workbook');

function getStudentCode(record) {
  return String(record.Code ?? record.code ?? record['Student Code'] ?? record.studentCode ?? record.StudentCode ?? '').trim();
}

function getStudentName(record) {
  const candidate = record.name ?? record.Name ?? record['Student Name'] ?? record['Full Name'] ?? record.studentName ?? record.StudentName;
  return candidate === undefined || candidate === null || !String(candidate).trim() ? '' : String(candidate).trim();
}

function validateLectureNumbers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 15) return null;
  const numbers = value.map(Number);
  if (numbers.some(number => !Number.isInteger(number) || number < 1 || number > 15)) return null;
  if (new Set(numbers).size !== numbers.length) return null;
  return numbers.sort((left, right) => left - right);
}

function getExportFilename(kind, lectureNumbers) {
  const lectureRange = lectureNumbers.length === 1
    ? `Lec${lectureNumbers[0]}`
    : `Lec${lectureNumbers[0]}-${lectureNumbers[lectureNumbers.length - 1]}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `Attendance_${lectureRange}_${timestamp}.xlsx`;
}

module.exports = async function handler(req, res) {
  if (!enforceSameOrigin(req, res)) return;
  if (!checkRateLimit(req, res, { endpoint: 'export', maxRequests: 6, windowMs: 60000 })) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const session = validateSessionToken(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  if (session.role !== 'doctor') return res.status(403).json({ error: 'forbidden' });

  const kind = req.body?.kind;
  const lectureNumbers = validateLectureNumbers(req.body?.lectureNumbers);
  if (!lectureNumbers || !['single', 'multiple'].includes(kind) || (kind === 'single' && lectureNumbers.length !== 1)) {
    return res.status(400).json({ error: 'invalid_export_request' });
  }

  try {
    const firestore = getFirestore();
    const lectureData = await Promise.all(lectureNumbers.map(async lectureNumber => {
      const snapshot = await firestore.collection(`LEC_${lectureNumber}`).get();
      return {
        lectureNumber,
        records: snapshot.docs.map(doc => ({ id: doc.id, fields: doc.data() || {} }))
      };
    }));

    if (kind === 'single' && lectureData[0].records.length === 0) {
      return res.status(404).json({ error: 'no_students' });
    }

    if (lectureData.every(item => item.records.length === 0)) {
      return res.status(404).json({ error: 'no_students' });
    }

    const directory = lectureNumbers.includes(1)
      ? lectureData.find(item => item.lectureNumber === 1)?.records || []
      : (await firestore.collection('LEC_1').get()).docs.map(doc => ({ id: doc.id, fields: doc.data() || {} }));
    const directoryNames = new Map();
    directory.forEach(record => {
      const code = getStudentCode(record.fields) || record.id;
      const name = getStudentName(record.fields);
      if (code && name) directoryNames.set(code, name);
    });

    lectureData.forEach(({ records }) => records.forEach(record => {
      if (getStudentName(record.fields)) return;
      const code = getStudentCode(record.fields) || record.id;
      const directoryName = directoryNames.get(code);
      if (directoryName) record.fields.name = directoryName;
    }));

    let workbookBuffer;
    if (kind === 'single') {
      workbookBuffer = await createSingleLectureWorkbook(lectureData[0].records, lectureNumbers[0]);
    } else {
      workbookBuffer = await createMultipleLecturesWorkbook(lectureData);
    }

    const filename = getExportFilename(kind, lectureNumbers);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).end(Buffer.from(workbookBuffer));
  } catch (error) {
    console.error('Attendance export failed:', error.message || error);
    return res.status(500).json({ error: 'export_failed' });
  }
};