const protectionHandler = require('./protection');
const dataHandler = require('./data/[...slug]');
const authHandler = require('./auth');
const { checkRateLimit } = require('./rate-limit');
const { logSecurityEvent } = require('./security-logger');

module.exports = async function handler(req, res) {
  try {
    const origin = req.headers?.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Cookie');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const url = new URL(req.url || '/', 'https://example.com');
    const pathname = url.pathname || '/';

    if (pathname === '/api/protection' || pathname.startsWith('/api/protection/')) {
      if (!checkRateLimit(req, res, { endpoint: 'protection', maxRequests: 20, windowMs: 60000 })) return;
      return protectionHandler(req, res);
    }

    if (pathname === '/api/auth') {
      if (!checkRateLimit(req, res, { endpoint: 'auth', maxRequests: 10, windowMs: 60000 })) return;
      return authHandler(req, res);
    }

    if (pathname.startsWith('/api/data/')) {
      if (!checkRateLimit(req, res, { endpoint: 'data', maxRequests: 120, windowMs: 60000 })) return;
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
    return res.status(500).json({ error: 'API handler failed', details: err.message || String(err) });
  }
};
