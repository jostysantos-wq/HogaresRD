/**
 * HogaresRD API Tests
 *
 * Uses Node.js built-in test runner (node:test) and assertion library (node:assert).
 * Run with:  node --test tests/api.test.js
 *        or: npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ── Test environment ────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_KEY  = 'test-admin-key';
process.env.NODE_ENV   = 'test';

const app = require('../server');

// ── Globals populated during tests ──────────────────────────────────────────
let server;
let BASE;
const TEST_EMAIL    = `testuser_${Date.now()}@hogaresrd-test.com`;
const TEST_PASSWORD = 'TestPass1!';
const TEST_NAME     = 'Test User';
let authToken       = null;

// ── Helper: make HTTP requests using built-in http module ───────────────────

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers },
    };

    if (options.body) {
      const bodyStr = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: raw });
      });
    });

    req.on('error', reject);

    if (options.body) {
      const bodyStr = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
      req.write(bodyStr);
    }

    req.end();
  });
}

function get(path, headers) {
  return request(path, { method: 'GET', headers });
}

function post(path, body, headers) {
  return request(path, { method: 'POST', body, headers });
}

function authGet(path, token) {
  return get(path, { Authorization: `Bearer ${token}` });
}

// ── Start server before tests, close after ──────────────────────────────────

before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      BASE = `http://127.0.0.1:${port}`;
      console.log(`  Test server listening on port ${port}`);
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth — POST /api/auth/register', () => {
  it('should register a new user (201)', async () => {
    const res = await post('/api/auth/register', {
      name:     TEST_NAME,
      email:    TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.user, 'response should include user object');
    assert.equal(res.body.user.email, TEST_EMAIL.toLowerCase());
  });

  it('should return 409 for duplicate email', async () => {
    const res = await post('/api/auth/register', {
      name:     TEST_NAME,
      email:    TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    assert.equal(res.status, 409);
    assert.ok(res.body.error);
  });

  it('should return 400 for missing fields', async () => {
    const res = await post('/api/auth/register', {
      email: 'incomplete@test.com',
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for weak password', async () => {
    const res = await post('/api/auth/register', {
      name:     'Weak Password User',
      email:    `weak_${Date.now()}@test.com`,
      password: 'short',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

describe('Auth — POST /api/auth/login', () => {
  it('should login with correct credentials (200) and return token', async () => {
    const res = await post('/api/auth/login', {
      email:    TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    // Login may return 200 directly or require 2FA; accept both
    assert.ok([200, 202].includes(res.status), `expected 200 or 202, got ${res.status}`);
    if (res.status === 200) {
      assert.ok(res.body.token, 'response should include a token');
      authToken = res.body.token;
    } else {
      // 2FA flow — we still got past credential check
      assert.ok(res.body.requires2FA || res.body.message);
    }
  });

  it('should return 401 for wrong password', async () => {
    const res = await post('/api/auth/login', {
      email:    TEST_EMAIL,
      password: 'WrongPassword1!',
    });
    assert.equal(res.status, 401);
  });

  it('should return 401 for non-existent email', async () => {
    const res = await post('/api/auth/login', {
      email:    'nonexistent_xyz@hogaresrd-test.com',
      password: TEST_PASSWORD,
    });
    assert.equal(res.status, 401);
  });
});

describe('Auth — GET /api/auth/me', () => {
  it('should return 401 without token', async () => {
    const res = await get('/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('should return user info with valid token', async () => {
    if (!authToken) {
      // If login returned 2FA, register a fresh user and login to get a token
      const fbEmail = `fallback_${Date.now()}@test.com`;
      await post('/api/auth/register', {
        name:     'Fallback User',
        email:    fbEmail,
        password: TEST_PASSWORD,
      });
      const loginRes = await post('/api/auth/login', {
        email:    fbEmail,
        password: TEST_PASSWORD,
      });
      authToken = loginRes.body.token || null;
    }
    assert.ok(authToken, 'authToken must be available');
    const res = await authGet('/api/auth/me', authToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.user || res.body.email || res.body.id, 'should return user data');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Listings Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Listings — GET /api/listings', () => {
  it('should return listings array with pagination fields', async () => {
    const res = await get('/api/listings');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.listings), 'listings should be an array');
    assert.ok(typeof res.body.total === 'number', 'total should be a number');
    assert.ok(typeof res.body.page === 'number', 'page should be a number');
    assert.ok(typeof res.body.limit === 'number', 'limit should be a number');
    assert.ok(typeof res.body.pages === 'number', 'pages should be a number');
  });

  it('should accept type filter', async () => {
    const res = await get('/api/listings?type=venta');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.listings));
    // All returned listings should be of type venta (if any)
    for (const l of res.body.listings) {
      assert.equal(l.type, 'venta', `listing ${l.id} should be type venta`);
    }
  });

  it('should accept text search via q parameter', async () => {
    const res = await get('/api/listings?q=santo');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.listings));
  });

  it('should accept pagination parameters', async () => {
    const res = await get('/api/listings?page=1&limit=2');
    assert.equal(res.status, 200);
    assert.ok(res.body.listings.length <= 2, 'should respect limit');
    assert.equal(res.body.limit, 2);
  });
});

describe('Listings — GET /api/listings/:id', () => {
  it('should return a single listing for a valid approved ID', async () => {
    // First fetch listings to find an existing approved ID
    const list = await get('/api/listings?limit=1');
    if (list.body.listings.length === 0) {
      // No approved listings in test DB — skip gracefully
      return;
    }
    const id = list.body.listings[0].id;
    const res = await get(`/api/listings/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
  });

  it('should return 404 for non-existent listing', async () => {
    const res = await get('/api/listings/nonexistent_xyz_999');
    assert.equal(res.status, 404);
  });
});

describe('Listings — GET /api/listings/trending', () => {
  it('should return trending array', async () => {
    const res = await get('/api/listings/trending');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.listings), 'trending should contain listings array');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Applications Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Applications — GET /api/applications', () => {
  it('should return 401 without auth', async () => {
    const res = await get('/api/applications');
    assert.equal(res.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Admin — GET /admin/submissions', () => {
  it('should return 401 without admin key', async () => {
    const res = await get('/admin/submissions');
    assert.equal(res.status, 401);
  });

  it('should return submissions array with valid admin key', async () => {
    const res = await get('/admin/submissions', { 'x-admin-key': 'test-admin-key' });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'response should be an array');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// General / Misc Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('General routes', () => {
  it('GET /home should return 200 and HTML', async () => {
    const res = await get('/home');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'), 'should be HTML');
    assert.ok(res.text.includes('<'), 'should contain HTML markup');
  });

  it('GET / should return 200 and HTML', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
  });

  it('GET /api/push/vapid-key should return public key or 503', async () => {
    const res = await get('/api/push/vapid-key');
    assert.ok([200, 503].includes(res.status), `expected 200 or 503, got ${res.status}`);
    if (res.status === 200) {
      assert.ok(res.body.publicKey, 'should return publicKey');
    }
  });
});

describe('404 handling', () => {
  it('GET /api/nonexistent should return 404', async () => {
    const res = await get('/api/nonexistent-route-xyz');
    // Express returns 404 for unmatched routes — may be HTML or JSON
    assert.equal(res.status, 404);
  });
});
