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
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=3600; HttpOnly; ${securityFlags};`
    );
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method_not_allowed' });
    }

    try {
        const submittedCode = String(req.body?.code || '').trim();
        if (!submittedCode || submittedCode.length > 128 || /[\u0000-\u001F\u007F]/.test(submittedCode)) {
            logSecurityEvent('invalid_auth_input', { req, submittedCodeLength: submittedCode.length });
            return res.status(401).json({ authenticated: false });
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
            return res.status(401).json({ authenticated: false });
        }

        const modeSnap = await firestore.collection('MODE').doc('Website Status').get();
        const modeData = modeSnap.exists ? modeSnap.data() : {};
        const lectureNumber = Number(modeData.Lecture || 0);
        const isModeEnabled = modeData.Student_Mode === true || String(modeData.Student_Mode || '').toLowerCase() === 'on';

        if (!lectureNumber || !isModeEnabled) {
            logSecurityEvent('student_login_disabled', { req, lectureNumber, isModeEnabled });
            return res.status(401).json({ authenticated: false });
        }

        const lectureRef = firestore.collection(`LEC_${lectureNumber}`);
        const studentSnap = await lectureRef.where('Code', '==', submittedCode).limit(1).get();
        if (studentSnap.empty) {
            logSecurityEvent('student_login_failed', { req, lectureNumber, submittedCode });
            return res.status(401).json({ authenticated: false });
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