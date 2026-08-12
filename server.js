const express = require('express');
const axios = require('axios');
const https = require('https');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const PROTECTION_API_KEY = process.env.PROTECTION_API_KEY;

function isPlaceholderKey(value) {
    return !value || value.trim() === '' || value.startsWith('your_') || value.includes('your_');
}

if (isPlaceholderKey(AIRTABLE_API_KEY)) {
    console.error('ERROR: AIRTABLE_API_KEY is missing or still a placeholder in .env. Set a real Airtable API key.');
    process.exit(1);
}

if (isPlaceholderKey(PROTECTION_API_KEY)) {
    console.warn('WARNING: PROTECTION_API_KEY is missing or placeholder in .env. Protection endpoint will use the main API key only.');
}

// Basic security with CSP that allows required CDN scripts, inline execution, and Google fonts
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                'https://cdnjs.cloudflare.com',
                'https://cdn.jsdelivr.net'
            ],
            scriptSrcAttr: [
                "'self'",
                "'unsafe-inline'",
                'https://cdnjs.cloudflare.com',
                'https://cdn.jsdelivr.net'
            ],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            styleSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', "'unsafe-inline'"],
            fontSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
        }
    }
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting to reduce abuse
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

// Serve static client files
app.use(express.static(path.join(__dirname)));

// Simple allow list for CORS - allow same origin by default
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Proxy Airtable requests under /api/airtable/:baseId/*
// Helper: fetch with retry/backoff for rate-limited Airtable responses
async function fetchWithRetry(config, maxRetries = 3) {
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            const resp = await axios(config);
            // return raw response even for non-2xx so caller can forward status
            return resp;
        } catch (err) {
            const status = err.response?.status;
            const retryAfter = err.response?.headers?.['retry-after'];
            // Retry on 429 (rate limit) or 5xx server errors
            if ((status === 429 || (status >= 500 && status < 600)) && attempt <= maxRetries) {
                let waitMs = 500 * Math.pow(2, attempt - 1); // exponential backoff
                if (retryAfter) {
                    const ra = parseInt(retryAfter, 10);
                    if (!isNaN(ra)) waitMs = Math.max(waitMs, ra * 1000);
                }
                console.warn(`Airtable ${status} - retrying attempt ${attempt}/${maxRetries} after ${waitMs}ms`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            // Not retryable or max attempts reached
            throw err;
        }
    }
}

app.all('/api/airtable/:baseId/*', async (req, res) => {
    const baseId = req.params.baseId;
    const targetPath = req.params[0] || '';
    const query = req.url.split('?')[1] || '';
    const targetUrl = `https://api.airtable.com/v0/${baseId}/${targetPath}${query ? '?' + query : ''}`;

    if (!AIRTABLE_API_KEY) {
        return res.status(500).json({ error: 'Server misconfigured: AIRTABLE_API_KEY missing' });
    }

    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    if (AIRTABLE_API_KEY) headers['Authorization'] = `Bearer ${AIRTABLE_API_KEY}`;

    const config = {
        method: req.method,
        url: targetUrl,
        headers,
        data: req.body,
        validateStatus: () => true,
        timeout: 15000,
        httpsAgent: new https.Agent({
            keepAlive: true,
            family: 4
        }),
        proxy: false
    };

    try {
        const response = await fetchWithRetry(config, 3);
        // forward status and body
        res.status(response.status).json(response.data);
    } catch (err) {
        const status = err.response?.status || 500;
        console.error('Proxy final error:', status, err.response?.data || err.message || err);
        res.status(status).json({ error: 'Proxy final error', details: err.response?.data || err.message });
    }
});

// Protection endpoint: tries PROTECTION_API_KEY first then falls back to AIRTABLE_API_KEY
app.get('/api/protection', async (req, res) => {
    try {
        // In-memory cache to reduce rate-limit calls to Airtable
        const CACHE_TTL_MS = 30 * 1000; // 30 seconds
        if (!global._protectionCache) global._protectionCache = { ts: 0, data: null };
        const now = Date.now();
        if (global._protectionCache.data && (now - global._protectionCache.ts) < CACHE_TTL_MS) {
            return res.json({ success: true, used: 'cache', data: global._protectionCache.data });
        }

        const baseId = process.env.PROTECTION_BASE_ID;
        const table = process.env.PROTECTION_TABLE || 'Protection';
        if (!baseId) return res.status(500).json({ error: 'PROTECTION_BASE_ID not configured' });

        const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;

        // Try with protection key first, with retries
        try {
            // Try protection key if configured
            if (PROTECTION_API_KEY) {
                const r = await fetchWithRetry({ method: 'get', url, headers: { Authorization: `Bearer ${PROTECTION_API_KEY}` }, validateStatus: () => true }, 3);
                if (r.status === 200) {
                    global._protectionCache.ts = Date.now();
                    global._protectionCache.data = r.data;
                    return res.json({ success: true, used: 'protection', data: r.data });
                }
                // if unauthorized, attempt fallback
                if (r.status === 401 && AIRTABLE_API_KEY) {
                    const r2 = await fetchWithRetry({ method: 'get', url, headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }, validateStatus: () => true }, 3);
                    if (r2.status === 200) {
                        global._protectionCache.ts = Date.now();
                        global._protectionCache.data = r2.data;
                        return res.json({ success: true, used: 'main', data: r2.data });
                    }
                    return res.status(r2.status).json({ success: false, error: r2.data || `Status ${r2.status}` });
                }
                // return the protection attempt status if not successful
                return res.status(r.status).json({ success: false, error: r.data || `Status ${r.status}` });
            }

            // If no protection key configured, try main key
            if (AIRTABLE_API_KEY) {
                const r2 = await fetchWithRetry({ method: 'get', url, headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }, validateStatus: () => true }, 3);
                if (r2.status === 200) {
                    global._protectionCache.ts = Date.now();
                    global._protectionCache.data = r2.data;
                    return res.json({ success: true, used: 'main', data: r2.data });
                }
                return res.status(r2.status).json({ success: false, error: r2.data || `Status ${r2.status}` });
            }
            return res.status(500).json({ success: false, error: 'No API key configured on server' });
        } catch (err) {
            console.error('Protection fetch error:', err.response?.status, err.response?.data || err.message || err);
            const status = err.response?.status || 500;
            return res.status(status).json({ success: false, error: err.response?.data || err.message });
        }
    } catch (err) {
        console.error('Protection check error:', err.message || err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fallback API to check server health
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
