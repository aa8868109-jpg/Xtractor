const admin = require('firebase-admin');

function cleanEnvValue(value) {
    const cleaned = String(value || '').trim();
    if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
        return cleaned.slice(1, -1);
    }
    return cleaned;
}

function normalizePrivateKey(value) {
    const privateKey = cleanEnvValue(value).replace(/\\n/g, '\n').replace(/\r?\n/g, '\n');
    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
        throw new Error('Firebase private key is missing PEM boundaries');
    }
    return privateKey;
}

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        let serviceAccount = JSON.parse(raw);
        if (typeof serviceAccount === 'string') {
            serviceAccount = JSON.parse(serviceAccount);
        }
        if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
            throw new Error('Firebase service account JSON is missing required fields');
        }
        serviceAccount.project_id = cleanEnvValue(serviceAccount.project_id);
        serviceAccount.client_email = cleanEnvValue(serviceAccount.client_email);
        serviceAccount.private_key = normalizePrivateKey(serviceAccount.private_key);
        return serviceAccount;
    }

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            project_id: cleanEnvValue(process.env.FIREBASE_PROJECT_ID),
            client_email: cleanEnvValue(process.env.FIREBASE_CLIENT_EMAIL),
            private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        };
    }

    throw new Error('Firebase credentials are not configured');
}

function getFirestore() {
    if (!admin.apps.length) {
        const serviceAccount = loadServiceAccount();
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
        });
    }

    return admin.firestore();
}

module.exports = { getFirestore };
