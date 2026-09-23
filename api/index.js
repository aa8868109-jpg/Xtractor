const protectionHandler = require('./protection');
const dataHandler = require('./data/[...slug]');
const authHandler = require('./auth');

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'https://example.com');
    const pathname = url.pathname || '/';

    if (pathname === '/api/protection' || pathname.startsWith('/api/protection/')) {
      return protectionHandler(req, res);
    }

    if (pathname === '/api/auth') {
      return authHandler(req, res);
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
    return res.status(500).json({ error: 'API handler failed', details: err.message || String(err) });
  }
};
