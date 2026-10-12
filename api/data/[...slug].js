const { getFirestore } = require('../../lib/firebase');
const { validateSessionToken } = require('../../lib/session');
const { isIP } = require('net');
const { checkRateLimit } = require('../../lib/rate-limit');
const { enforceSameOrigin } = require('../../lib/request-security');
const { validateStudentPatch } = require('../../lib/data-policy');
const { isValidDeviceFingerprint } = require('../../lib/device-policy');
const {
  buildCourseAttendanceRecords,
  COURSE_NAMES,
  TOTAL_COURSE_LECTURES,
  getCourseSourceFieldName,
  getCourseStorageFieldName,
  getModeActiveCourse,
  getModeCourseLecture,
  getModeCourseMap,
  hasAnyActiveCourseLecture,
  normalizeCourseName
} = require('../../lib/course-policy');

const ATTENDANCE_SUMMARY_CACHE_TTL_MS = 20000;
const attendanceSummaryCache = new Map();

function requireSession(req, res) {
  const session = validateSessionToken(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized', message: 'Valid session required.' });
    return null;
  }

  if (session.role !== 'doctor' && session.role !== 'student') {
    res.status(403).json({ error: 'forbidden', message: 'Permission denied.' });
    return null;
  }

  return session;
}

function getParts(req) {
  const raw = req.query?.slug || req.params?.slug;
  if (raw) {
    return (Array.isArray(raw) ? raw : String(raw).split('/')).filter(Boolean).map(decodeURIComponent);
  }

  const pathname = String(req.url || '').split('?')[0];
  const dataPath = pathname.match(/\/api\/data\/(.*)$/)?.[1] || '';
  return dataPath.split('/').filter(Boolean).map(decodeURIComponent);
}

function canonicalizeNameKey(key) {
  if (!key || typeof key !== 'string') return key;
  const normalized = key.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'name' || normalized === 'studentname' || normalized === 'fullname') {
    return 'name';
  }
  return key;
}

function getStudentCodeFromRecordData(data = {}, fallbackId = '') {
  const value = data.Code ?? data.code ?? data['Student Code'] ?? data.studentCode ?? data.StudentCode ?? fallbackId ?? '';
  return String(value || '').trim();
}

function normalizeFingerprint(value) {
  return String(value || '').trim().replace(/\s+/g, '').slice(0, 256);
}

function toRecord(doc, collection = '', role = 'doctor') {
  const data = doc.data() || {};
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (role === 'student' && ['Device_Fingerprint', 'Device Fingerprint', 'deviceFingerprint', 'Device_Id_Hash'].includes(key)) continue;
    const canonicalKey = canonicalizeNameKey(key);
    if (key === 'Device_ip') fields['Device IP'] = value;
    else if (canonicalKey === 'name') {
      if (!fields.name || !String(fields.name).trim()) fields.name = value;
    } else {
      fields[canonicalKey.replace(/_/g, ' ')] = value;
    }
  }
  if (/^LEC_\d+$/i.test(collection) && !fields.Code) {
    const resolvedCode = getStudentCodeFromRecordData(data, doc.id);
    if (resolvedCode && resolvedCode !== 'UNKNOWN' && resolvedCode !== 'unknown') {
      fields.Code = resolvedCode;
    } else {
      fields.Code = doc.id;
    }
  }
  return { id: doc.id, fields };
}

async function findStudentRecordByIdentity(ref, studentCode) {
  if (!ref || !studentCode) return null;

  try {
    const byDocId = await ref.doc(studentCode).get();
    if (byDocId.exists) return byDocId;
  } catch (error) {
    console.warn('Student doc-id lookup failed:', error.message || error);
  }

  for (const fieldName of ['Code', 'code', 'Student Code', 'studentCode', 'StudentCode']) {
    try {
      const byCodeField = await ref.where(fieldName, '==', studentCode).limit(1).get();
      if (!byCodeField.empty) return byCodeField.docs[0];
    } catch (error) {
      console.warn(`Student ${fieldName} lookup failed:`, error.message || error);
    }
  }

  return null;
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!key || typeof key !== 'string') continue;
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (String(value).length > 25000) continue;
    const canonicalKey = canonicalizeNameKey(key);
    if (canonicalKey === 'name') {
      sanitized.name = String(value).trim();
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function toFirestore(fields) {
  const result = {};
  for (const [key, value] of Object.entries(sanitizeFields(fields))) {
    if (key === 'name') {
      result.name = String(value).trim();
      continue;
    }
    if (key === 'Device IP' || key === 'Device_IP') result.Device_ip = value;
    else if (key === 'Code' || key === 'code') {
      result.Code = value;
    } else result[key.replace(/\s+/g, '_')] = value;
  }
  return result;
}

const GEO_BOUNDARIES = [
  { lat: 29.9820791, lng: 31.2336799 },
  { lat: 29.9821587, lng: 31.2335790 },
  { lat: 29.9816374, lng: 31.2335180 },
  { lat: 29.9817190, lng: 31.2332451 }
];

function resolveStudentLocation(value) {
  if (typeof value !== 'string' || value.length > 500) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'maps.google.com') return null;
    const coordinates = String(url.searchParams.get('q') || '').split(',').map(Number);
    if (coordinates.length !== 2) return null;
    const [lat, lng] = coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    let isInside = false;
    for (let i = 0, j = GEO_BOUNDARIES.length - 1; i < GEO_BOUNDARIES.length; j = i++) {
      const current = GEO_BOUNDARIES[i];
      const previous = GEO_BOUNDARIES[j];
      const intersects = ((current.lat > lat) !== (previous.lat > lat)) &&
        (lng < (previous.lng - current.lng) * (lat - current.lat) / (previous.lat - current.lat) + current.lng);
      if (intersects) isInside = !isInside;
    }

    if (!isInside) {
      isInside = GEO_BOUNDARIES.some(point =>
        Math.abs(point.lat - lat) <= 0.00015 && Math.abs(point.lng - lng) <= 0.00015
      );
    }

    return {
      location: `https://maps.google.com/?q=${lat},${lng}`,
      region: isInside ? 'In region' : 'Out region'
    };
  } catch (error) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  let phase = 'request_validation';
  const requestId = req.headers?.['x-vercel-id'] || req.headers?.['x-request-id'] || null;
  try {
    if (!enforceSameOrigin(req, res)) return;
    if (!checkRateLimit(req, res, { endpoint: 'data', maxRequests: 120, windowMs: 60000 })) return;

    const session = requireSession(req, res);
    if (!session) return;

    phase = 'firestore_initialization';
    const firestore = getFirestore();
    const parts = getParts(req);
    if (parts.length < 1) return res.status(400).json({ error: 'invalid_data_path' });
    const collection = parts[0];
    const documentId = parts[1] || req.query?.documentId || req.body?.documentId || req.body?.id || req.body?.recordId || null;
    const method = (req.method || 'GET').toUpperCase();
    const params = new URL(req.url || '/', 'http://localhost').searchParams;

    if (collection === 'Protection') {
      const snap = await firestore.collection('System_Control').doc('Xtractor Website Protection').get();
      if (!snap.exists) return res.status(404).json({ error: 'protection_not_found' });
      const data = snap.data();
      return res.json({ records: [{ id: snap.id, fields: { Select: data.Website_Status ? 'Unlock' : 'Lock', Text: data.Text || '', Link: data.Link || '' } }] });
    }

    if (collection === 'AttendanceSummary') {
      if (method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
      if (session.role !== 'doctor') return res.status(403).json({ error: 'forbidden' });

      const courseName = normalizeCourseName(session.courseName);
      const courseStorageField = getCourseStorageFieldName(courseName);
      const requestedLecture = Number(params.get('lecture'));
      if (!courseName || !courseStorageField || !Number.isInteger(requestedLecture) || requestedLecture < 1 || requestedLecture > TOTAL_COURSE_LECTURES) {
        return res.status(400).json({ error: 'invalid_attendance_summary_request' });
      }

      const cacheKey = `${courseName}:${requestedLecture}`;
      const cached = attendanceSummaryCache.get(cacheKey);
      if (params.get('refresh') !== '1' && cached && Date.now() - cached.timestamp < ATTENDANCE_SUMMARY_CACHE_TTL_MS) {
        return res.json(cached.payload);
      }

      const lectureData = await Promise.all(Array.from({ length: TOTAL_COURSE_LECTURES }, async (_, index) => {
        const lectureNumber = index + 1;
        const lectureRef = firestore.collection(`LEC_${lectureNumber}`);
        const querySnapshots = await Promise.all([
          lectureRef.where(courseStorageField, '==', true).get(),
          courseStorageField === courseName ? Promise.resolve(null) : lectureRef.where(courseName, '==', true).get()
        ]);
        const docs = new Map();
        for (const snapshot of querySnapshots) {
          if (!snapshot) continue;
          for (const doc of snapshot.docs) docs.set(doc.id, doc);
        }
        return {
          lectureNumber,
          records: Array.from(docs.values()).map(doc => ({ id: doc.id, fields: doc.data() || {} }))
        };
      }));

      const records = buildCourseAttendanceRecords(lectureData, courseName, requestedLecture);
      const payload = {
        courseName,
        lectureNumber: requestedLecture,
        totalLectures: TOTAL_COURSE_LECTURES,
        records
      };
      attendanceSummaryCache.set(cacheKey, { timestamp: Date.now(), payload });
      return res.json(payload);
    }

    if (collection === 'MODE') {
      const ref = firestore.collection('MODE').doc('Website Status');
      if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method)) {
        return res.status(405).json({ error: 'method_not_allowed' });
      }

      if (method === 'GET') {
        if (session.role !== 'doctor' && session.role !== 'student') {
          return res.status(403).json({ error: 'forbidden_role' });
        }
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'mode_not_found' });
        const data = snap.data() || {};
        const fields = {
          'Student Mode': (data.Student_Mode === true || String(data.Student_Mode || '').toLowerCase() === 'on' || hasAnyActiveCourseLecture(data)) ? 'ON' : 'OFF',
          'QR Selected': data.QR_Selected || 'NONE',
          Name: data.Name || 'Website Status'
        };
        for (const courseName of COURSE_NAMES) {
          const keyValue = getModeCourseLecture(data, courseName);
          fields[courseName] = keyValue !== null ? String(keyValue) : null;
        }
        return res.json({ records: [{ id: snap.id, fields }] });
      }

      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        if (session.role !== 'doctor') {
          return res.status(403).json({ error: 'forbidden' });
        }
      }

      if (session.role !== 'doctor') {
        return res.status(403).json({ error: 'forbidden' });
      }

      const sourceFields = sanitizeFields(req.body?.fields || req.body || {});
      const updates = {};
      const doctorCourse = normalizeCourseName(session.courseName);
      if (sourceFields['Student Mode'] !== undefined) {
        updates.Student_Mode = sourceFields['Student Mode'] === 'ON' || sourceFields['Student Mode'] === true;
      }
      if (sourceFields['Course Name'] !== undefined) {
        return res.status(400).json({ error: 'deprecated_mode_course_name_field' });
      }
      if (sourceFields.Lecture !== undefined) {
        return res.status(400).json({ error: 'deprecated_mode_lecture_field' });
      }
      if (sourceFields['QR Selected'] !== undefined) {
        const selectedQr = sourceFields['QR Selected'] || 'NONE';
        if (selectedQr !== 'NONE' && (typeof selectedQr !== 'string' || !/^XTRACTOR-[A-Za-z0-9-]{12,120}$/.test(selectedQr))) {
          return res.status(400).json({ error: 'invalid_live_qr' });
        }
        updates.QR_Selected = selectedQr;
      }
      if (sourceFields.Name !== undefined) updates.Name = String(sourceFields.Name).slice(0, 200);

      if (!doctorCourse) {
        return res.status(403).json({ error: 'doctor_course_not_configured' });
      }

      if (sourceFields[doctorCourse] !== undefined) {
        const lectureValue = Number(sourceFields[doctorCourse]);
        updates[doctorCourse] = Number.isInteger(lectureValue) && lectureValue > 0 ? String(lectureValue) : null;
        if (sourceFields['Student Mode'] === undefined && lectureValue > 0) {
          updates.Student_Mode = true;
        }
      }

      if (sourceFields['Student Mode'] !== undefined && sourceFields['Student Mode'] === 'OFF') {
        updates[doctorCourse] = null;
      }

      await ref.set(updates, { merge: true });
      const snap = await ref.get();
      const data = snap.data() || {};
      const responseFields = {
        'Student Mode': (data.Student_Mode === true || String(data.Student_Mode || '').toLowerCase() === 'on' || hasAnyActiveCourseLecture(data)) ? 'ON' : 'OFF',
        'QR Selected': data.QR_Selected || 'NONE',
        Name: data.Name || 'Website Status'
      };
      for (const courseName of COURSE_NAMES) {
        const keyValue = getModeCourseLecture(data, courseName);
        responseFields[courseName] = keyValue !== null ? String(keyValue) : null;
      }
      return res.json({ records: [{ id: snap.id, fields: responseFields }] });
    }

    if (!/^LEC_\d+$/i.test(collection)) return res.status(404).json({ error: 'collection_not_found' });

    const ref = firestore.collection(collection);
    const formula = params.get('filterByFormula') || '';
    const match = formula.match(/^\{([^}]+)\}='([^']*)'$/) || formula.match(/^\(\{([^}]+)\}='([^']*)'\)$/);

    if (session.role !== 'doctor' && session.role !== 'student') {
      return res.status(403).json({ error: 'forbidden_role' });
    }

    if (method === 'GET' && documentId) {
      if (session.role === 'student' && String(documentId).trim() !== String(session.userCode || '').trim()) {
        return res.status(403).json({ error: 'student_insufficient_scope' });
      }

      const byDocId = await ref.doc(documentId).get();
      if (byDocId.exists) {
        return res.json({ records: [toRecord(byDocId, collection, session.role)] });
      }

      const byCodeField = await ref.where('Code', '==', documentId).limit(1).get();
      if (!byCodeField.empty) {
        return res.json({ records: byCodeField.docs.map(doc => toRecord(doc, collection, session.role)) });
      }

      return res.json({ records: [] });
    }

    if (method === 'GET') {
      if (match && match[1] === 'Code') {
        if (session.role === 'student' && match[2] !== session.userCode) {
          return res.status(403).json({ error: 'student_insufficient_scope' });
        }
        const snap = await findStudentRecordByIdentity(ref, match[2]);
        return res.json({ records: snap ? [toRecord(snap, collection)] : [] });
      }

      if (match && match[1] === 'Device IP') {
        const requestedIP = String(match[2] || '').trim();
        if (session.role === 'student') {
          const myRecord = await findStudentRecordByIdentity(ref, session.userCode);
          if (!myRecord) {
            return res.status(403).json({ error: 'student_insufficient_scope' });
          }

          if (params.get('checkConflict') === '1') {
            if (!isIP(requestedIP)) {
              return res.status(400).json({ error: 'invalid_device_ip' });
            }

            const incomingFingerprint = normalizeFingerprint(
              req.headers?.['x-device-fingerprint'] || req.headers?.['X-Device-Fingerprint'] || ''
            );
            if (!isValidDeviceFingerprint(incomingFingerprint)) {
              return res.status(400).json({ error: 'device_fingerprint_missing' });
            }

            const [fingerprintMatches, legacyFingerprintMatches] = await Promise.all([
              ref.where('Device_Fingerprint', '==', incomingFingerprint).limit(20).get(),
              ref.where('Device Fingerprint', '==', incomingFingerprint).limit(20).get()
            ]);
            const matchingDocs = new Map();
            for (const doc of [...fingerprintMatches.docs, ...legacyFingerprintMatches.docs]) {
              matchingDocs.set(doc.id, doc);
            }
            const conflict = Array.from(matchingDocs.values()).some(doc => {
              const otherCode = getStudentCodeFromRecordData(doc.data() || {}, doc.id);
              return otherCode && otherCode !== String(session.userCode || '').trim();
            });

            return res.json({ conflict });
          }

          const myDeviceIP = String(myRecord.data()?.Device_ip || myRecord.data()?.['Device IP'] || '').trim();
          if (!myDeviceIP || myDeviceIP === 'Unknown') {
            return res.status(403).json({ error: 'student_device_ip_missing' });
          }
          if (myDeviceIP === requestedIP) {
            return res.json({ records: [toRecord(myRecord, collection, session.role)] });
          }

          return res.status(403).json({ error: 'student_device_mismatch' });
        }

        const snaps = await ref.where('Device_ip', '==', requestedIP).get();
        return res.json({ records: snaps.docs.map(doc => toRecord(doc, collection)) });
      }

      if (session.role === 'student') {
        return res.status(403).json({ error: 'student_not_allowed_to_read_all_records' });
      }
      const snaps = await ref.get();
      return res.json({ records: snaps.docs.map(doc => toRecord(doc, collection)) });
    }

    if (method === 'PATCH' || method === 'PUT') {
      if (session.role === 'student' && method !== 'PATCH') {
        return res.status(403).json({ error: 'student_forbidden_method' });
      }

      if (!documentId) return res.status(400).json({ error: 'missing_document_id' });
      const fields = sanitizeFields(req.body?.fields || req.body || {});

      if (session.role === 'student') {
        phase = 'student_record_read';
        const current = await ref.doc(documentId).get();
        if (!current.exists) return res.status(404).json({ error: 'record_not_found' });

        const courseName = normalizeCourseName(session.courseName);
        const isAttendanceUpdate = Boolean(courseName && fields[courseName] !== undefined);
        let modeRecord = {};
        if (isAttendanceUpdate) {
          phase = 'attendance_mode_read';
          const modeSnap = await firestore.collection('MODE').doc('Website Status').get();
          modeRecord = modeSnap.exists ? modeSnap.data() : {};
        }

        phase = 'student_patch_validation';
        const policyError = validateStudentPatch({
          collection,
          session,
          documentId,
          currentRecord: current,
          modeRecord,
          fields,
          qrToken: req.body?.qrToken
        });
        if (policyError) {
          return res.status(policyError === 'student_invalid_location' ? 400 : 403).json({ error: policyError });
        }

        const courseSourceField = getCourseSourceFieldName(courseName);
        const updates = {};
        if (fields[courseName] === true) {
          updates[courseName] = true;
          updates[courseSourceField] = 'student';
        }
        if (fields.Location !== undefined) {
          phase = 'student_location_validation';
          const location = resolveStudentLocation(fields.Location);
          if (!location) return res.status(400).json({ error: 'student_invalid_location' });
          updates.Location = location.location;
          updates.Region = location.region;
        }
        phase = 'student_record_write';
        await ref.doc(documentId).set(toFirestore(updates), { merge: true });
        phase = 'student_record_response_read';
        return res.json(toRecord(await ref.doc(documentId).get(), collection, session.role));
      }

      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'empty_update_payload' });
      }
      await ref.doc(documentId).set(toFirestore(fields), { merge: true });
      return res.json(toRecord(await ref.doc(documentId).get(), collection));
    }

    if (method === 'POST') {
      if (session.role === 'student') {
        return res.status(403).json({ error: 'student_cannot_create_records' });
      }
      const records = Array.isArray(req.body?.records) ? req.body.records : [req.body || {}];
      const created = [];
      for (const item of records) {
        const fields = sanitizeFields(item?.fields || item || {});
        if (!fields.Code || String(fields.Code).trim().length === 0) {
          return res.status(400).json({ error: 'missing_student_code_in_record' });
        }
        const id = String(fields.Code).trim();
        await ref.doc(id).set(toFirestore(fields), { merge: true });
        created.push(toRecord(await ref.doc(id).get(), collection));
      }
      return res.json({ records: created });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (error) {
    console.error('Data handler error:', {
      phase,
      requestId,
      message: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
      stack: error instanceof Error ? error.stack : null
    });
    return res.status(500).json({ error: 'data_handler_error' });
  }
};
