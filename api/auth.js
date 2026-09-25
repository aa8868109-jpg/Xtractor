const crypto = require('crypto');
const { getFirestore } = require('./firebase');
const { SESSION_COOKIE_NAME, createSessionToken } = require('./session');

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function setSessionCookie(res, token) {
    const isProduction = process.env.NODE_ENV === 'production';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; ${isProduction ? 'Secure;' : ''}`
    );
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method_not_allowed' });
    }

    try {
        const submittedCode = String(req.body?.code || '').trim();
        if (!submittedCode || submittedCode.length > 128) {
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
            setSessionCookie(res, token);
            return res.json({ authenticated: true, role: 'doctor', token });
        }

        const modeSnap = await firestore.collection('MODE').doc('Website Status').get();
        const modeData = modeSnap.exists ? modeSnap.data() : {};
        const lectureNumber = Number(modeData.Lecture || 0);
        const isModeEnabled = modeData.Student_Mode === true || String(modeData.Student_Mode || '').toLowerCase() === 'on';

        if (!lectureNumber || !isModeEnabled) {
            return res.status(401).json({ authenticated: false });
        }

        const lectureRef = firestore.collection(`LEC_${lectureNumber}`);
        const studentSnap = await lectureRef.where('Code', '==', submittedCode).limit(1).get();
        if (studentSnap.empty) {
            return res.status(401).json({ authenticated: false });
        }

        const token = createSessionToken({ role: 'student', userCode: submittedCode, lecture: lectureNumber, issuedAt: Date.now() });
        setSessionCookie(res, token);
        return res.json({ authenticated: true, role: 'student', token });
    } catch (error) {
        console.error('Authentication error:', error.message || error);
        return res.status(500).json({ error: 'authentication_failed' });
    }
};