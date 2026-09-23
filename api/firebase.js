const admin = require('firebase-admin');
const { initializeFirestore } = require('firebase-admin/firestore');
let firestore = null;

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
        return {
            projectId: cleanEnvValue(serviceAccount.project_id),
            clientEmail: cleanEnvValue(serviceAccount.client_email),
            privateKey: normalizePrivateKey(serviceAccount.private_key)
        };
    }

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            projectId: cleanEnvValue(process.env.FIREBASE_PROJECT_ID),
            clientEmail: cleanEnvValue(process.env.FIREBASE_CLIENT_EMAIL),
            privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        };
    }

    throw new Error('Firebase credentials are not configured');
}

function getFirestore() {
    if (firestore) return firestore;

    let app;
    if (!admin.apps.length) {
        const serviceAccount = loadServiceAccount();
        app = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: serviceAccount.projectId
        });
    } else {
        app = admin.app();
    }

    firestore = initializeFirestore(app, { preferRest: true });
    return firestore;
}

module.exports = { getFirestore };
