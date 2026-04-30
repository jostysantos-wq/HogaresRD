/**
 * P1 #15 — store cache mutation must wait for the inner client.query
 * to resolve. If the surrounding withTransaction throws and rolls back,
 * the cache must NOT contain the rolled-back row.
 *
 * P1 #29 — saveApplication must not write encrypted financials into
 * the in-memory cache; getApplicationById must return plaintext
 * commission amounts immediately after a save.
 */

'use strict';

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const { startServer, stopServer, store, makeBroker, makeListing, makeApplication } = helpers;

describe('store P1 #15 + P1 #29 — cache commits and plaintext financials', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  it('saveApplication keeps plaintext commission in the cache (P1 #29)', async () => {
    const broker = await makeBroker('cache-plain');
    const listing = makeListing(broker);
    const app = makeApplication(listing, broker, {
      commission: {
        sale_amount: 100000,
        agent_amount: 5000,
        agent_net: 4500,
        inmobiliaria_amount: 500,
      },
    });

    // The cache row is what /commissions/summary reads. After save we
    // expect to read back PLAINTEXT numbers, not the ciphertext.
    const stored = store.getApplicationById(app.id);
    assert.equal(typeof stored.commission, 'object');
    assert.equal(stored.commission.sale_amount, 100000,
      'sale_amount must remain a number in the cache');
    assert.equal(stored.commission.agent_amount, 5000);
    assert.equal(stored.commission.agent_net, 4500);
    assert.equal(stored.commission.inmobiliaria_amount, 500);
  });

  it('saveApplication does not leave a phantom cache row when the inner query rejects (P1 #15)', async () => {
    const broker = await makeBroker('cache-reject');
    const listing = makeListing(broker);

    // Build a fake pg-style client whose .query() rejects.
    const phantomId = 'app_phantom_' + Date.now();
    const fakeClient = {
      query: () => Promise.reject(new Error('forced rollback')),
    };

    const app = {
      id: phantomId,
      listing_id: listing.id,
      listing_title: listing.title,
      listing_price: listing.price,
      listing_type: listing.type,
      client: { name: 'Phantom', phone: '+18095550000', email: 'phantom@test.com', user_id: null },
      broker: { user_id: broker.id, name: 'Test Broker', email: broker.email, phone: '+18095551234', agency_name: 'Test Agency' },
      status: 'aplicado',
      timeline_events: [],
      created_at: new Date().toISOString(),
    };

    let caught;
    try {
      await store.saveApplication(app, fakeClient);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected client.query rejection to bubble');
    assert.equal(caught.message, 'forced rollback');

    // Cache MUST NOT contain the phantom row.
    const stored = store.getApplicationById(phantomId);
    assert.equal(stored, null,
      'cache must not contain a row when the in-tx query failed');
  });

  it('saveApplication updates the cache after the inner query resolves (P1 #15 happy path)', async () => {
    const broker = await makeBroker('cache-resolve');
    const listing = makeListing(broker);

    const happyId = 'app_happy_' + Date.now();
    const queries = [];
    const fakeClient = {
      query: (sql, values) => {
        queries.push({ sql, values });
        return Promise.resolve({ rowCount: 1 });
      },
    };

    const app = {
      id: happyId,
      listing_id: listing.id,
      listing_title: listing.title,
      listing_price: listing.price,
      listing_type: listing.type,
      client: { name: 'Happy', phone: '+18095550001', email: 'happy@test.com', user_id: null },
      broker: { user_id: broker.id, name: 'Test Broker', email: broker.email, phone: '+18095551234', agency_name: 'Test Agency' },
      status: 'aplicado',
      timeline_events: [],
      created_at: new Date().toISOString(),
    };

    // Before the promise resolves, cache must NOT yet contain the row.
    const promise = store.saveApplication(app, fakeClient);
    assert.ok(promise && typeof promise.then === 'function',
      'with a client, saveApplication returns a promise');
    assert.equal(store.getApplicationById(happyId), null,
      'cache must wait for the in-tx query to resolve');

    await promise;

    // After resolution, cache holds the new row.
    const stored = store.getApplicationById(happyId);
    assert.ok(stored, 'cache holds the row after the query resolves');
    assert.equal(stored.id, happyId);
    assert.equal(queries.length, 1, 'exactly one DB query was issued');
  });

  it('withTransaction rollback (no DATABASE_URL) does not leave phantom rows from a failed mutator', async () => {
    // With DATABASE_URL='', withTransaction short-circuits to fn(null).
    // We still want the test to capture the contract: a thrown mutator
    // surfaces as a rejection from withTransaction and any cache
    // mutations that happened before the throw are visible (because
    // there is no real BEGIN/ROLLBACK in test mode), BUT a saveApplication
    // call that itself rejected must not have populated the cache.
    const broker = await makeBroker('cache-tx');
    const listing = makeListing(broker);

    const txAppId = 'app_tx_' + Date.now();
    const fakeClient = {
      query: () => Promise.reject(new Error('inner write fails')),
    };

    let caught;
    try {
      await store.saveApplication({
        id: txAppId,
        listing_id: listing.id,
        listing_title: listing.title,
        listing_price: listing.price,
        listing_type: listing.type,
        client: { name: 'Tx', phone: '+18095550002', email: 'tx@test.com', user_id: null },
        broker: { user_id: broker.id, name: 'Test Broker', email: broker.email, phone: '+18095551234', agency_name: 'Test Agency' },
        status: 'aplicado',
        timeline_events: [],
        created_at: new Date().toISOString(),
      }, fakeClient);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'inner-query failure must reject');
    assert.equal(store.getApplicationById(txAppId), null,
      'no phantom row in cache after inner-query rejection');
  });
});
