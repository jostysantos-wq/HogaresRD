/**
 * P1 #21 — every place a user's role/access is downgraded must bump
 * `tokenVersion` so any JWT they're still holding becomes invalid.
 *
 * Covered routes (all in routes/inmobiliaria.js):
 *   - POST /api/inmobiliaria/secretaries/:id/remove
 *   - POST /api/inmobiliaria/brokers/:brokerId/remove
 *   - POST /api/inmobiliaria/leave
 *   - PUT  /api/inmobiliaria/team/:userId/role  (only on level *down*)
 *
 * Lateral / upgrade changes must NOT bump tokenVersion.
 */

'use strict';

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const { startServer, stopServer, post, put, auth, store } = helpers;

// Helper — register/login a generic user, then promote them in-store
// to whatever role the test needs and re-login to mint a fresh token.
async function makeUser(label, mutate) {
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${label}`;
  const email = `tv-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';
  const reg = await post('/api/auth/register', { name: `User ${label}`, email, password });
  assert.equal(reg.status, 201, reg.text);

  const u = store.getUserByEmail(email);
  if (mutate) mutate(u);
  store.saveUser(u);

  const lg = await post('/api/auth/login', { email, password });
  assert.equal(lg.status, 200, lg.text);
  return { id: u.id, email, token: lg.body.token, password };
}

describe('P1 #21 — tokenVersion bumps on demote/remove', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  it('secretaries/:id/remove bumps tokenVersion on the secretary', async () => {
    // Owner (inmobiliaria role) — auto-becomes Director under teamAuth.
    const owner = await makeUser('owner-sec-rm', (u) => {
      u.role = 'inmobiliaria';
      u.companyName = 'Test Inm';
      u.subscriptionStatus = 'active';
    });
    const secretary = await makeUser('sec-rm', (u) => {
      u.role = 'secretary';
      u.inmobiliaria_id = owner.id;
      u.tokenVersion = 0;
    });

    const r = await post(
      `/api/inmobiliaria/secretaries/${secretary.id}/remove`,
      {},
      auth(owner.token),
    );
    assert.equal(r.status, 200, r.text);

    const fresh = store.getUserById(secretary.id);
    assert.equal(fresh.role, 'deactivated');
    assert.equal(fresh.tokenVersion, 1, 'tokenVersion must bump on secretary remove');
  });

  it('brokers/:brokerId/remove bumps tokenVersion on the broker', async () => {
    const owner = await makeUser('owner-brk-rm', (u) => {
      u.role = 'inmobiliaria';
      u.companyName = 'Test Inm B';
      u.subscriptionStatus = 'active';
    });
    const broker = await makeUser('brk-rm', (u) => {
      u.role = 'broker';
      u.inmobiliaria_id = owner.id;
      u.access_level = 1;
      u.tokenVersion = 0;
      u.subscriptionStatus = 'active';
    });

    const r = await post(
      `/api/inmobiliaria/brokers/${broker.id}/remove`,
      {},
      auth(owner.token),
    );
    assert.equal(r.status, 200, r.text);

    const fresh = store.getUserById(broker.id);
    assert.equal(fresh.inmobiliaria_id, null);
    assert.equal(fresh.tokenVersion, 1, 'tokenVersion must bump on broker remove');
  });

  it('POST /leave bumps tokenVersion on the broker', async () => {
    const owner = await makeUser('owner-leave', (u) => {
      u.role = 'inmobiliaria';
      u.companyName = 'Test Inm L';
      u.subscriptionStatus = 'active';
    });
    const broker = await makeUser('brk-leave', (u) => {
      u.role = 'broker';
      u.inmobiliaria_id = owner.id;
      u.access_level = 1;
      u.tokenVersion = 0;
      u.subscriptionStatus = 'active';
    });

    const r = await post(
      '/api/inmobiliaria/leave',
      {},
      auth(broker.token),
    );
    assert.equal(r.status, 200, r.text);

    const fresh = store.getUserById(broker.id);
    assert.equal(fresh.inmobiliaria_id, null);
    assert.equal(fresh.tokenVersion, 1, 'tokenVersion must bump on broker leave');
  });

  it('PUT /team/:userId/role downgrade (Director → Asistente) bumps tokenVersion', async () => {
    const owner = await makeUser('owner-down', (u) => {
      u.role = 'inmobiliaria';
      u.companyName = 'Test Inm D';
      u.subscriptionStatus = 'active';
    });
    const member = await makeUser('member-down', (u) => {
      u.role = 'broker';
      u.inmobiliaria_id = owner.id;
      u.access_level = 3; // Director
      u.tokenVersion = 0;
      u.subscriptionStatus = 'active';
    });

    const r = await put(
      `/api/inmobiliaria/team/${member.id}/role`,
      { access_level: 1 }, // demote to Asistente
      auth(owner.token),
    );
    assert.equal(r.status, 200, r.text);

    const fresh = store.getUserById(member.id);
    assert.equal(fresh.access_level, 1);
    assert.equal(fresh.tokenVersion, 1, 'tokenVersion must bump on access_level downgrade');
  });

  it('PUT /team/:userId/role upgrade does NOT bump tokenVersion', async () => {
    const owner = await makeUser('owner-up', (u) => {
      u.role = 'inmobiliaria';
      u.companyName = 'Test Inm U';
      u.subscriptionStatus = 'active';
    });
    const member = await makeUser('member-up', (u) => {
      u.role = 'broker';
      u.inmobiliaria_id = owner.id;
      u.access_level = 1; // Asistente
      u.tokenVersion = 0;
      u.subscriptionStatus = 'active';
    });

    const r = await put(
      `/api/inmobiliaria/team/${member.id}/role`,
      { access_level: 3 }, // promote to Director
      auth(owner.token),
    );
    assert.equal(r.status, 200, r.text);

    const fresh = store.getUserById(member.id);
    assert.equal(fresh.access_level, 3);
    assert.equal(fresh.tokenVersion || 0, 0,
      'upgrades must NOT bump tokenVersion (no security benefit)');
  });

  it('PUT /team/:userId/role lateral (same level + title-only edit) does NOT bump tokenVersion', async () => {
    const owner = await makeUser('owner-lat', (u) => {
      u.role = 'inmobiliaria';
      u.companyName = 'Test Inm Lat';
      u.subscriptionStatus = 'active';
    });
    const member = await makeUser('member-lat', (u) => {
      u.role = 'broker';
      u.inmobiliaria_id = owner.id;
      u.access_level = 2;
      u.tokenVersion = 0;
      u.subscriptionStatus = 'active';
    });

    // Same level — title only.
    const r = await put(
      `/api/inmobiliaria/team/${member.id}/role`,
      { access_level: 2, team_title: 'Lead Agent' },
      auth(owner.token),
    );
    assert.equal(r.status, 200, r.text);

    const fresh = store.getUserById(member.id);
    assert.equal(fresh.access_level, 2);
    assert.equal(fresh.team_title, 'Lead Agent');
    assert.equal(fresh.tokenVersion || 0, 0,
      'lateral changes must NOT bump tokenVersion');
  });
});
