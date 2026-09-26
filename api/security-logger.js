function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || req.headers?.['x-real-ip'] || 'unknown';
}

function logSecurityEvent(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ip: getClientIp(details.req || {}),
    ...details
  };

  delete payload.req;
  console.warn('[security]', JSON.stringify(payload));
}

module.exports = {
  logSecurityEvent
};
