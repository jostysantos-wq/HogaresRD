/**
 * Status-write hardening (Agent 5-A audit fixes)
 *
 * Covers:
 *   - Subscription gate fires on PUT /:id/payment/verify,
 *     PUT /:id/documents/:docId/review, and
 *     PUT /:id/payment-plan/:iid/review for an inactive broker → 402.
 *   - D2 secretary escalation on POST /:id/skip-phase to `aprobado` → 403
 *     `requires_escalation`.
 *   - claimApplicationAtomic 409 on stale `updated_at` for PUT /:id/status.
 *   - Bulk reject voids approved commission, releases unit_inventory back
 *     to `available`, and emails the client.
 *   - PUT /:id/status reject-reason length parity: < 5 chars → 400; ≥ 5 → 200.
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

const appsRouter = require('../routes/applications');
const { _setTransporter } = appsRouter.__test;

// Email capture for bulk-reject side-effect verification. Top-level so
// every describe shares one transporter — matches the pattern in
// applications-workflow.test.js.
const sentMail = [];

before(async () => {
  helpers.installInMemoryStoreShims();
  _setTransporter({
    sendMail: async (opts) => {
      sentMail.push(opts);
      return { messageId: 'noop' };
    },
  });
  await startServer();
});
after(stopServer);

describe('subscription gates on review endpoints (P1 #11)', () => {
  it('PUT /:id/payment/verify returns 402 when broker subscription is canceled', async () => {
    const broker = await makeBroker('sub-pay-verify');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      status: 'pago_enviado',
      payment: {
        amount: 1000, currency: 'DOP', receipt_path: '/tmp/x.png',
        receipt_filename: 'x.png', receipt_original: 'x.png',
        receipt_uploaded_at: new Date().toISOString(),
        verification_status: 'pending', verified_at: null,
        verified_by: null, notes: '',
      },
    });

    const u = store.getUserById(broker.id);
    u.subscriptionStatus = 'canceled';
    store.saveUser(u);

    const res = await put(
      `/api/applications/${application.id}/payment/verify`,
      { approved: true, notes: '' },
      auth(broker.token),
    );
    assert.equal(res.status, 402);
    assert.equal(res.body?.needsSubscription, true);
  });

  it('PUT /:id/documents/:docId/review returns 402 when broker subscription is canceled', async () => {
    const broker = await makeBroker('sub-doc-review');
    const listing = makeListing(broker);
    const docId = 'doc_sub_' + Date.now();
    const application = makeApplication(listing, broker, {
      documents_uploaded: [{
        id: docId, request_id: null, type: 'cedula',
        filename: 'fake.pdf', original_name: 'fake.pdf',
        review_status: 'pending', review_note: '',
        reviewed_at: null, reviewed_by: null, required: true,
      }],
    });

    const u = store.getUserById(broker.id);
    u.subscriptionStatus = 'canceled';
    store.saveUser(u);

    const res = await put(
      `/api/applications/${application.id}/documents/${docId}/review`,
      { status: 'approved', note: '' },
      auth(broker.token),
    );
    assert.equal(res.status, 402);
    assert.equal(res.body?.needsSubscription, true);
  });

  it('PUT /:id/payment-plan/:iid/review returns 402 when inmobiliaria subscription is canceled', async () => {
    // Build broker for fixture wiring + inmobiliaria-role user that owns
    // the application + payment plan.
    const broker = await makeBroker('sub-plan-broker');
    const listing = makeListing(broker);

    const inm = await makeBroker('sub-plan-inm');
    const inmUser = store.getUserById(inm.id);
    inmUser.role = 'inmobiliaria';
    inmUser.subscriptionStatus = 'canceled';
    store.saveUser(inmUser);

    const installmentId = 'inst_' + Date.now();
    const application = makeApplication(listing, broker, {
      inmobiliaria_id: inm.id,
      payment_plan: {
        currency: 'DOP', total_amount: 5000,
        payment_method: 'transferencia', method_details: '',
        notes: '',
        installments: [{
          id: installmentId, number: 1, label: 'Inicial',
          amount: 5000, due_date: null,
          status: 'proof_uploaded',
          proof_path: '/tmp/proof.png', proof_original: 'proof.png',
        }],
      },
    });

    const res = await put(
      `/api/applications/${application.id}/payment-plan/${installmentId}/review`,
      { approved: true, review_notes: '' },
      auth(inm.token),
    );
    assert.equal(res.status, 402);
    assert.equal(res.body?.needsSubscription, true);
  });
});

describe('D2 escalation on skip-phase (P0 #7)', () => {
  it('secretary attempting skip-phase to aprobado → 403 requires_escalation', async () => {
    const broker = await makeBroker('skip-d2-broker');
    const listing = makeListing(broker);

    // Inmobiliaria owner with active subscription so the secretary's
    // upstream subscription check passes (and we exercise the D2 gate).
    const inm = await makeBroker('skip-d2-inm');
    const inmUser = store.getUserById(inm.id);
    inmUser.role = 'inmobiliaria';
    inmUser.subscriptionStatus = 'active';
    store.saveUser(inmUser);

    const sec = await makeBroker('skip-d2-sec');
    const secUser = store.getUserById(sec.id);
    secUser.role = 'secretary';
    secUser.inmobiliaria_id = inm.id;
    secUser.subscriptionStatus = 'active';
    store.saveUser(secUser);

    const application = makeApplication(listing, broker, {
      inmobiliaria_id: inm.id,
      status: 'en_aprobacion',
    });

    const res = await post(
      `/api/applications/${application.id}/skip-phase`,
      { status: 'aprobado', reason: 'urgente firma hoy' },
      auth(sec.token),
    );
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.code, 'requires_escalation');
  });
});

describe('claimApplicationAtomic on PUT /:id/status (P1 #13)', () => {
  it('returns 409 when claimApplicationAtomic detects a stale updated_at', async () => {
    const broker = await makeBroker('claim-status');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      updated_at: '2026-04-01T10:00:00.000Z',
      status: 'aplicado',
    });

    // Stub claimApplicationAtomic for ONE call to throw ConflictError —
    // simulates a concurrent writer landing between the route's read of
    // `app.updated_at` and the SELECT … FOR UPDATE inside the claim.
    // We assert the handler maps that to 409 with the agreed Spanish
    // copy, the same shape used by document review.
    const orig = store.claimApplicationAtomic;
    store.claimApplicationAtomic = async () => {
      throw new store.ConflictError('updated_at mismatch');
    };
    let res;
    try {
      res = await put(`/api/applications/${application.id}/status`,
        { status: 'en_revision' }, auth(broker.token));
    } finally {
      store.claimApplicationAtomic = orig;
    }
    assert.equal(res.status, 409, `expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, 'La aplicación fue actualizada por otra persona; recarga.');

    // Application untouched — handler bailed out before any side-effect.
    const reread = store.getApplicationById(application.id);
    assert.equal(reread.status, 'aplicado');
  });
});

describe('bulk reject side-effects (P0 #6)', () => {
  it('voids approved commission, releases unit, emails client', async () => {
    const broker = await makeBroker('bulk-reject');
    const listing = makeListing(broker);
    const unitId = 'unit-bulk-1';
    listing.unit_inventory = [{
      id: unitId, label: 'A1', status: 'reserved',
      applicationId: null, clientName: null,
    }];
    listing.units_available = 0;
    store.saveListing(listing);

    const application = makeApplication(listing, broker, {
      assigned_unit: { unitId, unitLabel: 'A1', unitType: null },
      commission: {
        status: 'approved',
        sale_amount: 100000,
        agent_amount: 3000,
        inmobiliaria_amount: 2000,
        agent_net: 3000,
        payout_id: 'po_test_123',
        payout_ref: 'ref_abc',
      },
    });
    listing.unit_inventory[0].applicationId = application.id;
    store.saveListing(listing);

    sentMail.length = 0;

    const res = await post('/api/applications/bulk',
      {
        ids: [application.id],
        action: 'reject',
        reason: 'cliente desistio del proceso',
      },
      auth(broker.token),
    );
    assert.equal(res.status, 200, `bulk reject failed: ${res.status} ${JSON.stringify(res.body)}`);
    const item = res.body.results.find(r => r.id === application.id);
    assert.ok(item?.ok, `expected ok=true for app, got ${JSON.stringify(item)}`);

    const stored = store.getApplicationById(application.id);
    assert.equal(stored.status, 'rechazado');
    assert.equal(stored.commission.status, 'voided', 'commission should be voided');
    assert.ok(stored.commission.voided_at, 'commission.voided_at should be set');
    assert.equal(stored.commission.payout_id, null, 'payout_id should be cleared');
    assert.equal(stored.commission.payout_ref, null, 'payout_ref should be cleared');

    const reReadListing = store.getListingById(listing.id);
    const unit = reReadListing.unit_inventory.find(u => u.id === unitId);
    assert.equal(unit.status, 'available', 'unit should be released back to available');
    assert.equal(unit.applicationId, null);
    assert.equal(reReadListing.units_available, 1);

    // Email transporter was invoked with the client email
    const clientMail = sentMail.find(m => m.to === application.client.email);
    assert.ok(clientMail, 'client email should have been sent for bulk reject');
  });
});

describe('PUT /:id/status reject-reason length parity (audit Bug-9)', () => {
  it('rejects with reason="no" → 400 (length < 5)', async () => {
    const broker = await makeBroker('reason-short');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { status: 'aplicado' });

    const res = await put(`/api/applications/${application.id}/status`,
      { status: 'rechazado', reason: 'no' },
      auth(broker.token));
    assert.equal(res.status, 400);
    assert.match(res.body?.error || '', /5 caracteres/i);
  });

  it('accepts with reason="cliente desistio" → 200', async () => {
    const broker = await makeBroker('reason-ok');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { status: 'aplicado' });

    const res = await put(`/api/applications/${application.id}/status`,
      { status: 'rechazado', reason: 'cliente desistio' },
      auth(broker.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.status, 'rechazado');
  });
});
