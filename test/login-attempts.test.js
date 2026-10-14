const assert = require('node:assert/strict');
const test = require('node:test');
const {
  checkLoginRateLimit,
  hashLoginIdentifier,
  recordLoginAttempt
} = require('../lib/login-attempts');

process.env.LOGIN_IDENTIFIER_HMAC_KEY = 'test-only-login-hash-key';

function makeDb(initialAttempts = []) {
  const attempts = [...initialAttempts];
  return {
    attempts,
    collection(name) {
      assert.equal(name, 'LOGIN');
      return {
        add: async record => attempts.push(record),
        where(field, operator, value) {
          const conditions = [[field, operator, value]];
          const query = {
            where(nextField, nextOperator, nextValue) {
              conditions.push([nextField, nextOperator, nextValue]);
              return query;
            },
            orderBy(field, direction) {
              query.sortField = field;
              query.sortDirection = direction;
              return query;
            },
            limit(maximum) {
              query.maximum = maximum;
              return query;
            },
            async get() {
              const docs = attempts
                .filter(attempt => conditions.every(([conditionField, conditionOperator, conditionValue]) => {
                  if (conditionOperator === '==') return attempt[conditionField] === conditionValue;
                  if (conditionOperator === '>=') {
                    return new Date(attempt[conditionField]) >= conditionValue;
                  }
                  return false;
                }))
                .sort((left, right) => {
                  const difference = new Date(left[query.sortField]) - new Date(right[query.sortField]);
                  return query.sortDirection === 'desc' ? -difference : difference;
                })
                .slice(0, query.maximum)
                .map((attempt, index) => ({ id: String(index), data: () => attempt }));
              return { docs };
            }
          };
          return query;
        }
      };
    }
  };
}

test('persists each login attempt with the required Firestore fields and types', async () => {
  const db = makeDb();
  const req = {
    headers: {
      'x-forwarded-for': '192.0.2.15',
      'user-agent': 'Test Browser'
    }
  };

  await recordLoginAttempt(db, req, 'Student-1', false);

  assert.equal(db.attempts.length, 1);
  const [attempt] = db.attempts;
  assert.equal(attempt.IP, '192.0.2.15');
  assert.equal(typeof attempt.Identifier, 'string');
  assert.equal(attempt.Identifier, hashLoginIdentifier('Student-1'));
  assert.equal(attempt.Stutes, false);
  assert.ok(attempt.Time);
  assert.equal(attempt['User Agent'], 'Test Browser');
  assert.equal(attempt.Identifier.includes('Student-1'), false);
});

test('limits failed attempts by IP or identifier and treats a success as a reset', async () => {
  const now = Date.now();
  const ip = '192.0.2.30';
  const identifier = hashLoginIdentifier('Student-2');
  const windowStart = now - 15 * 60 * 1000;
  const db = makeDb([
    { IP: ip, Identifier: identifier, Stutes: false, Time: new Date(windowStart + 1000) },
    { IP: ip, Identifier: identifier, Stutes: true, Time: new Date(now - 3000) },
    { IP: ip, Identifier: identifier, Stutes: false, Time: new Date(now - 2000) }
  ]);
  const req = { headers: { 'x-forwarded-for': ip } };
  const options = {
    now,
    windowMs: 15 * 60 * 1000,
    maxIpFailures: 5,
    maxIdentifierFailures: 2
  };

  assert.equal((await checkLoginRateLimit(db, req, 'Student-2', options)).allowed, true);
  db.attempts.push(
    { IP: ip, Identifier: identifier, Stutes: false, Time: new Date(now - 1000) }
  );

  const result = await checkLoginRateLimit(db, req, 'Student-2', options);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'identifier');
  assert.ok(result.retryAfter > 0);
});
