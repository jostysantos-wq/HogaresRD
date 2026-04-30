/**
 * P0 #1 — inventory.js mutation handlers must `await store.withTransaction`.
 *
 * Without the await, in production (DATABASE_URL set) `withTransaction`
 * returns a Promise so the route responds before the work is done — and
 * any thrown error becomes an unhandled rejection. We assert two things
 * for every mutation endpoint:
 *
 *   1. Happy path — the response body contains the actual `{ ok: true, ... }`
 *      payload (not `{}` from a still-pending promise).
 *   2. Failure path — when something inside the transaction throws (we
 *      monkey-patch saveListing temporarily), the route returns 500 with
 *      a JSON error body, NOT 200 with `{}`.
 *
 * Run:  node --test tests/inventory-await.test.js
 */

'use strict';

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const {
  startServer, stopServer, post, del, auth,
  makeBroker, makeListing, makeApplication, store,
} = helpers;

// Promote a freshly minted "broker" fixture to constructora so the
// inventory `isOwner(user, listing)` check (which requires
// `user.role === 'constructora'`) passes. JWT carries the role, so we
// must promote BEFORE login. We re-implement makeBroker locally with
// role='constructora'.
async function makeConstructora(label) {
  const tag      = `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${label}`;
  const email    = `dev-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';

  const reg = await helpers.post('/api/auth/register', {
    name: `Dev ${label}`, email, password,
  });
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${reg.text}`);

  const u = store.getUserByEmail(email);
  u.role               = 'constructora';
  u.subscriptionStatus = 'active';
  store.saveUser(u);

  const lg = await helpers.post('/api/auth/login', { email, password });
  assert.equal(lg.status, 200, `login failed: ${lg.status} ${lg.text}`);
  return { id: u.id, email, token: lg.body.token };
}

describe('inventory.js — withTransaction await', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  // ── POST /:listingId/units (add unit) ─────────────────────────────
  describe('POST /:listingId/units', () => {
    it('happy path: returns ok + unit + summary (not {})', async () => {
      const dev = await makeConstructora('add-happy');
      const listing = makeListing(dev);

      const res = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'Apt 101', type: '2BR', floor: '1' },
        auth(dev.token)
      );

      assert.equal(res.status, 201);
      assert.ok(res.body, 'expected JSON body');
      assert.equal(res.body.ok, true, 'expected ok:true (await landed)');
      assert.ok(res.body.unit, 'expected unit in body');
      assert.equal(res.body.unit.label, 'Apt 101');
      assert.equal(res.body.summary.total, 1);
    });

    it('failure path: 500 + JSON error when saveListing throws', async () => {
      const dev = await makeConstructora('add-fail');
      const listing = makeListing(dev);

      const orig = store.saveListing;
      store.saveListing = function () { throw new Error('boom-save'); };
      try {
        const res = await post(
          `/api/inventory/${listing.id}/units`,
          { label: 'Apt 102' },
          auth(dev.token)
        );
        assert.equal(res.status, 500, `expected 500, got ${res.status}`);
        assert.ok(res.body, 'expected JSON body, not empty {}');
        assert.ok(res.body.error, 'expected error field in body');
      } finally {
        store.saveListing = orig;
      }
    });
  });

  // ── POST /:listingId/units/batch ──────────────────────────────────
  describe('POST /:listingId/units/batch', () => {
    it('happy path: returns ok + added array', async () => {
      const dev = await makeConstructora('batch-happy');
      const listing = makeListing(dev);

      const res = await post(
        `/api/inventory/${listing.id}/units/batch`,
        { units: [{ label: 'A1' }, { label: 'A2' }] },
        auth(dev.token)
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.added.length, 2);
      assert.equal(res.body.summary.total, 2);
    });

    it('failure path: 500 + JSON error when saveListing throws', async () => {
      const dev = await makeConstructora('batch-fail');
      const listing = makeListing(dev);

      const orig = store.saveListing;
      store.saveListing = function () { throw new Error('boom-save'); };
      try {
        const res = await post(
          `/api/inventory/${listing.id}/units/batch`,
          { units: [{ label: 'B1' }] },
          auth(dev.token)
        );
        assert.equal(res.status, 500);
        assert.ok(res.body && res.body.error);
      } finally {
        store.saveListing = orig;
      }
    });
  });

  // ── DELETE /:listingId/units/:unitId ─────────────────────────────
  describe('DELETE /:listingId/units/:unitId', () => {
    it('happy path: returns ok + summary', async () => {
      const dev = await makeConstructora('del-happy');
      const listing = makeListing(dev);
      const add = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'D1' }, auth(dev.token)
      );
      const unitId = add.body.unit.id;

      const res = await del(
        `/api/inventory/${listing.id}/units/${unitId}`,
        auth(dev.token)
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.success, true);
    });

    it('failure path: 500 + JSON error when saveListing throws', async () => {
      const dev = await makeConstructora('del-fail');
      const listing = makeListing(dev);
      const add = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'D2' }, auth(dev.token)
      );
      const unitId = add.body.unit.id;

      const orig = store.saveListing;
      store.saveListing = function () { throw new Error('boom-save'); };
      try {
        const res = await del(
          `/api/inventory/${listing.id}/units/${unitId}`,
          auth(dev.token)
        );
        assert.equal(res.status, 500);
        assert.ok(res.body && res.body.error);
      } finally {
        store.saveListing = orig;
      }
    });
  });

  // ── POST /:listingId/units/:unitId/assign ─────────────────────────
  describe('POST /:listingId/units/:unitId/assign', () => {
    it('happy path: returns ok + reserved unit', async () => {
      const dev = await makeConstructora('assign-happy');
      const listing = makeListing(dev);
      const add = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'X1' }, auth(dev.token)
      );
      const unitId = add.body.unit.id;
      const application = makeApplication(listing, dev);

      const res = await post(
        `/api/inventory/${listing.id}/units/${unitId}/assign`,
        { applicationId: application.id },
        auth(dev.token)
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.unit.status, 'reserved');
      assert.equal(res.body.unit.applicationId, application.id);
    });

    it('failure path: 500 + JSON error when saveListing throws', async () => {
      const dev = await makeConstructora('assign-fail');
      const listing = makeListing(dev);
      const add = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'X2' }, auth(dev.token)
      );
      const unitId = add.body.unit.id;
      const application = makeApplication(listing, dev);

      const orig = store.saveListing;
      store.saveListing = function () { throw new Error('boom-save'); };
      try {
        const res = await post(
          `/api/inventory/${listing.id}/units/${unitId}/assign`,
          { applicationId: application.id },
          auth(dev.token)
        );
        assert.equal(res.status, 500);
        assert.ok(res.body && res.body.error);
      } finally {
        store.saveListing = orig;
      }
    });
  });

  // ── POST /:listingId/units/:unitId/release ────────────────────────
  describe('POST /:listingId/units/:unitId/release', () => {
    it('happy path: returns ok + available unit', async () => {
      const dev = await makeConstructora('rel-happy');
      const listing = makeListing(dev);
      const add = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'R1' }, auth(dev.token)
      );
      const unitId = add.body.unit.id;
      const application = makeApplication(listing, dev);
      await post(
        `/api/inventory/${listing.id}/units/${unitId}/assign`,
        { applicationId: application.id },
        auth(dev.token)
      );

      const res = await post(
        `/api/inventory/${listing.id}/units/${unitId}/release`,
        {}, auth(dev.token)
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.unit.status, 'available');
      assert.equal(res.body.unit.applicationId, null);
    });

    it('failure path: 500 + JSON error when saveListing throws', async () => {
      const dev = await makeConstructora('rel-fail');
      const listing = makeListing(dev);
      const add = await post(
        `/api/inventory/${listing.id}/units`,
        { label: 'R2' }, auth(dev.token)
      );
      const unitId = add.body.unit.id;

      const orig = store.saveListing;
      store.saveListing = function () { throw new Error('boom-save'); };
      try {
        const res = await post(
          `/api/inventory/${listing.id}/units/${unitId}/release`,
          {}, auth(dev.token)
        );
        assert.equal(res.status, 500);
        assert.ok(res.body && res.body.error);
      } finally {
        store.saveListing = orig;
      }
    });
  });
});
