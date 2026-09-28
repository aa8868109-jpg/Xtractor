const crypto = require('crypto');
const { getFirestore } = require('./firebase');
const { SESSION_COOKIE_NAME, createSessionToken } = require('./session');
const { logSecurityEvent } = require('./security-logger');

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookieSecurityFlags(req = null) {
    const proto = (req?.headers?.['x-forwarded-proto'] || req?.headers?.['X-Forwarded-Proto'] || '').toLowerCase();
    const isHttps = proto.includes('https') || req?.socket?.encrypted || process.env.NODE_ENV === 'production';
    const secureFlag = isHttps ? '; Secure' : '';
    const sameSiteFlag = isHttps ? 'SameSite=None' : 'SameSite=Lax';
    return `${sameSiteFlag}${secureFlag}`;
}

function setSessionCookie(res, token, req = null) {
    const securityFlags = getCookieSecurityFlags(req);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Vary', 'Origin, Cookie');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    const cookieValue = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=3600; HttpOnly; ${securityFlags};`;
    res.setHeader('Set-Cookie', cookieValue);
}

function getClientIp(req) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || req?.headers?.['X-Forwarded-For'] || '').trim();
    const firstForward = forwarded.split(',')[0]?.trim();
    const direct = req?.headers?.['x-real-ip'] || req?.headers?.['X-Real-IP'] || req?.headers?.['cf-connecting-ip'] || req?.headers?.['CF-Connecting-IP'] || '';
    const ip = firstForward || direct || req?.socket?.remoteAddress || 'Unknown';
    return String(ip).replace(/^::ffff:/, '').trim() || 'Unknown';
}

function normalizeFingerprint(value) {
    return String(value || '').trim().replace(/\s+/g, '').slice(0, 256);
}

function getStudentCodeCandidates(doc, fallbackCode = '') {
    const data = doc && typeof doc.data === 'function' ? doc.data() || {} : {};
    const values = [
        fallbackCode,
        data.Code,
        data.code,
        data['Student Code'],
        data.studentCode,
        data.StudentCode,
        doc?.id || ''
    ];
    return Array.from(new Set(values.filter(value => typeof value === 'string' ? value.trim() : value !== undefined && value !== null && String(value).trim()))).map(String).map(value => value.trim()));
}

async function findStudentDocument(lectureRef, submittedCode) {
    if (!lectureRef || !submittedCode) return null;

    try {
        const byDocumentId = await lectureRef.doc(submittedCode).get();
        if (byDocumentId.exists) {
            return byDocumentId;
        }
    } catch (error) {
        console.warn('findStudentDocument doc-id lookup failed:', error.message || error);
    }

    for (const fieldName of ['Code', 'code', 'Student Code', 'studentCode', 'StudentCode']) {
        try {
            const byCodeField = await lectureRef.where(fieldName, '==', submittedCode).limit(1).get();
            if (!byCodeField.empty) {
                return byCodeField.docs[0];
            }
        } catch (error) {
            console.warn(`findStudentDocument ${fieldName} lookup failed:`, error.message || error);
        }
    }

    return null;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method_not_allowed' });
    }

    try {
        const submittedCode = String(req.body?.code || '').trim();
        if (!submittedCode || submittedCode.length > 128 || /[\u0000-\u001F\u007F]/.test(submittedCode)) {
            logSecurityEvent('invalid_auth_input', { req, submittedCodeLength: submittedCode.length });
            return res.status(401).json({ authenticated: false, reason: 'invalid_input' });
        }

        const firestore = getFirestore();
        const snapshot = await firestore
            .collection('System_Control')
            .doc('Xtractor Website Protection')
            .get();
        const expectedPassword = snapshot.exists ? snapshot.data().Dr_Pass : '';

        if (safeEqual(submittedCode, expectedPassword)) {
            const token = createSessionToken({ role: 'doctor', userCode: submittedCode, issuedAt: Date.now() });
            setSessionCookie(res, token, req);
            logSecurityEvent('doctor_login_success', { req, userCode: submittedCode });
            return res.json({ authenticated: true, role: 'doctor', token });
        }

        if (!/^[A-Za-z0-9\-_]+$/.test(submittedCode)) {
            logSecurityEvent('student_login_invalid_format', { req, submittedCode });
            return res.status(401).json({ authenticated: false, reason: 'invalid_format' });
        }

        const modeSnap = await firestore.collection('MODE').doc('Website Status').get();
        const modeData = modeSnap.exists ? modeSnap.data() : {};
        const lectureNumber = Number(modeData.Lecture || 0);
        const isModeEnabled = modeData.Student_Mode === true || String(modeData.Student_Mode || '').toLowerCase() === 'on';

        if (!lectureNumber || !isModeEnabled) {
            logSecurityEvent('student_login_disabled', { req, lectureNumber, isModeEnabled });
            return res.status(401).json({ authenticated: false, reason: 'student_mode_disabled' });
        }

        const lectureRef = firestore.collection(`LEC_${lectureNumber}`);
        const studentDoc = await findStudentDocument(lectureRef, submittedCode);
        if (!studentDoc) {
            logSecurityEvent('student_login_failed', { req, lectureNumber, submittedCode });
            return res.status(401).json({ authenticated: false, reason: 'student_not_found' });
        }

        const clientIp = getClientIp(req);
        const incomingFingerprint = normalizeFingerprint(req.body?.deviceFingerprint || req.headers?.['x-device-fingerprint'] || req.headers?.['X-Device-Fingerprint'] || '');
        const studentData = studentDoc.data() || {};
        const studentCodeFromDoc = getStudentCodeCandidates(studentDoc, submittedCode)[0] || submittedCode;
        const storedIp = String(studentData.Device_ip || studentData['Device IP'] || '').trim();
        const storedFingerprint = normalizeFingerprint(studentData.Device_Fingerprint || studentData.deviceFingerprint || studentData['Device Fingerprint'] || '');

        if (!clientIp || clientIp === 'Unknown' || clientIp === 'unknown' || clientIp === '127.0.0.1' || clientIp === '::1') {
            logSecurityEvent('student_login_missing_ip', { req, lectureNumber, submittedCode, clientIp });
            return res.status(401).json({ authenticated: false, reason: 'device_ip_missing' });
        }

        if (storedIp === 'Unknown' || storedIp === 'unknown') {
            logSecurityEvent('student_login_stored_unknown_ip', { req, lectureNumber, submittedCode, storedIp });
            return res.status(401).json({ authenticated: false, reason: 'device_ip_missing' });
        }

        if (storedIp && storedIp !== 'Unknown' && storedIp !== clientIp) {
            logSecurityEvent('student_login_ip_conflict', { req, lectureNumber, submittedCode, storedIp, clientIp });
            return res.status(401).json({ authenticated: false, reason: 'device_ip_conflict' });
        }

        if (storedFingerprint && incomingFingerprint && storedFingerprint !== incomingFingerprint) {
            logSecurityEvent('student_login_fingerprint_conflict', { req, lectureNumber, submittedCode, storedFingerprint: storedFingerprint.slice(0, 32), incomingFingerprint: incomingFingerprint.slice(0, 32) });
            return res.status(401).json({ authenticated: false, reason: 'device_fingerprint_conflict' });
        }

        if (!studentCodeFromDoc || studentCodeFromDoc === 'UNKNOWN' || studentCodeFromDoc === 'unknown') {
            logSecurityEvent('student_login_missing_code', { req, lectureNumber, submittedCode, docId: studentDoc.id });
            return res.status(401).json({ authenticated: false, reason: 'student_code_missing' });
        }

        if (clientIp && clientIp !== 'Unknown' && clientIp !== '127.0.0.1') {
            const sameIpMatches = await lectureRef.where('Device_ip', '==', clientIp).limit(10).get();
            if (!sameIpMatches.empty) {
                const conflictingStudent = sameIpMatches.docs.find(doc => {
                    const docCode = String(doc.data()?.Code || doc.id || '').trim();
                    return docCode && docCode !== String(submittedCode).trim();
                });
                if (conflictingStudent) {
                    logSecurityEvent('student_login_shared_ip_detected', { req, lectureNumber, submittedCode, conflictCode: String(conflictingStudent.data()?.Code || conflictingStudent.id || '') });
                    return res.status(401).json({ authenticated: false, reason: 'shared_device_ip' });
                }
            }
        }

        if (incomingFingerprint) {
            const sameFingerprintMatches = await lectureRef.where('Device_Fingerprint', '==', incomingFingerprint).limit(10).get();
            if (!sameFingerprintMatches.empty) {
                const conflictingStudent = sameFingerprintMatches.docs.find(doc => {
                    const docCode = String(doc.data()?.Code || doc.id || '').trim();
                    return docCode && docCode !== String(submittedCode).trim();
                });
                if (conflictingStudent) {
                    logSecurityEvent('student_login_shared_fingerprint_detected', { req, lectureNumber, submittedCode, conflictCode: String(conflictingStudent.data()?.Code || conflictingStudent.id || '') });
                    return res.status(401).json({ authenticated: false, reason: 'shared_device_fingerprint' });
                }
            }
        }

        const token = createSessionToken({ role: 'student', userCode: submittedCode, lecture: lectureNumber, issuedAt: Date.now() });
        setSessionCookie(res, token, req);
        logSecurityEvent('student_login_success', { req, lectureNumber, userCode: submittedCode });
        return res.json({ authenticated: true, role: 'student', token });
    } catch (error) {
        logSecurityEvent('authentication_error', { req, message: error.message || String(error) });
        console.error('Authentication error:', error.message || error);
        return res.status(500).json({ error: 'authentication_failed' });
    }
};