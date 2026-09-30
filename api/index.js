const protectionHandler = require('./protection');
const dataHandler = require('./data/[...slug]');
const authHandler = require('./auth');
const exportHandler = require('./export');
const { enforceSameOrigin } = require('./request-security');

function parseFormData(raw) {
  const result = {};
  if (!raw || typeof raw !== 'string') return result;

  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const [key, ...rest] = pair.split('=');
    if (!key) continue;
    const decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
    const decodedValue = decodeURIComponent((rest.join('=') || '').replace(/\+/g, ' '));
    result[decodedKey] = decodedValue;
  }

  return result;
}

async function parseRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return req.body;
  }

  const contentType = String(req.headers?.['content-type'] || req.headers?.['Content-Type'] || '');

  if (!req.readable || req.method === 'GET' || req.method === 'HEAD') {
    return {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }

  try {
    if (contentType.includes('application/json')) {
      return JSON.parse(raw);
    }

    if (contentType.includes('application/x-www-form-urlencoded')) {
      return parseFormData(raw);
    }

    try {
      return JSON.parse(raw);
    } catch (jsonError) {
      return parseFormData(raw);
    }
  } catch (error) {
    console.warn('api/index body parse failed:', error.message || error);
    return {};
  }
}

module.exports = async function handler(req, res) {
  try {
    const parsedBody = await parseRequestBody(req);
    req.body = parsedBody;

    if (!enforceSameOrigin(req, res)) return;

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const url = new URL(req.url || '/', 'https://example.com');
    const pathname = url.pathname || '/';

    if (pathname === '/api/protection' || pathname.startsWith('/api/protection/')) {
      return protectionHandler(req, res);
    }

    if (pathname === '/api/auth') {
      return authHandler(req, res);
    }

    if (pathname === '/api/export') {
      return exportHandler(req, res);
    }

    if (pathname.startsWith('/api/data/')) {
      const rest = pathname.replace(/^\/api\/data\/?/, '').split('/').filter(Boolean);
      const req2 = {
        ...req,
        url: pathname + url.search,
        originalUrl: pathname + url.search,
        query: {
          ...(req.query || {}),
          slug: rest
        },
        params: {
          ...(req.params || {}),
          slug: rest
        }
      };
      return dataHandler(req2, res);
    }

    return res.status(404).json({ error: 'API route not found', path: pathname });
  } catch (err) {
    console.error('api/index handler error:', err);
    return res.status(500).json({ error: 'API handler failed' });
  }
};
