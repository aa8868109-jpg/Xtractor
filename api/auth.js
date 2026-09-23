const crypto = require('crypto');
const { getFirestore } = require('./firebase');

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
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

        const snapshot = await getFirestore()
            .collection('System_Control')
            .doc('Xtractor Website Protection')
            .get();
        const expectedPassword = snapshot.exists ? snapshot.data().Dr_Pass : '';

        if (!safeEqual(submittedCode, expectedPassword)) {
            return res.status(401).json({ authenticated: false });
        }

        return res.json({ authenticated: true, role: 'doctor' });
    } catch (error) {
        console.error('Authentication error:', error.message || error);
        return res.status(500).json({ error: 'authentication_failed' });
    }
};