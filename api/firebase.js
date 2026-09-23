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
            project_id: cleanEnvValue(serviceAccount.project_id),
            client_email: cleanEnvValue(serviceAccount.client_email),
            private_key: normalizePrivateKey(serviceAccount.private_key)
        };
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
    if (firestore) return firestore;

    let app;
    const serviceAccount = loadServiceAccount();
    let credential;
    try {
        credential = admin.credential.cert(serviceAccount);
    } catch (error) {
        error.firebasePhase = 'credential_cert';
        throw error;
    }

    try {
        if (!admin.apps.length) {
            app = admin.initializeApp({
                credential,
                projectId: serviceAccount.project_id
            });
        } else {
            app = admin.app();
        }
    } catch (error) {
        error.firebasePhase = 'admin_initialize';
        throw error;
    }

    try {
        firestore = initializeFirestore(app, { preferRest: true });
        return firestore;
    } catch (error) {
        error.firebasePhase = 'firestore_initialize';
        throw error;
    }
}

module.exports = { getFirestore };
