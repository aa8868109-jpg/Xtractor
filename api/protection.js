const axios = require('axios');
const https = require('https');

// Simple in-memory cache — per-instance, short TTL
const CACHE_TTL_MS = 30 * 1000;
if (!global._protectionCache) global._protectionCache = { ts: 0, data: null };

async function fetchWithRetry(config, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const resp = await axios(config);
      return resp;
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = err.response?.headers?.['retry-after'];
      if ((status === 429 || (status >= 500 && status < 600)) && attempt <= maxRetries) {
        let waitMs = 500 * Math.pow(2, attempt - 1);
        if (retryAfter) {
          const ra = parseInt(retryAfter, 10);
          if (!isNaN(ra)) waitMs = Math.max(waitMs, ra * 1000);
        }
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    if (global._protectionCache.data && (now - global._protectionCache.ts) < CACHE_TTL_MS) {
      return res.status(200).json({ success: true, used: 'cache', data: global._protectionCache.data });
    }

    const PROTECTION_API_KEY = process.env.PROTECTION_API_KEY;
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const baseId = process.env.PROTECTION_BASE_ID;
    const table = process.env.PROTECTION_TABLE || 'Protection';
    if (!baseId) return res.status(500).json({ error: 'PROTECTION_BASE_ID not configured' });

    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;

    // Try protection key first
    try {
      if (PROTECTION_API_KEY) {
        const r = await fetchWithRetry({ method: 'get', url, headers: { Authorization: `Bearer ${PROTECTION_API_KEY}` }, validateStatus: () => true, timeout: 15000, httpsAgent: new https.Agent({ keepAlive: true, family: 4 }), proxy: false }, 3);
        if (r.status === 200) {
          global._protectionCache.ts = Date.now();
          global._protectionCache.data = r.data;
          return res.json({ success: true, used: 'protection', data: r.data });
        }
        if (r.status === 401 && AIRTABLE_API_KEY) {
          const r2 = await fetchWithRetry({ method: 'get', url, headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }, validateStatus: () => true, timeout: 15000, httpsAgent: new https.Agent({ keepAlive: true, family: 4 }), proxy: false }, 3);
          if (r2.status === 200) {
            global._protectionCache.ts = Date.now();
            global._protectionCache.data = r2.data;
            return res.json({ success: true, used: 'main', data: r2.data });
          }
          return res.status(r2.status).json({ success: false, error: r2.data || `Status ${r2.status}` });
        }
        return res.status(r.status).json({ success: false, error: r.data || `Status ${r.status}` });
      }

      if (AIRTABLE_API_KEY) {
        const r2 = await fetchWithRetry({ method: 'get', url, headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }, validateStatus: () => true, timeout: 15000, httpsAgent: new https.Agent({ keepAlive: true, family: 4 }), proxy: false }, 3);
        if (r2.status === 200) {
          global._protectionCache.ts = Date.now();
          global._protectionCache.data = r2.data;
          return res.json({ success: true, used: 'main', data: r2.data });
        }
        return res.status(r2.status).json({ success: false, error: r2.data || `Status ${r2.status}` });
      }
      return res.status(500).json({ success: false, error: 'No API key configured on server' });
    } catch (err) {
      const status = err.response?.status || 500;
      return res.status(status).json({ success: false, error: err.response?.data || err.message });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || err });
  }
};
