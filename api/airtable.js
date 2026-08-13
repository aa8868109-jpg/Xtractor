const axios = require('axios');
const https = require('https');

// Simple in-memory cache placeholder (not used for airtable proxy but kept for symmetry)
if (!globalThis._airtableCache) globalThis._airtableCache = {};

async function fetchWithRetry(config, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await axios(config);
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

module.exports = async function (req, res) {
  // CORS for browser clients
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    // Expect path like /api/airtable/:baseId/:tableOrPath
    const incoming = req.path || req.url || req.originalUrl || '';
    // strip leading /api/airtable/
    const prefix = '/api/airtable/';
    let tail = incoming.startsWith(prefix) ? incoming.slice(prefix.length) : '';
    // If tail is empty, return 400
    if (!tail) return res.status(400).json({ error: 'Missing baseId in path' });

    // baseId is first segment
    const parts = tail.split('/');
    const baseId = parts.shift();
    const targetPath = parts.join('/') || '';

    // Preserve query string
    const query = req.url.split('?')[1] || '';
    const targetUrl = `https://api.airtable.com/v0/${baseId}/${targetPath}${query ? '?' + query : ''}`;

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Server misconfigured: AIRTABLE_API_KEY missing' });

    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    headers['Authorization'] = `Bearer ${AIRTABLE_API_KEY}`;

    const config = {
      method: req.method,
      url: targetUrl,
      headers,
      data: req.body,
      validateStatus: () => true,
      timeout: 15000,
      httpsAgent: new https.Agent({ keepAlive: true, family: 4 }),
      proxy: false
    };

    const response = await fetchWithRetry(config, 3);
    // Ensure we return JSON content-type
    res.setHeader('Content-Type', 'application/json');
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('Airtable proxy error:', err.response?.data || err.message || err);
    res.setHeader('Content-Type', 'application/json');
    return res.status(status).json({ error: 'Airtable proxy error', details: err.response?.data || err.message });
  }
};
