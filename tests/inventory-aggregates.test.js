/**
 * GET /api/inventory/by-owner/:userId regression — D5 from Wave 2-C.
 *
 * Audit Group E #17 noted no test asserted the aggregate math. Adding
 * coverage for: counts (totalUnits/available/reserved/sold), byListing
 * shape, byBroker math from completed applications, owner-only auth gate.
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  request, get, auth, makeBroker, makeListing,
  startServer, stopServer,
} = require('./_app-helpers');
const store = require('../routes/store');

let constructora, listing;

describe('GET /api/inventory/by-owner/:userId', () => {
  before(async () => {
    await startServer();
    constructora = await makeBroker('inv-owner');
    // Promote to constructora so creator_user_id matches the inventory owner gate
    const u = store.getUserById(constructora.id);
    u.role = 'constructora';
    store.saveUser(u);

    listing = makeListing(constructora);
    listing.creator_user_id = constructora.id;
    listing.unit_inventory = [
      { id: 'u1', label: 'Unit 1', status: 'available' },
      { id: 'u2', label: 'Unit 2', status: 'available' },
      { id: 'u3', label: 'Unit 3', status: 'reserved' },
      { id: 'u4', label: 'Unit 4', status: 'sold' },
      { id: 'u5', label: 'Unit 5', status: 'sold' },
    ];
    store.saveListing(listing);

    // Seed 2 completed applications referencing units on this listing
    const broker = await makeBroker('inv-broker-A');
    const app1 = {
      id: `app_inv_1_${Date.now()}`,
      listing_id: listing.id,
      client: { name: 'Buyer 1', phone: '8090000001', email: 'b1@x.com' },
      broker: { user_id: broker.id, name: 'Broker A' },
      status: 'completado',
      assigned_unit: { unitId: 'u4' },
      timeline_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const app2 = { ...app1, id: `app_inv_2_${Date.now()}`, assigned_unit: { unitId: 'u5' } };
    store.saveApplication(app1);
    store.saveApplication(app2);
  });

  after(async () => { await stopServer(); });

  it('owner gets correct aggregates', async () => {
    const res = await get(`/api/inventory/by-owner/${constructora.id}`, auth(constructora.token));
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);
    const body = res.body;
    assert.equal(body.totalListings, 1);
    assert.equal(body.totalUnits, 5);
    assert.equal(body.available, 2);
    assert.equal(body.reserved, 1);
    assert.equal(body.sold, 2);
    assert.ok(Array.isArray(body.byListing) && body.byListing.length === 1);
    assert.equal(body.byListing[0].listing_id, listing.id);
    assert.equal(body.byListing[0].sold, 2);
    assert.ok(Array.isArray(body.byBroker));
    assert.ok(body.byBroker.length >= 1);
    const brokerRow = body.byBroker[0];
    assert.equal(brokerRow.applications_completed, 2);
    assert.equal(brokerRow.units_sold, 2);
    assert.ok(Array.isArray(body.byMonth));
    assert.ok(body.byMonth.length === 12, `expected 12 months, got ${body.byMonth.length}`);
  });

  it('non-owner gets 403', async () => {
    const other = await makeBroker('inv-other');
    const res = await get(`/api/inventory/by-owner/${constructora.id}`, auth(other.token));
    assert.equal(res.status, 403);
  });

  it('unauthenticated gets 401', async () => {
    const res = await get(`/api/inventory/by-owner/${constructora.id}`);
    assert.equal(res.status, 401);
  });
});
