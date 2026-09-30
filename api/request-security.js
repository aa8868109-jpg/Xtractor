const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getRequestOrigin(req) {
  const origin = req.headers?.origin || req.headers?.Origin;
  if (!origin || origin === 'null') return null;

  try {
    return new URL(origin).origin;
  } catch (error) {
    return null;
  }
}

function isSameOriginRequest(req) {
  const origin = getRequestOrigin(req);
  if (!origin) return false;

  const headers = req.headers || {};
  const host = String(headers.host || '').trim().toLowerCase();
  const forwardedProtocol = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProtocol || (req.socket?.encrypted ? 'https' : 'http');
  return Boolean(host && origin === `${protocol}://${host}`);
}

function enforceSameOrigin(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  const originHeader = req.headers?.origin || req.headers?.Origin;
  const hasCookie = Boolean(req.headers?.cookie || req.headers?.Cookie);

  if (originHeader && !isSameOriginRequest(req)) {
    res.status(403).json({ error: 'cross_origin_request_denied' });
    return false;
  }

  if (!SAFE_METHODS.has(method) && hasCookie && !originHeader) {
    res.status(403).json({ error: 'origin_required' });
    return false;
  }

  return true;
}

module.exports = { enforceSameOrigin, getRequestOrigin, isSameOriginRequest };