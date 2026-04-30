/**
 * Buyer journey audit (Group 2 — items B1, B3)
 *
 * Drives the buyer-side endpoints added in this audit:
 *   - POST /api/applications/:id/withdraw  (B1)
 *   - GET  /api/applications/track-token   (B3)
 *
 * Setup uses the shared _app-helpers fixtures so we don't rely on
 * direct test-only DB seeding semantics — fixtures land in the same
 * in-memory store the real handlers read.
 *
 * Run:  node --test tests/buyer-journey.test.js
 *  or:  npm test
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt    = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

const helpers = require('./_app-helpers');
const {
  request, get, post, auth,
  startServer, stopServer,
  makeBroker, makeTenant, makeListing, makeApplication,
  store,
} = helpers;

const appsRouter = require('../routes/applications');
const { _setTransporter } = appsRouter.__test;

// ── Stub transporter so we can assert outbound email content ─────────
const sentEmails = [];
function installStubTransporter() {
  _setTransporter({
    sendMail: async (msg) => {
      sentEmails.push(msg);
      return { ok: true };
    },
  });
}

before(async () => {
  await startServer();
  installStubTransporter();
});

after(stopServer);

// ════════════════════════════════════════════════════════════════════
// B1 — Buyer can withdraw an application
// ════════════════════════════════════════════════════════════════════
describe('B1 — POST /:id/withdraw', () => {
  it('owner (logged-in client) can withdraw → status flips to rechazado', async () => {
    const broker  = await makeBroker('b1-owner');
    const listing = makeListing(broker);
    const tenant  = await makeTenant('b1-owner');
    const application = makeApplication(listing, broker, {
      client: {
        name:    tenant.name,
        phone:   '+18095559999',
        email:   tenant.email,
        user_id: tenant.id,
      },
      status: 'en_revision',
    });

    const res = await post(`/api/applications/${application.id}/withdraw`,
      { reason: 'Encontré otra propiedad' },
      auth(tenant.token));

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, 'rechazado');
    assert.equal(res.body.status_reason, 'Retirada por el cliente');

    // Timeline event should record the user-supplied reason verbatim and
    // the withdrawn_by_client flag.
    const withdrawEv = (res.body.timeline_events || []).find(e =>
      e.type === 'status_change' && e.data?.withdrawn_by_client === true);
    assert.ok(withdrawEv, 'expected a withdrawn_by_client timeline event');
    assert.equal(withdrawEv.data.user_reason, 'Encontré otra propiedad');
  });

  it('non-owner gets 403', async () => {
    const broker  = await makeBroker('b1-non');
    const listing = makeListing(broker);
    const owner   = await makeTenant('b1-non-owner');
    const stranger = await makeTenant('b1-non-stranger');
    const application = makeApplication(listing, broker, {
      client: { name: 'X', phone: '+18095559999', email: owner.email, user_id: owner.id },
      status: 'aplicado',
    });

    const res = await post(`/api/applications/${application.id}/withdraw`,
      { reason: 'no soy el dueño' },
      auth(stranger.token));

    assert.equal(res.status, 403, res.text);
  });

  it('returns 400 when already in a terminal state (idempotent)', async () => {
    const broker  = await makeBroker('b1-term');
    const listing = makeListing(broker);
    const tenant  = await makeTenant('b1-term');
    const application = makeApplication(listing, broker, {
      client: { name: tenant.name, phone: '+18095559999', email: tenant.email, user_id: tenant.id },
      status: 'rechazado',
    });

    const res = await post(`/api/applications/${application.id}/withdraw`,
      { reason: 'too late' },
      auth(tenant.token));

    assert.equal(res.status, 400, res.text);
  });

  it('voids approved commission and returns assigned unit to available', async () => {
    const broker  = await makeBroker('b1-side');
    // Listing with one unit_inventory entry that's been reserved
    const unitId = 'unit-' + randomUUID().slice(0, 8);
    const listing = makeListing(broker, {
      unit_inventory: [{
        id: unitId, status: 'reserved',
        applicationId: null, clientName: null,
      }],
      units_available: 0,
    });
    const tenant  = await makeTenant('b1-side');
    const application = makeApplication(listing, broker, {
      client: { name: tenant.name, phone: '+18095559999', email: tenant.email, user_id: tenant.id },
      status: 'aprobado',
      assigned_unit: { unitId },
      commission: {
        status: 'approved',
        sale_amount: 100000,
        agent_amount: 5000,
        inmobiliaria_amount: 0,
        payout_id: 'po_test',
        payout_ref: 'pay_ref_test',
      },
    });
    // Mark the unit as held by this app for realism
    listing.unit_inventory[0].applicationId = application.id;
    listing.unit_inventory[0].clientName    = tenant.name;
    store.saveListing(listing);

    const res = await post(`/api/applications/${application.id}/withdraw`,
      { reason: 'cambio de planes' },
      auth(tenant.token));

    assert.equal(res.status, 200, res.text);

    const fresh = store.getApplicationById(application.id);
    assert.equal(fresh.status, 'rechazado');
    assert.equal(fresh.commission?.status, 'voided', 'commission should be voided');
    assert.equal(fresh.commission?.payout_id, null);
    assert.equal(fresh.commission?.payout_ref, null);
    assert.equal(fresh.assigned_unit, null, 'assigned_unit cleared from app');

    const refreshedListing = store.getListingById(listing.id);
    const unit = refreshedListing.unit_inventory.find(u => u.id === unitId);
    assert.equal(unit.status, 'available', 'unit should be back to available');
    assert.equal(unit.applicationId, null);
  });
});

// ════════════════════════════════════════════════════════════════════
// B3 — Magic-link tracking + magic-link withdraw
// ════════════════════════════════════════════════════════════════════
describe('B3 — track-token & magic-link withdraw', () => {
  it('GET /track-token with a valid track token returns the application', async () => {
    const broker = await makeBroker('b3-track');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      client: { name: 'Anon', phone: '+18095551234', email: 'anon@hogaresrd-test.com', user_id: null },
      status: 'aplicado',
    });

    const token = jwt.sign(
      { aid: application.id, kind: 'track' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const res = await get(`/api/applications/track-token?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.id, application.id);
    assert.equal(res.body.status, 'aplicado');
  });

  it('rejects an expired track token', async () => {
    const broker = await makeBroker('b3-exp');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      client: { name: 'Anon', phone: '+18095551234', email: 'anon-x@hogaresrd-test.com', user_id: null },
    });
    const token = jwt.sign(
      { aid: application.id, kind: 'track' },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' }
    );

    const res = await get(`/api/applications/track-token?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 401, res.text);
  });

  it('rejects a track token with the wrong aid', async () => {
    const broker = await makeBroker('b3-aid');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      client: { name: 'Anon', phone: '+18095551234', email: 'anon-y@hogaresrd-test.com', user_id: null },
    });

    // Magic link's withdraw enforces aid === :id. Build a token for some
    // OTHER application and try to withdraw the real one.
    const wrongAidToken = jwt.sign(
      { aid: 'some-other-id-' + randomUUID(), kind: 'track' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const res = await post(
      `/api/applications/${application.id}/withdraw`,
      { reason: 'invalid' },
      { Authorization: `Bearer ${wrongAidToken}` }
    );
    assert.equal(res.status, 403, res.text);
  });

  it('magic-link bearer can withdraw the matching application', async () => {
    const broker = await makeBroker('b3-mlw');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      client: { name: 'Anon', phone: '+18095551234', email: 'anon-z@hogaresrd-test.com', user_id: null },
      status: 'en_revision',
    });

    const token = jwt.sign(
      { aid: application.id, kind: 'track' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const res = await post(
      `/api/applications/${application.id}/withdraw`,
      { reason: 'ya no aplica' },
      { Authorization: `Bearer ${token}` }
    );

    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, 'rechazado');
    assert.equal(res.body.status_reason, 'Retirada por el cliente');
    const ev = (res.body.timeline_events || []).find(e =>
      e.type === 'status_change' && e.data?.withdrawn_by_client === true);
    assert.ok(ev, 'expected withdraw event');
    assert.equal(ev.data.via, 'magic_link');
  });

  it('anonymous create endpoint sends a confirmation email containing /track.html?token=', async () => {
    const broker = await makeBroker('b3-email');
    const listing = makeListing(broker);
    sentEmails.length = 0;

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const anonEmail = `anon-create-${tag}@hogaresrd-test.com`;
    const create = await post('/api/applications', {
      listing_id:    listing.id,
      listing_title: listing.title,
      listing_price: listing.price,
      listing_type:  listing.type,
      name:          'Anónimo',
      phone:         '+18095559999',
      email:         anonEmail,
      // Step-1 required:
      intent: 'comprar', timeline: 'Inmediato', contact_method: 'whatsapp', budget: '150000',
      // Step-2 required:
      id_type: 'cedula', id_number: '00112345678',
      date_of_birth: '1990-01-01',
      current_address: 'Calle Falsa 123',
      employment_status: 'employed',
      employer_name: 'Test Co',
      job_title: 'Tester',
      monthly_income: '50000', income_currency: 'DOP',
      financing: 'banco',
      // Step-3 — defer the two required docs so we don't need attachments.
      deferred_documents: [
        { type: 'cedula',       label: 'Cédula',                required: true },
        { type: 'income_proof', label: 'Comprobante de ingresos', required: true },
      ],
    });

    assert.equal(create.status, 201, create.text);

    // Email is dispatched fire-and-forget — the stub captures it
    // synchronously since transporter.sendMail returns a resolved promise.
    // Allow a microtask for setImmediate-style dispatch.
    await new Promise(r => setImmediate(r));

    const buyerMail = sentEmails.find(m => m.to === anonEmail);
    assert.ok(buyerMail, `expected buyer confirmation email; saw ${sentEmails.map(m => m.to).join(', ')}`);
    assert.match(String(buyerMail.html || ''), /\/track\.html\?token=/);
    assert.match(String(buyerMail.subject || ''), /Recibimos tu aplicación/);
  });
});
