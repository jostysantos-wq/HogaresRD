/**
 * Subscription cascade — broker inherits from inmobiliaria.
 *
 * Brokers and constructora users affiliated to a paid agency must keep
 * working even if their personal `subscriptionStatus` row drifts to
 * 'none' (Stripe-managed agencies pay one subscription that covers the
 * whole team).
 *
 * Run:  node --test tests/subscription-cascade.test.js
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
// Force the in-process short-circuit in withTransaction; otherwise the
// store would hang trying to connect to a real Postgres pool.
process.env.DATABASE_URL = '';

const store = require('../routes/store');
const { requireActiveSubscription, isSubscriptionActive } = require('../utils/subscription-gate');

function makeRes() {
  const res = {
    statusCode: 200,
    body:       null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
  return res;
}

function runMiddleware(req) {
  return new Promise((resolve) => {
    const res = makeRes();
    requireActiveSubscription(req, res, () => resolve({ status: 200, body: null, passed: true }));
    // Sync handler — if status was set, return that synchronously
    setImmediate(() => {
      if (res.body !== null || res.statusCode !== 200) {
        resolve({ status: res.statusCode, body: res.body, passed: false });
      }
    });
  });
}

function makeUser(overrides) {
  return {
    id:                  overrides.id || 'u_' + Math.random().toString(36).slice(2),
    role:                'broker',
    name:                'Broker Test',
    email:               'broker@example.com',
    subscriptionStatus:  'none',
    paywallRequired:     true,
    inmobiliaria_id:     null,
    ...overrides,
  };
}

describe('isSubscriptionActive', () => {
  it('returns true for active', () => {
    assert.equal(isSubscriptionActive({ subscriptionStatus: 'active' }), true);
  });
  it('returns true for trialing', () => {
    assert.equal(isSubscriptionActive({ subscriptionStatus: 'trialing' }), true);
  });
  it('returns true for past_due (Stripe grace)', () => {
    assert.equal(isSubscriptionActive({ subscriptionStatus: 'past_due' }), true);
  });
  it('returns false for none / canceled', () => {
    assert.equal(isSubscriptionActive({ subscriptionStatus: 'none' }), false);
    assert.equal(isSubscriptionActive({ subscriptionStatus: 'canceled' }), false);
  });
});

describe('requireActiveSubscription — broker → inmobiliaria cascade', () => {
  let broker, inm;

  beforeEach(() => {
    inm = makeUser({
      id:                 'inm_test_' + Math.random().toString(36).slice(2),
      role:               'inmobiliaria',
      name:               'Inm Parent',
      email:              'parent@example.com',
      subscriptionStatus: 'active',
    });
    broker = makeUser({
      id:                 'brk_test_' + Math.random().toString(36).slice(2),
      role:               'broker',
      subscriptionStatus: 'none',
      inmobiliaria_id:    inm.id,
    });
    store.saveUser(inm);
    store.saveUser(broker);
  });

  it('GET requests always pass through (read-only)', async () => {
    const req = { method: 'GET', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true);
  });

  it('active broker, inactive agency → broker still works (broker pays own way)', async () => {
    inm.subscriptionStatus = 'canceled';
    broker.subscriptionStatus = 'active';
    store.saveUser(inm);
    store.saveUser(broker);
    const req = { method: 'POST', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true, `expected pass, got ${result.status} ${JSON.stringify(result.body)}`);
  });

  it('inactive broker, active agency → ALLOWED (the cascade fix)', async () => {
    broker.subscriptionStatus = 'none';
    inm.subscriptionStatus    = 'active';
    store.saveUser(broker);
    store.saveUser(inm);
    const req = { method: 'POST', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true,
      `expected pass via inmobiliaria, got ${result.status} ${JSON.stringify(result.body)}`);
  });

  it('inactive both → 402', async () => {
    broker.subscriptionStatus = 'canceled';
    inm.subscriptionStatus    = 'canceled';
    store.saveUser(broker);
    store.saveUser(inm);
    const req = { method: 'POST', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, false);
    assert.equal(result.status, 402);
    assert.ok(result.body && result.body.needsSubscription === true);
  });

  it('broker with no inmobiliaria_id and inactive sub → 402', async () => {
    broker.subscriptionStatus = 'none';
    broker.inmobiliaria_id    = null;
    store.saveUser(broker);
    const req = { method: 'POST', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, false);
    assert.equal(result.status, 402);
  });

  it('agency role under inmobiliaria — same cascade rule applies', async () => {
    broker.role = 'agency';
    broker.subscriptionStatus = 'none';
    inm.subscriptionStatus    = 'trialing';
    store.saveUser(broker);
    store.saveUser(inm);
    const req = { method: 'POST', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true);
  });

  it('secretary still inherits (existing behavior preserved)', async () => {
    broker.role = 'secretary';
    broker.subscriptionStatus = 'none';
    inm.subscriptionStatus    = 'active';
    store.saveUser(broker);
    store.saveUser(inm);
    const req = { method: 'POST', user: { sub: broker.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true);
  });

  it('regular user (role: user) is never gated', async () => {
    const u = makeUser({ id: 'u_buyer_' + Math.random().toString(36).slice(2),
      role: 'user', subscriptionStatus: 'none', inmobiliaria_id: null });
    store.saveUser(u);
    const req = { method: 'POST', user: { sub: u.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true);
  });

  it('admin is never gated', async () => {
    const a = makeUser({ id: 'a_admin_' + Math.random().toString(36).slice(2),
      role: 'admin', subscriptionStatus: 'none', inmobiliaria_id: null });
    store.saveUser(a);
    const req = { method: 'POST', user: { sub: a.id }, cookies: {}, headers: {} };
    const result = await runMiddleware(req);
    assert.equal(result.passed, true);
  });
});
