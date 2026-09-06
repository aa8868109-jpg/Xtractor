const axios = require('axios');
const https = require('https');

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

// Short MODE cache per-instance
const MODE_CACHE_TTL_MS = 10 * 1000;
if (!global._airtableCache) global._airtableCache = {};

module.exports = async function handler(req, res) {
  try {
    // req.query.slug may be array or string depending on framework; normalize
    const raw = req.query && req.query.slug ? req.query.slug : [];
    const parts = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split('/') : []);
    if (parts.length < 1) return res.status(400).json({ error: 'Missing baseId in path' });
    const baseId = parts[0];
    const targetPath = parts.slice(1).join('/') || '';

    // reconstruct querystring
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    let targetUrl = '';
    if (targetPath.includes('?')) targetUrl = `https://api.airtable.com/v0/${baseId}/${targetPath}`;
    else targetUrl = `https://api.airtable.com/v0/${baseId}/${targetPath}${qs ? '?' + qs : ''}`;

    if ((req.method || 'GET').toUpperCase() === 'GET' && targetUrl.includes('/MODE')) {
      const cached = global._airtableCache[targetUrl];
      if (cached && (Date.now() - cached.ts) < MODE_CACHE_TTL_MS) {
        return res.status(cached.status).json(cached.data);
      }
    }

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Server misconfigured: AIRTABLE_API_KEY missing' });

    const methodUpper = (req.method || 'GET').toUpperCase();
    const headers = {};
    if (!['GET', 'HEAD'].includes(methodUpper)) headers['Content-Type'] = 'application/json';
    headers['Authorization'] = `Bearer ${AIRTABLE_API_KEY}`;

    const config = {
      method: req.method,
      url: targetUrl,
      headers,
      data: !['GET','HEAD'].includes(methodUpper) ? req.body : undefined,
      validateStatus: () => true,
      timeout: 15000,
      httpsAgent: new https.Agent({ keepAlive: true, family: 4 }),
      proxy: false
    };

    try {
      const response = await fetchWithRetry(config, 3);
      if ((req.method || 'GET').toUpperCase() === 'GET' && targetUrl.includes('/MODE')) {
        try { global._airtableCache[targetUrl] = { ts: Date.now(), status: response.status, data: response.data }; } catch(e){}
      }
      return res.status(response.status).json(response.data);
    } catch (err) {
      const status = err.response?.status || 500;
      return res.status(status).json({ error: 'Proxy final error', details: err.response?.data || err.message });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || err });
  }
};
