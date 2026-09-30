const { getFirestore } = require('../lib/firebase');
const { checkRateLimit } = require('../lib/rate-limit');
const { enforceSameOrigin } = require('../lib/request-security');

// Simple in-memory cache — per-instance, short TTL
const CACHE_TTL_MS = 30 * 1000;
if (!global._protectionCache) global._protectionCache = { ts: 0, data: null };

module.exports = async function handler(req, res) {
  if (!enforceSameOrigin(req, res)) return;
  if (!checkRateLimit(req, res, { endpoint: 'protection', maxRequests: 20, windowMs: 60000 })) return;

  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

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
      console.error('Protection settings unavailable:', err && err.message ? err.message : err);
      return res.status(503).json({ success: false, error: 'protection_unavailable' });
    }
  } catch (err) {
    console.error('Protection handler fatal error:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'protection_handler_failed' });
  }
};
