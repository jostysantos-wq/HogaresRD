/**
 * E6: changing a user's role bumps tokenVersion, which must immediately
 * invalidate any token signed before the bump.
 *
 * Flow exercised:
 *   1. register + login → token A (role='user', tokenVersion=0)
 *   2. token A passes /api/auth/me
 *   3. admin PUTs /admin/users/:id/role → tokenVersion bumped to 1
 *   4. token A is now rejected (401 from /api/auth/me)
 *   5. fresh login → token B (tokenVersion=1) succeeds
 *
 * Run:  node --test tests/jwt-role-refresh.test.js
 */

process.env.JWT_SECRET             = 'test-secret';
process.env.ADMIN_KEY              = 'test-admin-key';
process.env.ADMIN_SESSION_SECRET   = 'test-admin-session-secret-32-chars-long';
process.env.NODE_ENV               = 'test';
process.env.DATABASE_URL           = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  request, get, post, put, auth,
  startServer, stopServer,
  store,
} = require('./_app-helpers');

let user, tokenA;

// Mint an admin session cookie directly. `adminSessionAuth` verifies a
// JWT signed with ADMIN_SESSION_SECRET and stored under the
// `admin_sess` cookie name. We bypass the OTP/login flow because
// that's a separate audit area and not what this test exercises.
const jwt = require('jsonwebtoken');
const adminCookieToken = jwt.sign(
  { admin: true },
  process.env.ADMIN_SESSION_SECRET,
  { expiresIn: '1h' }
);
const ADMIN_COOKIE = `admin_sess=${adminCookieToken}`;

before(async () => {
  await startServer();
  // Register + login a fresh user via the public auth endpoints so
  // the token is properly signed by the running server (matches the
  // exact JWT_SECRET / signToken implementation).
  const tag = 'role-refresh-' + Date.now();
  const email = `role-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';
  const reg = await post('/api/auth/register', { name: 'Role User', email, password });
  assert.equal(reg.status, 201, reg.text);
  const lg = await post('/api/auth/login', { email, password });
  assert.equal(lg.status, 200, lg.text);
  tokenA = lg.body.token;
  user = store.getUserByEmail(email);
});
after(stopServer);

describe('E6 JWT tokenVersion role refresh', () => {
  it('initial token authenticates /api/auth/me', async () => {
    const r = await get('/api/auth/me', auth(tokenA));
    assert.equal(r.status, 200, r.text);
  });

  it('admin role change bumps tokenVersion', async () => {
    const before = Number.isFinite(user.tokenVersion) ? user.tokenVersion : 0;
    const r = await put(
      `/admin/users/${user.id}/role`,
      { role: 'broker' },
      { Cookie: ADMIN_COOKIE },
    );
    assert.equal(r.status, 200, r.text);
    const fresh = store.getUserById(user.id);
    assert.equal(fresh.role, 'broker');
    assert.equal(fresh.tokenVersion, before + 1);
  });

  it('the old token is now rejected with 401', async () => {
    const r = await get('/api/auth/me', auth(tokenA));
    assert.equal(r.status, 401, 'old token must NOT authenticate after a role bump');
  });

  it('a freshly minted token works again', async () => {
    // Login again — server now embeds tokenVersion=1 in the new JWT.
    const lg = await post('/api/auth/login', {
      email: user.email,
      password: 'TestPass1!',
    });
    assert.equal(lg.status, 200, lg.text);
    const tokenB = lg.body.token;
    const r = await get('/api/auth/me', auth(tokenB));
    assert.equal(r.status, 200, r.text);
  });
});
