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
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

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

// More strict, route-specific rate limiters for sensitive operations
const protectionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many protection checks, please try again later' }
});

const airtableLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    message: { error: 'Too many Airtable proxy requests, slow down' }
});

// Strict limiter for write operations (POST/PATCH/PUT/DELETE)
const airtableWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many write operations, please wait a minute' }
});

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

app.all('/api/airtable/:baseId/*', airtableLimiter, async (req, res) => {
    const baseId = req.params.baseId;
    let targetPath = req.params[0] || '';
    // req.url may already include querystring; extract it safely
    const rawReqUrl = req.url || '';
    const qsIndex = rawReqUrl.indexOf('?');
    const query = qsIndex !== -1 ? rawReqUrl.slice(qsIndex + 1) : '';

    // If the captured targetPath already contains a '?', trust it and avoid appending the query again
    let targetUrl;
    if (targetPath.includes('?')) {
        targetUrl = `https://api.airtable.com/v0/${baseId}/${targetPath}`;
    } else {
        targetUrl = `https://api.airtable.com/v0/${baseId}/${targetPath}${query ? '?' + query : ''}`;
    }

    // Simple in-memory cache for MODE GET requests to reduce Airtable rate hits
    const MODE_CACHE_TTL_MS = 10 * 1000; // 10 seconds
    if ((req.method || 'GET').toUpperCase() === 'GET' && targetUrl.includes('/MODE')) {
        if (!global._airtableCache) global._airtableCache = {};
        const cached = global._airtableCache[targetUrl];
        if (cached && (Date.now() - cached.ts) < MODE_CACHE_TTL_MS) {
            if (VERBOSE) console.info(`Serving MODE cache for ${targetUrl}`);
            return res.status(cached.status).json(cached.data);
        }
    }

    if (!AIRTABLE_API_KEY) {
        return res.status(500).json({ error: 'Server misconfigured: AIRTABLE_API_KEY missing' });
    }

    // Build headers: only include Content-Type for methods that have a body
    const headers = {};
    const methodUpper = (req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(methodUpper)) {
        headers['Content-Type'] = 'application/json';
    }
    if (AIRTABLE_API_KEY) headers['Authorization'] = `Bearer ${AIRTABLE_API_KEY}`;

    const config = {
        method: req.method,
        url: targetUrl,
        headers,
        // Only include body for methods that expect one
        data: !['GET', 'HEAD'].includes(methodUpper) ? req.body : undefined,
        validateStatus: () => true,
        timeout: 15000,
        httpsAgent: new https.Agent({
            keepAlive: true,
            family: 4
        }),
        proxy: false
    };
    if (['GET','HEAD'].includes(methodUpper)) {
        // For GET/HEAD there is no body to forward; only log when verbose
        if (VERBOSE) {
            try { console.debug && console.debug(`Proxy: not forwarding body for ${methodUpper} ${req.url}`); } catch(e){}
        }
    }
    // Apply stricter write limiter on write methods by invoking middleware
    if (['POST','PATCH','PUT','DELETE'].includes(req.method.toUpperCase())) {
        await new Promise((resolve) => {
            airtableWriteLimiter(req, res, function next() { resolve(); });
        });
        if (res.headersSent) return; // limiter already sent a 429
    }
    try {
        const response = await fetchWithRetry(config, 3);
        if (VERBOSE) {
            try { console.info(`Airtable proxy ${response.status} ${req.method} ${targetUrl}`); } catch(e){}
        }
        // Cache MODE GET responses briefly to avoid hammering Airtable
        if ((req.method || 'GET').toUpperCase() === 'GET' && targetUrl.includes('/MODE')) {
            try {
                if (!global._airtableCache) global._airtableCache = {};
                global._airtableCache[targetUrl] = { ts: Date.now(), status: response.status, data: response.data };
            } catch (e) { /* ignore cache failures */ }
        }
        // If Airtable returned 422 (unprocessable), log the incoming body for diagnosis
        if (response.status === 422) {
            try {
                console.error('Airtable 422 — forwarded request body:', JSON.stringify(req.body));
                console.error('Airtable 422 — forwarded request headers:', JSON.stringify(req.headers));
            } catch (e) { /* ignore stringify errors */ }
        }
        // forward status and body
        res.status(response.status).json(response.data);
    } catch (err) {
        const status = err.response?.status || 500;
        console.error('Proxy final error:', status, err.response?.data || err.message || err);
        res.status(status).json({ error: 'Proxy final error', details: err.response?.data || err.message });
    }
});

// Protection endpoint: tries PROTECTION_API_KEY first then falls back to AIRTABLE_API_KEY
app.get('/api/protection', protectionLimiter, async (req, res) => {
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
