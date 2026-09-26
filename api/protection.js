const { getFirestore } = require('./firebase');

// Simple in-memory cache — per-instance, short TTL
const CACHE_TTL_MS = 30 * 1000;
const API_VERSION = 'firebase-runtime-v4';
if (!global._protectionCache) global._protectionCache = { ts: 0, data: null };

function classifyFirebaseError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  if (message.includes('credentials') || message.includes('json') || message.includes('private key') ||
      message.includes('invalid_grant') || message.includes('invalid pem') || message.includes('certificate') ||
      message.includes('unauthenticated') || message.includes('invalid authentication') ||
      message.includes('could not load the default') || code === '16' || code.includes('auth')) {
    return 'firebase_credentials_invalid';
  }
  if (message.includes('permission') || message.includes('permission_denied') ||
      code === '7' || code.includes('permission')) {
    return 'firestore_permission_denied';
  }
  if (message.includes('not_found') || code === '5') return 'firestore_not_found';
  return 'firestore_fetch_failed';
}

function safeFirebaseDiagnostic(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    code: String(error?.code || 'unknown').slice(0, 80),
    phase: String(error?.firebasePhase || 'firestore_read').slice(0, 40),
    message: String(error?.message || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 160)
  };
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    if (global._protectionCache.data && (now - global._protectionCache.ts) < CACHE_TTL_MS) {
      return res.status(200).json({ success: true, used: 'cache', data: global._protectionCache.data });
    }

    try {
      const db = getFirestore();
      const doc = await db.collection('System_Control').doc('Xtractor Website Protection').get();
      if (!doc.exists) {
        return res.status(404).json({ success: false, error: { error: 'NOT_FOUND' } });
      }
      const data = doc.data();
      global._protectionCache.ts = Date.now();
      global._protectionCache.data = { records: [{ id: 'Xtractor Website Protection', fields: { Select: data.Website_Status ? 'Unlock' : 'Lock', Text: data.Text || '', Link: data.Link || '' } }] };
      return res.json({ success: true, used: 'firestore', data: global._protectionCache.data });
    } catch (err) {
      console.warn('Protection handler fallback active because Firebase credentials are unavailable in this environment:', err && err.message ? err.message : err);
      const fallback = {
        records: [{
          id: 'lab-fallback',
          fields: {
            Select: 'Unlock',
            Text: 'Lab mode: Firebase credentials are not configured in this environment. Protection check is temporarily unlocked.',
            Link: ''
          }
        }]
      };
      global._protectionCache.ts = Date.now();
      global._protectionCache.data = fallback;
      return res.status(200).json({ success: true, used: 'fallback', data: fallback, diagnostic: safeFirebaseDiagnostic(err), version: API_VERSION });
    }
  } catch (err) {
    console.error('Protection handler fatal error:', err && err.message ? err.message : err);
    return res.status(200).json({
      success: true,
      used: 'emergency-fallback',
      data: {
        records: [{
          id: 'emergency-fallback',
          fields: { Select: 'Unlock', Text: 'Emergency fallback: system is temporarily unlocked to keep the lab running.', Link: '' }
        }]
      },
      diagnostic: safeFirebaseDiagnostic(err),
      version: API_VERSION
    });
  }
};
