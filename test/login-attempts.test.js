const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FIRST_BLOCK_MS,
  FINAL_BLOCK_MS,
  checkLoginRateLimit,
  hashLoginIdentifier,
  recordLoginAttempt
} = require('../lib/login-attempts');

process.env.LOGIN_IDENTIFIER_HMAC_KEY = 'test-only-login-hash-key';

function makeDb() {
  const collections = new Map();
  let nextId = 0;

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function makeRef(collectionName, id = `generated-${++nextId}`) {
    return {
      id,
      get store() {
        return getCollection(collectionName);
      }
    };
  }

  return {
    collections,
    collection(name) {
      return {
        doc(id) {
          return makeRef(name, id);
        }
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = ref.store.get(ref.id);
          return {
            exists: value !== undefined,
            data: () => value
          };
        },
        set(ref, value) {
          writes.push(() => ref.store.set(ref.id, value));
        },
        delete(ref) {
          writes.push(() => ref.store.delete(ref.id));
        }
      };
      const result = await callback(transaction);
      writes.forEach(write => write());
      return result;
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

  const attempts = [...db.collections.get('LOGIN').values()];
  assert.equal(attempts.length, 1);
  const [attempt] = attempts;
  assert.equal(attempt.IP, '192.0.2.15');
  assert.equal(typeof attempt.Identifier, 'string');
  assert.equal(attempt.Identifier, hashLoginIdentifier('Student-1'));
  assert.equal(attempt.Stutes, false);
  assert.ok(attempt.Time);
  assert.equal(attempt['User Agent'], 'Test Browser');
  assert.equal(attempt.Identifier.includes('Student-1'), false);
});

test('blocks after three failures for five minutes, then after three more for 24 hours', async () => {
  const db = makeDb();
  const ip = '192.0.2.30';
  const req = { headers: { 'x-real-ip': ip } };
  let now = Date.now();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await checkLoginRateLimit(db, req, 'Student-2', { now })).allowed, true);
    await recordLoginAttempt(db, req, 'Student-2', false, null, true, { now });
  }

  let result = await checkLoginRateLimit(db, req, 'Student-2', { now });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'ip_5_minute_block');
  assert.ok(result.retryAfter <= FIRST_BLOCK_MS / 1000);
  assert.ok(result.retryAfter > 0);

  now += FIRST_BLOCK_MS + 1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await checkLoginRateLimit(db, req, 'Student-2', { now })).allowed, true);
    await recordLoginAttempt(db, req, 'Student-2', false, null, true, { now });
  }

  result = await checkLoginRateLimit(db, req, 'Student-2', { now });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'ip_24_hour_block');
  assert.ok(result.retryAfter <= FINAL_BLOCK_MS / 1000);
  assert.ok(result.retryAfter > 0);
  const [blacklistEntry] = [...db.collections.get('Blacklist').values()];
  assert.equal(blacklistEntry.IP, ip);
  assert.equal(blacklistEntry.reason, 'six_failed_login_attempts');
  assert.equal(new Date(blacklistEntry.expiresAt).getTime(), now + FINAL_BLOCK_MS);

  now += FINAL_BLOCK_MS + 1;
  assert.equal((await checkLoginRateLimit(db, req, 'Student-2', { now })).allowed, true);
  assert.equal(db.collections.get('Blacklist').size, 0);
});

test('a successful login clears the IP failure state', async () => {
  const db = makeDb();
  const req = { headers: { 'x-real-ip': '192.0.2.45' } };
  const now = Date.now();

  await recordLoginAttempt(db, req, 'Student-3', false, null, true, { now });
  await recordLoginAttempt(db, req, 'Student-3', false, null, true, { now });
  await recordLoginAttempt(db, req, 'Student-3', true, null, false, { now });

  assert.equal((await checkLoginRateLimit(db, req, 'Student-3', { now })).allowed, true);
  assert.equal(db.collections.get('LOGIN').size, 3);
  assert.equal(db.collections.get('LOGIN_IP_LIMITS').size, 0);
});
