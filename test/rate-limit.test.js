const assert = require('node:assert/strict');
const test = require('node:test');
const { checkRateLimit } = require('../lib/rate-limit');

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('rate limits authenticated identities independently behind one shared IP', () => {
  const req = { headers: { 'x-forwarded-for': '192.0.2.10' } };
  const endpoint = `data-session-test-${Date.now()}`;
  const options = { endpoint, maxRequests: 1, windowMs: 60000 };
  const firstResponse = createResponse();
  const secondResponse = createResponse();
  const blockedResponse = createResponse();

  assert.equal(checkRateLimit(req, firstResponse, { ...options, identity: 'student:S-1' }), true);
  assert.equal(checkRateLimit(req, secondResponse, { ...options, identity: 'student:S-2' }), true);
  assert.equal(checkRateLimit(req, blockedResponse, { ...options, identity: 'student:S-1' }), false);
  assert.equal(blockedResponse.statusCode, 429);
});
