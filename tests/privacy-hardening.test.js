/**
 * Privacy hardening audit (Agent 4-A)
 *
 * Pins down the buyer-facing data minimization story for
 * routes/applications.js. Specifically:
 *
 *   • GET /track-token (magic-link) MUST NOT leak commission, internal
 *     timeline events, broker contact channels, server-side file
 *     paths, or decrypted co-applicant PII. Magic links can be
 *     forwarded and indexed in mail provider logs, so the response
 *     surface is intentionally smaller than GET /:id with auth.
 *
 *   • track-token JWT verification MUST honor JWT_SECRET_PREV during
 *     the rotation grace window — otherwise rotating the secret would
 *     silently invalidate every magic link sent in the previous 14
 *     days (track tokens have 30d expiry).
 *
 *   • GET /my MUST strip is_internal events from each application's
 *     timeline. The endpoint is buyer-only by design, but
 *     decryptAppPII alone doesn't filter events — only the new
 *     scrubForBuyer helper does.
 *
 *   • GET /:id/state polled by a pure client MUST NOT expose
 *     last_event_type/at metadata for an internal event. Otherwise a
 *     polling buyer detects that the broker just filed a private note
 *     even though the body is hidden.
 *
 * Run:  node --test tests/privacy-hardening.test.js
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt    = require('jsonwebtoken');

const {
  startServer, stopServer,
  get, post, auth,
  makeBroker, makeTenant, makeListing, makeApplication,
  store,
} = require('./_app-helpers');

// ── Lifecycle ─────────────────────────────────────────────────────
before(async () => { await startServer(); });
after(stopServer);

// ── Helper: build a fixture app stuffed with sensitive data ──────
//
// Returns the saved app reference so individual tests can inspect /
// mutate without re-fetching from the store cache.
function buildSensitiveApp(broker, tenantUser) {
  const listing = makeListing(broker);
  const app = makeApplication(listing, broker, {
    client: {
      name:    tenantUser.name,
      phone:   '+18095559999',
      email:   tenantUser.email,
      user_id: tenantUser.id,
    },
    // Server-side paths that must never reach the buyer surface.
    payment: {
      amount: 50000, currency: 'DOP',
      receipt_path: '/var/www/hogaresrd/data/uploads/receipt-secret.pdf',
      processed_receipt_path: '/var/www/hogaresrd/data/uploads/processed-secret.pdf',
      receipt_filename: 'receipt-secret.pdf',
      receipt_original: 'receipt.pdf',
      receipt_uploaded_at: new Date().toISOString(),
      verification_status: 'verified',
      verified_at: new Date().toISOString(),
      verified_by: broker.id,
      notes: 'Verified by broker.',
    },
    // Commission block — broker payout details, not buyer-visible.
    commission: {
      status: 'approved',
      sale_amount:        150000,
      agent_amount:       5000,
      inmobiliaria_amount:1500,
      agent_net:          3500,
      payout_id: 'po_12345',
      payout_ref:'STRIPE_REF',
    },
    // Co-applicant with PII that must not appear in scrubbed view.
    co_applicant: {
      name: 'Co Applicant',
      phone: '+18095558888',
      email: 'co@example.com',
      id_number: '402-1234567-8',
      monthly_income: '85000',
    },
    // Broker contact channels that should be scrubbed.
    broker: {
      user_id:     broker.id,
      name:        'Test Broker',
      agency_name: 'Test Agency',
      email:       broker.email,
      phone:       '+18095551234',
    },
  });

  // Add one normal event and one internal event. The internal one
  // must NEVER appear in any buyer-facing payload.
  app.timeline_events = [
    {
      id: 'evt-pub',
      type: 'status_change',
      description: 'Application received',
      actor: 'system', actor_name: 'Sistema', data: {},
      created_at: '2026-04-01T10:00:00.000Z',
    },
    {
      id: 'evt-internal',
      type: 'message',
      description: 'INTERNAL: client probably will fail credit check',
      actor: broker.id, actor_name: 'Test Broker',
      is_internal: true,
      data: { is_internal: true, body: 'private broker note' },
      created_at: '2026-04-02T10:00:00.000Z',
    },
  ];
  store.saveApplication(app);
  return app;
}

// ── Sign a track JWT with whichever secret we want ───────────────
function signTrackToken(aid, secret) {
  return jwt.sign({ aid, kind: 'track' }, secret, { expiresIn: '30d' });
}

// ══════════════════════════════════════════════════════════════════
// GET /track-token — buyer-scrubbed surface
// ══════════════════════════════════════════════════════════════════
describe('GET /api/applications/track-token — scrubs buyer-facing data', () => {
  it('strips commission, internal events, broker contact, payment.receipt_path, co_applicant PII', async () => {
    const broker = await makeBroker('track-scrub');
    const tenant = await makeTenant('track-scrub');
    const app    = buildSensitiveApp(broker, tenant);

    const token = signTrackToken(app.id, process.env.JWT_SECRET);
    const res   = await get(`/api/applications/track-token?token=${encodeURIComponent(token)}`);

    assert.equal(res.status, 200, `track-token failed: ${res.status} ${res.text}`);
    const body = res.body;
    assert.ok(body && typeof body === 'object', 'body should be an object');

    // Commission must be entirely absent.
    assert.equal(body.commission, undefined, 'commission must be stripped');

    // Internal timeline events must be absent.
    assert.ok(Array.isArray(body.timeline_events), 'timeline_events should still be an array');
    const hasInternal = body.timeline_events.some(ev =>
      ev.is_internal === true || ev?.data?.is_internal === true || ev.id === 'evt-internal'
    );
    assert.equal(hasInternal, false, 'internal event must be filtered out');
    // The non-internal event still flows through.
    const hasPublic = body.timeline_events.some(ev => ev.id === 'evt-pub');
    assert.equal(hasPublic, true, 'public event should still be visible');

    // Broker contact channels must be stripped, but name should remain.
    assert.ok(body.broker, 'broker block should still exist');
    assert.equal(body.broker.email, undefined, 'broker.email must be stripped');
    assert.equal(body.broker.phone, undefined, 'broker.phone must be stripped');
    assert.equal(body.broker.name,  'Test Broker', 'broker.name should remain');

    // Server-side payment paths must be stripped, status should remain.
    assert.ok(body.payment, 'payment block should still exist');
    assert.equal(body.payment.receipt_path,           undefined, 'payment.receipt_path must be stripped');
    assert.equal(body.payment.processed_receipt_path, undefined, 'payment.processed_receipt_path must be stripped');
    assert.equal(body.payment.verification_status,    'verified', 'payment.verification_status should remain');
    assert.equal(body.payment.amount,                  50000,     'payment.amount should remain');

    // Co-applicant PII must be stripped, name should remain.
    assert.ok(body.co_applicant, 'co_applicant block should still exist');
    assert.equal(body.co_applicant.id_number,      undefined, 'co_applicant.id_number must be stripped');
    assert.equal(body.co_applicant.monthly_income, undefined, 'co_applicant.monthly_income must be stripped');
    assert.equal(body.co_applicant.name,           'Co Applicant', 'co_applicant.name should remain');
  });
});

// ══════════════════════════════════════════════════════════════════
// JWT rotation — track-token must accept JWT_SECRET_PREV
// ══════════════════════════════════════════════════════════════════
describe('GET /api/applications/track-token — JWT rotation grace', () => {
  it('accepts a token signed with JWT_SECRET_PREV; rejects when prev is unset', async () => {
    const broker = await makeBroker('rotation');
    const tenant = await makeTenant('rotation');
    const app    = buildSensitiveApp(broker, tenant);

    // Snapshot original env so we restore at the end.
    const origSecret = process.env.JWT_SECRET;
    const origPrev   = process.env.JWT_SECRET_PREV;

    // Sign a token with the soon-to-be-previous secret.
    const tokenOld = signTrackToken(app.id, 'previous-secret');

    // Rotate: previous secret moves to PREV slot, new secret takes over.
    process.env.JWT_SECRET      = 'new-secret';
    process.env.JWT_SECRET_PREV = 'previous-secret';

    const okRes = await get(`/api/applications/track-token?token=${encodeURIComponent(tokenOld)}`);
    assert.equal(okRes.status, 200, `with PREV set, old-secret token should succeed (got ${okRes.status} ${okRes.text})`);
    assert.equal(okRes.body.id, app.id, 'response should carry the right application');

    // Drop the prev key — old tokens must now 401.
    delete process.env.JWT_SECRET_PREV;

    const failRes = await get(`/api/applications/track-token?token=${encodeURIComponent(tokenOld)}`);
    assert.equal(failRes.status, 401, `without PREV set, old-secret token must be rejected (got ${failRes.status})`);

    // Restore so subsequent tests aren't affected.
    process.env.JWT_SECRET = origSecret;
    if (origPrev === undefined) delete process.env.JWT_SECRET_PREV;
    else process.env.JWT_SECRET_PREV = origPrev;
  });
});

// ══════════════════════════════════════════════════════════════════
// GET /my — internal events stripped
// ══════════════════════════════════════════════════════════════════
describe('GET /api/applications/my — buyer list view', () => {
  it('omits is_internal events from each application timeline', async () => {
    const broker = await makeBroker('my-list');
    const tenant = await makeTenant('my-list');
    const app    = buildSensitiveApp(broker, tenant);

    const res = await get('/api/applications/my', auth(tenant.token));
    assert.equal(res.status, 200, `/my failed: ${res.status} ${res.text}`);
    assert.ok(Array.isArray(res.body), '/my must return an array');

    const found = res.body.find(a => a.id === app.id);
    assert.ok(found, 'fixture app must be in /my response');

    // Internal events must be absent.
    assert.ok(Array.isArray(found.timeline_events), 'timeline_events should be array');
    const leakedInternal = found.timeline_events.some(ev =>
      ev.is_internal === true || ev?.data?.is_internal === true || ev.id === 'evt-internal'
    );
    assert.equal(leakedInternal, false, '/my must not leak internal events');

    // Public event still flows.
    const hasPublic = found.timeline_events.some(ev => ev.id === 'evt-pub');
    assert.equal(hasPublic, true, '/my should still surface non-internal events');

    // Commission must also be stripped from the list view.
    assert.equal(found.commission, undefined, '/my must not expose commission block');
  });
});

// ══════════════════════════════════════════════════════════════════
// GET /:id/state — pure-client polling must not leak internal metadata
// ══════════════════════════════════════════════════════════════════
describe('GET /api/applications/:id/state — pure client polling', () => {
  it('last_event_type does not reflect an internal-only event for pure clients', async () => {
    const broker = await makeBroker('state-poll');
    const tenant = await makeTenant('state-poll');
    const listing = makeListing(broker);
    const app = makeApplication(listing, broker, {
      client: {
        name:    tenant.name,
        phone:   '+18095559999',
        email:   tenant.email,
        user_id: tenant.id,
      },
    });

    // Public event then a NEWER internal event. For brokers the last
    // event is the internal note (type='message'); for the buyer the
    // last visible event must remain the public 'status_change'.
    app.timeline_events = [
      {
        id: 'evt-pub',
        type: 'status_change',
        description: 'Aplicación recibida',
        actor: 'system', actor_name: 'Sistema', data: {},
        created_at: '2026-04-01T10:00:00.000Z',
      },
      {
        id: 'evt-internal',
        type: 'message',
        description: 'Internal note',
        actor: broker.id, actor_name: 'Test Broker',
        is_internal: true,
        data: { is_internal: true },
        created_at: '2026-04-05T10:00:00.000Z',
      },
    ];
    store.saveApplication(app);

    // Pure client view: must NOT see message-type as last event.
    const buyerRes = await get(`/api/applications/${app.id}/state`, auth(tenant.token));
    assert.equal(buyerRes.status, 200, `state failed for client: ${buyerRes.status} ${buyerRes.text}`);
    assert.notEqual(buyerRes.body.last_event_type, 'message',
      'pure client must not see internal message type as last_event_type');
    assert.equal(buyerRes.body.last_event_type, 'status_change',
      'pure client should see the latest non-internal event');
    assert.equal(buyerRes.body.last_event_at, '2026-04-01T10:00:00.000Z',
      'pure client last_event_at should reflect the public event timestamp');

    // Broker view: still sees the internal event metadata.
    const brokerRes = await get(`/api/applications/${app.id}/state`, auth(broker.token));
    assert.equal(brokerRes.status, 200, `state failed for broker: ${brokerRes.status} ${brokerRes.text}`);
    assert.equal(brokerRes.body.last_event_type, 'message',
      'broker should still see the latest event including internals');
  });
});
