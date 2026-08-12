const axios = require('axios');

// Simple in-memory cache reused by warm serverless instances
if (!globalThis._protectionCache) globalThis._protectionCache = { ts: 0, data: null };

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const CACHE_TTL_MS = 30 * 1000;
    const now = Date.now();
    if (globalThis._protectionCache.data && (now - globalThis._protectionCache.ts) < CACHE_TTL_MS) {
      return res.json({ success: true, used: 'cache', data: globalThis._protectionCache.data });
    }

    const PROTECTION_BASE_ID = process.env.PROTECTION_BASE_ID;
    const PROTECTION_TABLE = process.env.PROTECTION_TABLE || 'Protection';
    const PROTECTION_API_KEY = process.env.PROTECTION_API_KEY;
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

    if (!PROTECTION_BASE_ID) {
      return res.status(500).json({ success: false, error: 'PROTECTION_BASE_ID not configured' });
    }

    const url = `https://api.airtable.com/v0/${PROTECTION_BASE_ID}/${encodeURIComponent(PROTECTION_TABLE)}`;

    const httpsAgent = new (require('https').Agent)({ keepAlive: true, family: 4 });

    // Try protection key first
    if (PROTECTION_API_KEY) {
      try {
        const r = await axios.get(url, {
          headers: { Authorization: `Bearer ${PROTECTION_API_KEY}` },
          timeout: 15000,
          httpsAgent,
          validateStatus: () => true
        });
        if (r.status === 200) {
          globalThis._protectionCache.ts = Date.now();
          globalThis._protectionCache.data = r.data;
          return res.json({ success: true, used: 'protection', data: r.data });
        }
        // If unauthorized, fallthrough to main key
        if (r.status !== 401) {
          return res.status(r.status).json({ success: false, error: r.data || `Status ${r.status}` });
        }
      } catch (err) {
        console.error('Protection fetch (protection key) error:', err.message || err);
      }
    }

    // Fallback to main Airtable key
    if (AIRTABLE_API_KEY) {
      try {
        const r2 = await axios.get(url, {
          headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
          timeout: 15000,
          httpsAgent,
          validateStatus: () => true
        });
        if (r2.status === 200) {
          globalThis._protectionCache.ts = Date.now();
          globalThis._protectionCache.data = r2.data;
          return res.json({ success: true, used: 'main', data: r2.data });
        }
        return res.status(r2.status).json({ success: false, error: r2.data || `Status ${r2.status}` });
      } catch (err) {
        console.error('Protection fetch (main key) error:', err.message || err);
        return res.status(500).json({ success: false, error: err.message || err });
      }
    }

    return res.status(500).json({ success: false, error: 'No API key configured on server' });
  } catch (err) {
    console.error('Protection handler error:', err.message || err);
    return res.status(500).json({ success: false, error: err.message || err });
  }
};
