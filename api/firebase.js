const admin = require('firebase-admin');

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        const serviceAccount = JSON.parse(raw);
        if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
            throw new Error('Firebase service account JSON is missing required fields');
        }
        return serviceAccount;
    }

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            project_id: process.env.FIREBASE_PROJECT_ID,
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\r?\n/g, '\n')
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
