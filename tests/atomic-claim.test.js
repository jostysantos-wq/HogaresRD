/**
 * E1 — claimApplicationAtomic
 *
 * Confirms the optimistic-concurrency wrapper:
 *   1. Happy path: stale-free claim runs the mutator, persists, and
 *      bumps updated_at.
 *   2. Stale path: when expectedUpdatedAt diverges, throws ConflictError
 *      and leaves the row alone.
 *   3. Wired into a real handler: PUT /:id/documents/:docId/review
 *      returns 409 with the agreed-on Spanish message when the caller
 *      passes an out-of-date `expected_updated_at`.
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
  startServer, stopServer, post, put, auth,
  makeBroker, makeListing, makeApplication, store,
} = helpers;

describe('claimApplicationAtomic', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  it('runs the mutator and persists when updated_at matches', async () => {
    const broker = await makeBroker('claim-happy');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { updated_at: '2026-04-01T10:00:00.000Z' });

    const updated = await store.claimApplicationAtomic(application.id, '2026-04-01T10:00:00.000Z', async (app) => {
      app.status = 'documentos_requeridos';
    });

    assert.equal(updated.status, 'documentos_requeridos');
    assert.notEqual(updated.updated_at, '2026-04-01T10:00:00.000Z'); // bumped
    const reread = store.getApplicationById(application.id);
    assert.equal(reread.status, 'documentos_requeridos');
  });

  it('throws ConflictError when updated_at is stale', async () => {
    const broker = await makeBroker('claim-stale');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { updated_at: '2026-04-01T10:00:00.000Z' });

    let caught;
    try {
      await store.claimApplicationAtomic(application.id, '1999-01-01T00:00:00.000Z', async (app) => {
        app.status = 'rechazado'; // should NOT happen
      });
    } catch (err) { caught = err; }

    assert.ok(caught, 'expected ConflictError');
    assert.equal(caught.name, 'ConflictError');
    const reread = store.getApplicationById(application.id);
    assert.notEqual(reread.status, 'rechazado'); // mutator never ran
  });

  it('exposes ConflictError as a class on the store module', () => {
    assert.equal(typeof store.ConflictError, 'function');
    const e = new store.ConflictError('x');
    assert.equal(e.name, 'ConflictError');
    assert.ok(e instanceof Error);
  });

  it('PUT /:id/documents/:docId/review returns 409 when expected_updated_at is stale', async () => {
    const broker = await makeBroker('claim-409');
    const listing = makeListing(broker);
    const docId = 'doc_test_' + Date.now();
    const application = makeApplication(listing, broker, {
      updated_at: '2026-04-01T10:00:00.000Z',
      documents_uploaded: [{
        id: docId,
        request_id: null,
        type: 'cedula',
        filename: 'fake.pdf',
        original_name: 'fake.pdf',
        review_status: 'pending',
        review_note: '',
        reviewed_at: null,
        reviewed_by: null,
        required: true,
      }],
    });

    const res = await put(
      `/api/applications/${application.id}/documents/${docId}/review`,
      { status: 'approved', note: '', expected_updated_at: '1999-01-01T00:00:00.000Z' },
      auth(broker.token),
    );
    assert.equal(res.status, 409);
    assert.equal(res.body?.error, 'La aplicación fue actualizada por otra persona; recarga.');
    // Doc was not flipped
    const reread = store.getApplicationById(application.id);
    const doc = reread.documents_uploaded.find(d => d.id === docId);
    assert.equal(doc.review_status, 'pending');
  });

  it('PUT /:id/documents/:docId/review accepts current updated_at (happy path)', async () => {
    const broker = await makeBroker('claim-200');
    const listing = makeListing(broker);
    const docId = 'doc_test_' + (Date.now() + 1);
    const application = makeApplication(listing, broker, {
      updated_at: '2026-04-01T10:00:00.000Z',
      documents_uploaded: [{
        id: docId,
        request_id: null,
        type: 'cedula',
        filename: 'fake.pdf',
        original_name: 'fake.pdf',
        review_status: 'pending',
        review_note: '',
        reviewed_at: null,
        reviewed_by: null,
        required: true,
      }],
    });

    const fresh = store.getApplicationById(application.id);
    const res = await put(
      `/api/applications/${application.id}/documents/${docId}/review`,
      { status: 'approved', note: 'todo bien', expected_updated_at: fresh.updated_at },
      auth(broker.token),
    );
    assert.equal(res.status, 200);
    const reread = store.getApplicationById(application.id);
    const doc = reread.documents_uploaded.find(d => d.id === docId);
    assert.equal(doc.review_status, 'approved');
  });
});
