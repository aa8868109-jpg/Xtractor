const { getFirestore } = require('./firebase');

// Simple in-memory cache — per-instance, short TTL
const CACHE_TTL_MS = 30 * 1000;
if (!global._protectionCache) global._protectionCache = { ts: 0, data: null };

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    if (global._protectionCache.data && (now - global._protectionCache.ts) < CACHE_TTL_MS) {
      return res.status(200).json({ success: true, used: 'cache', data: global._protectionCache.data });
    }

    // Firestore-only protection endpoint
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
      console.error('Protection handler firestore read error:', err && err.message ? err.message : err);
      const message = String(err?.message || '');
      const normalizedMessage = message.toLowerCase();
      const errorCode = String(err?.code || '').toLowerCase();
      const error = normalizedMessage.includes('credentials') || normalizedMessage.includes('json') ||
        normalizedMessage.includes('private key') || normalizedMessage.includes('invalid_grant') ||
        normalizedMessage.includes('invalid pem') || normalizedMessage.includes('certificate') ||
        errorCode.includes('auth')
        ? 'firebase_credentials_invalid'
        : normalizedMessage.includes('permission') || normalizedMessage.includes('permission_denied') ||
          errorCode === '7' || errorCode.includes('permission')
          ? 'firestore_permission_denied'
          : normalizedMessage.includes('not_found') || errorCode === '5'
            ? 'firestore_not_found'
          : 'firestore_fetch_failed';
      return res.status(500).json({ success: false, error });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || err });
  }
};
