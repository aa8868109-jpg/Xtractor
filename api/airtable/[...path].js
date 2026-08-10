const axios = require('axios');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    // Debug: log incoming request info to help diagnose 400s
    console.log('airtable-proxy request', { method: req.method, url: req.url, query: req.query });

    const { path = '' } = req.query;
    let segments = String(path).split('/').filter(Boolean);

    // Fallback: some environments may not populate req.query.path for catch-all routes
    // Attempt to extract segments from req.url if initial segments are empty
    if (segments.length < 1 && typeof req.url === 'string') {
      try {
        const fallback = req.url.split('/api/airtable/')[1] || '';
        segments = String(fallback).split('/').filter(Boolean);
        console.log('airtable-proxy fallback segments', { fallback, segments });
      } catch (e) {
        // ignore fallback errors
      }
    }

    if (segments.length < 1) {
      // Return detailed debug info to logs/response to aid troubleshooting
      const debug = { message: 'Missing Airtable table path', query: req.query, url: req.url };
      console.warn('airtable-proxy bad request', debug);
      res.status(400).json(debug);
      return;
    }

    const isProtection = segments[0] === 'protection';
    const table = segments[0];
    const recordId = segments[1] || null;
    const apiKey = isProtection
      ? (process.env.PROTECTION_API_KEY || process.env.AIRTABLE_API_KEY)
      : process.env.AIRTABLE_API_KEY;
    const baseId = isProtection
      ? (process.env.PROTECTION_BASE_ID || process.env.AIRTABLE_BASE_ID)
      : process.env.AIRTABLE_BASE_ID;

    if (!baseId || !apiKey) {
      res.status(500).json({ error: 'Airtable credentials are not configured' });
      return;
    }

    const url = recordId
      ? `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`
      : `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;

    const response = await axios({
      method: req.method,
      url,
      params: req.query,
      data: req.body,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message, details: error.response?.data || null });
  }
};
