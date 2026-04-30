/**
 * Application workflow audit
 *
 * Drives the application state machine through the most consequential
 * paths: full happy path (anon → completado), rejection-with-reason,
 * subscription-lapses-mid-flow, idempotency on no-op transitions, and
 * the skip-phase escape hatch (broker bypassing client_auto stages).
 *
 * Setup uses store.saveUser / saveListing / saveApplication directly
 * because the public POST /api/applications endpoint is rate-limited
 * to 5/hour per IP — testing 5+ scenarios from 127.0.0.1 would trip
 * the limiter. The endpoints under audit (PUT /:id/status,
 * POST /:id/skip-phase) are exercised via real HTTP.
 *
 * Run:  node --test tests/applications-workflow.test.js
 *  or:  npm test  (after wiring into package.json)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { randomUUID } = require('node:crypto');

process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV   = 'test';

const app   = require('../server');
const store = require('../routes/store');
const appsRouter = require('../routes/applications');
const {
  recordNotificationFailure,
  recordInventorySyncFailure,
  _setTransporter,
} = appsRouter.__test;

// ── Boilerplate ─────────────────────────────────────────────────────
let server, BASE;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url  = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers },
    };
    let bodyStr = null;
    if (options.body) {
      bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      opts.headers['Content-Type']   = opts.headers['Content-Type']   || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text: raw });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const post = (p, b, h) => request(p, { method: 'POST', body: b, headers: h });
const put  = (p, b, h) => request(p, { method: 'PUT',  body: b, headers: h });
const auth = (token) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (store.pool && typeof store.pool.end === 'function') {
    try { await store.pool.end(); } catch { /* already closed */ }
  }
  // Belt-and-suspenders: cron jobs still hold a tick. Force-exit shortly
  // after teardown so the runner doesn't hang.
  setTimeout(() => process.exit(0), 1000).unref();
});

// ── Per-scenario fixtures ───────────────────────────────────────────
//
// Each describe-block creates its own broker + listing + application
// to stay isolated. Setup goes through the public register/login API
// (so we get a real JWT) then mutates the user in-store to flip on the
// subscription + role bits we need.

async function makeBroker(label) {
  const tag      = `${Date.now()}-${Math.floor(Math.random() * 10000)}-${label}`;
  const email    = `broker-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';

  const reg = await post('/api/auth/register', {
    name: `Broker ${label}`, email, password,
  });
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${reg.text}`);

  const lg = await post('/api/auth/login', { email, password });
  assert.equal(lg.status, 200, `login failed: ${lg.status} ${lg.text}`);
  const token = lg.body.token;
  assert.ok(token, 'login returned no token');

  const u = store.getUserByEmail(email);
  assert.ok(u, 'user not in store after register');
  u.role               = 'broker';
  u.subscriptionStatus = 'active';
  store.saveUser(u);

  return { id: u.id, email, token };
}

function makeListing(broker) {
  const id = randomUUID();
  const listing = {
    id,
    title:    'Casa de Prueba',
    price:    150000,
    currency: 'USD',
    type:     'casa',
    status:   'approved',
    bedrooms: 3, bathrooms: 2, area: 180,
    location: 'Santo Domingo',
    description: 'Listado de prueba para auditoría de workflow.',
    photos:  [],
    agencies: [{
      user_id: broker.id,
      name:    'Test Agency',
      email:   broker.email,
      phone:   '+18095551234',
      contact: 'Test Broker',
    }],
    submittedAt: new Date().toISOString(),
  };
  store.saveListing(listing);
  return listing;
}

function makeApplication(listing, broker, overrides = {}) {
  const appId = randomUUID();
  const tag   = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const application = {
    id:            appId,
    listing_id:    listing.id,
    listing_title: listing.title,
    listing_price: listing.price,
    listing_type:  listing.type,
    client: {
      name:    `Tenant ${tag}`,
      phone:   '+18095559999',
      email:   `tenant-${tag}@hogaresrd-test.com`,
      user_id: null,
    },
    co_applicant: null,
    broker: {
      user_id:     broker.id,
      name:        'Test Broker',
      agency_name: 'Test Agency',
      email:       broker.email,
      phone:       '+18095551234',
    },
    status:        'aplicado',
    status_reason: '',
    intent:        'comprar',
    timeline:      'Inmediato',
    contact_method:'whatsapp',
    documents_requested: [],
    documents_uploaded:  [],
    tours: [],
    payment: {
      amount: null, currency: 'DOP', receipt_path: null,
      receipt_filename: null, receipt_original: null,
      receipt_uploaded_at: null, verification_status: 'none',
      verified_at: null, verified_by: null, notes: '',
    },
    payment_plan:    null,
    inmobiliaria_id: null,
    timeline_events: [],
    created_at:      new Date().toISOString(),
    ...overrides,
  };
  store.saveApplication(application);
  return application;
}

// ════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Happy path: anon submission walked all the way to
//              completado via PUT + skip-phase for client_auto stages.
// ════════════════════════════════════════════════════════════════════

describe('Scenario 1 — Happy path: aplicado → completado', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('happy');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
  });

  it('walks the full state machine to completado', async () => {
    const steps = [
      { kind: 'put',  status: 'en_revision'    },
      { kind: 'put',  status: 'en_aprobacion'  },
      { kind: 'put',  status: 'aprobado'       },
      { kind: 'put',  status: 'pendiente_pago' },
      // pago_enviado is client_auto — broker uses skip-phase off-platform
      { kind: 'skip', status: 'pago_enviado',  reason: 'Pago vía transferencia bancaria off-platform' },
      // pago_aprobado is review_auto — broker confirms via skip-phase
      { kind: 'skip', status: 'pago_aprobado', reason: 'Verificado por banco directamente' },
      { kind: 'put',  status: 'completado'     },
    ];

    for (const s of steps) {
      const res = s.kind === 'put'
        ? await put (`/api/applications/${appId}/status`,     { status: s.status },              auth(broker.token))
        : await post(`/api/applications/${appId}/skip-phase`, { status: s.status, reason: s.reason }, auth(broker.token));
      assert.equal(res.status, 200,
        `step ${s.kind} → ${s.status} failed: ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.status, s.status,
        `expected ${s.status}, got ${res.body?.status}`);
    }
  });

  it('timeline records each transition with from/to/actor', () => {
    const final = store.getApplicationById(appId);
    assert.equal(final.status, 'completado');
    const transitions = (final.timeline_events || []).filter(e => e.type === 'status_change');
    assert.equal(transitions.length, 7, `expected 7 status_change events, got ${transitions.length}`);
    assert.equal(transitions[0].data.from, 'aplicado');
    assert.equal(transitions[0].data.to,   'en_revision');
    // skip-phase events carry manual_skip:true; PUT does not
    const skips = transitions.filter(e => e.data?.manual_skip);
    assert.equal(skips.length, 2, 'two skip-phase events should be flagged manual_skip');
  });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Rejection with reason, then re-application reset.
// ════════════════════════════════════════════════════════════════════

describe('Scenario 2 — Rejection: reason required, persisted, resettable', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('reject');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
  });

  it('rejecting without a reason is blocked with 400', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'rechazado' }, auth(broker.token));
    assert.equal(res.status, 400);
    assert.match(res.body?.error || '', /razón/i);
  });

  it('rejecting with a reason persists status_reason and emits notification side-effect', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'rechazado', reason: 'Ingresos insuficientes para el precio solicitado.' },
      auth(broker.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'rechazado');
    assert.equal(res.body.status_reason, 'Ingresos insuficientes para el precio solicitado.');

    const stored = store.getApplicationById(appId);
    const evt = (stored.timeline_events || []).find(e => e.data?.to === 'rechazado');
    assert.ok(evt, 'no rejection event in timeline');
    assert.equal(evt.data.reason, 'Ingresos insuficientes para el precio solicitado.');
  });

  it('rejected app can be reset back to aplicado (re-apply path)', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'aplicado' }, auth(broker.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'aplicado');
  });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Unexpected: subscription lapses mid-flow.
// ════════════════════════════════════════════════════════════════════

describe('Scenario 3 — Subscription expires mid-flow → 402, recovers on renewal', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('sub');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
    // Move forward while subscription is active
    const r = await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    assert.equal(r.status, 200, 'pre-condition: en_revision should succeed');
  });

  it('subscription cancelled → next status change returns 402 needsSubscription', async () => {
    const u = store.getUserById(broker.id);
    u.subscriptionStatus = 'canceled';
    store.saveUser(u);

    const res = await put(`/api/applications/${appId}/status`,
      { status: 'en_aprobacion' }, auth(broker.token));
    assert.equal(res.status, 402);
    assert.equal(res.body.needsSubscription, true);
  });

  it('skip-phase is gated by the same check', async () => {
    const res = await post(`/api/applications/${appId}/skip-phase`,
      { status: 'en_aprobacion', reason: 'Trying while sub canceled' },
      auth(broker.token));
    assert.equal(res.status, 402);
    assert.equal(res.body.needsSubscription, true);
  });

  it('reactivating subscription unblocks the workflow', async () => {
    const u = store.getUserById(broker.id);
    u.subscriptionStatus = 'active';
    store.saveUser(u);

    const res = await put(`/api/applications/${appId}/status`,
      { status: 'en_aprobacion' }, auth(broker.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'en_aprobacion');
  });

  it('past_due (Stripe grace period) is treated as active', async () => {
    const u = store.getUserById(broker.id);
    u.subscriptionStatus = 'past_due';
    store.saveUser(u);

    const res = await put(`/api/applications/${appId}/status`,
      { status: 'aprobado' }, auth(broker.token));
    assert.equal(res.status, 200, `past_due should pass: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, 'aprobado');

    // restore for any later assertions
    u.subscriptionStatus = 'active';
    store.saveUser(u);
  });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Idempotency, ownership guards, invalid transitions.
// ════════════════════════════════════════════════════════════════════

describe('Scenario 4 — Edge cases: idempotency, ownership, invalid transitions', () => {
  let broker, otherBroker, listing, appId;

  before(async () => {
    broker      = await makeBroker('edge');
    otherBroker = await makeBroker('other');
    listing     = makeListing(broker);
    appId       = makeApplication(listing, broker).id;
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
  });

  it('setting same status returns 200 with current state (no transition error)', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'en_revision');
  });

  it('invalid transition (en_revision → completado) returns 400 with explanation', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'completado' }, auth(broker.token));
    assert.equal(res.status, 400);
    assert.match(res.body?.error || '', /Transición no válida/);
  });

  it('client_auto status via PUT is rejected with status_not_broker_settable', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'pago_enviado' }, auth(broker.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'status_not_broker_settable');
    assert.equal(res.body.ownership, 'client_auto');
  });

  it('a different broker cannot move someone else\'s application (403)', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'en_aprobacion' }, auth(otherBroker.token));
    assert.equal(res.status, 403);
  });

  it('unauthenticated status change returns 401', async () => {
    const res = await put(`/api/applications/${appId}/status`,
      { status: 'en_aprobacion' }); // no auth header
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Skip-phase escape hatch: guards + happy use.
// ════════════════════════════════════════════════════════════════════

describe('Scenario 5 — Skip-phase: requires reason, blocks rechazado, audit-trails the override', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('skip');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'documentos_requeridos' }, auth(broker.token));
  });

  it('skip-phase without a reason returns 400 note_required', async () => {
    const res = await post(`/api/applications/${appId}/skip-phase`,
      { status: 'documentos_enviados' }, auth(broker.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'note_required');
  });

  it('skip-phase with a reason shorter than 5 chars returns 400', async () => {
    const res = await post(`/api/applications/${appId}/skip-phase`,
      { status: 'documentos_enviados', reason: 'ok' }, auth(broker.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'note_required');
  });

  it('skip-phase to rechazado is blocked even with a valid reason', async () => {
    const res = await post(`/api/applications/${appId}/skip-phase`,
      { status: 'rechazado', reason: 'Trying to bypass rejection zone' },
      auth(broker.token));
    assert.equal(res.status, 400);
    assert.match(res.body?.error || '', /rechaz/i);
  });

  it('skip-phase to a valid client_auto status with a real reason succeeds and audit-trails', async () => {
    const reason = 'Cliente envió docs por WhatsApp; verificados manualmente.';
    const res = await post(`/api/applications/${appId}/skip-phase`,
      { status: 'documentos_enviados', reason }, auth(broker.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'documentos_enviados');

    const stored = store.getApplicationById(appId);
    const evt = (stored.timeline_events || []).find(e =>
      e.data?.to === 'documentos_enviados' && e.data?.manual_skip === true);
    assert.ok(evt, 'skip-phase did not record a manual_skip event');
    assert.equal(evt.data.reason, reason);
    assert.equal(evt.data.skipped_by, broker.id);
  });

  it('skip-phase on a finalized (completado) app is blocked', async () => {
    // Drive this app to completado first
    await post(`/api/applications/${appId}/skip-phase`,
      { status: 'en_aprobacion', reason: 'Documents reviewed off-platform' },
      auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'aprobado' }, auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'pendiente_pago' }, auth(broker.token));
    await post(`/api/applications/${appId}/skip-phase`,
      { status: 'pago_enviado', reason: 'Off-platform receipt' },
      auth(broker.token));
    await post(`/api/applications/${appId}/skip-phase`,
      { status: 'pago_aprobado', reason: 'Off-platform verification' },
      auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'completado' }, auth(broker.token));

    const res = await post(`/api/applications/${appId}/skip-phase`,
      { status: 'aprobado', reason: 'Should not be allowed on terminal state' },
      auth(broker.token));
    assert.equal(res.status, 400);
    assert.match(res.body?.error || '', /finalizada/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Failure tracking: notification + inventory sync no
//              longer fail silently. Both paths now leave an
//              auditable record on the application so a follow-up
//              (manual or automated retry) can address them.
// ════════════════════════════════════════════════════════════════════

describe('Scenario 6 — Notification failures are recorded on the application', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('notif');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
  });

  it('recordNotificationFailure() pushes onto notification_failures and timeline', () => {
    const before = store.getApplicationById(appId);
    const failuresBefore = (before.notification_failures || []).length;
    const eventsBefore   = (before.timeline_events || []).length;

    recordNotificationFailure(before, {
      recipient: 'tenant@example.com',
      subject:   'Tu aplicación ha sido rechazada',
      purpose:   'status_change',
      error:     'SMTP 550 — mailbox unavailable',
    });

    const after = store.getApplicationById(appId);
    assert.equal((after.notification_failures || []).length, failuresBefore + 1);
    const entry = after.notification_failures.at(-1);
    assert.equal(entry.recipient, 'tenant@example.com');
    assert.equal(entry.purpose,   'status_change');
    assert.equal(entry.error,     'SMTP 550 — mailbox unavailable');
    assert.equal(entry.retried,   false);

    const events = (after.timeline_events || []).slice(eventsBefore);
    const evt = events.find(e => e.type === 'notification_failed');
    assert.ok(evt, 'no notification_failed timeline event recorded');
    assert.equal(evt.data.recipient, 'tenant@example.com');
  });

  it('failed mail through PUT /:id/status writes a notification_failures entry', async () => {
    // Stub the mailer to reject. Real route + real handler will now
    // catch the rejection and record it on the app.
    const origTransporter = { sendMail: () => Promise.reject(new Error('Network unreachable')) };
    _setTransporter(origTransporter);
    try {
      const res = await put(`/api/applications/${appId}/status`,
        { status: 'en_revision' }, auth(broker.token));
      assert.equal(res.status, 200, 'workflow itself should still succeed even when email fails');

      // The catch is async; wait a tick for the rejection to propagate
      // and the failure recorder to flush to store.
      await new Promise(r => setTimeout(r, 50));

      const stored = store.getApplicationById(appId);
      const fails  = (stored.notification_failures || []).filter(f => f.purpose === 'status_change');
      // Scan all status_change failures — earlier tests in this suite
      // may have populated their own entries on the same app.
      const ours = fails.find(f => /Network unreachable/.test(f.error));
      assert.ok(ours, `expected a Network-unreachable failure on the app, got: ${JSON.stringify(fails.map(f => f.error))}`);
    } finally {
      // Restore — best effort, just stub a quiet success transporter so
      // later tests don't inherit our reject-everything stub.
      _setTransporter({ sendMail: () => Promise.resolve({ messageId: 'noop' }) });
    }
  });

  it('failed mail through skip-phase records purpose=skip_phase', async () => {
    // App is now en_revision from the previous test. Move forward.
    await put(`/api/applications/${appId}/status`,
      { status: 'documentos_requeridos' }, auth(broker.token));

    _setTransporter({ sendMail: () => Promise.reject(new Error('SMTP timeout')) });
    try {
      const res = await post(`/api/applications/${appId}/skip-phase`,
        { status: 'documentos_enviados', reason: 'Cliente envió docs por WhatsApp' },
        auth(broker.token));
      assert.equal(res.status, 200);

      await new Promise(r => setTimeout(r, 50));

      const stored = store.getApplicationById(appId);
      const skipFails = (stored.notification_failures || []).filter(f => f.purpose === 'skip_phase');
      assert.equal(skipFails.length, 1, 'skip-phase failed-mail not recorded');
      assert.match(skipFails[0].error, /SMTP timeout/);
    } finally {
      _setTransporter({ sendMail: () => Promise.resolve({ messageId: 'noop' }) });
    }
  });
});

describe('Scenario 7 — Inventory sync failures are recorded on the application', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('inv');
    listing = makeListing(broker);

    // Application with an assigned unit + the listing has unit_inventory
    // so the inventory-sync block actually runs on a status change.
    listing.unit_inventory = [{ id: 'unit-A1', status: 'available' }];
    store.saveListing(listing);
    appId = makeApplication(listing, broker, {
      assigned_unit: { unitId: 'unit-A1', label: 'Unit A1' },
    }).id;
  });

  it('recordInventorySyncFailure() flags the app + writes a timeline event', () => {
    const before = store.getApplicationById(appId);
    const eventsBefore = (before.timeline_events || []).length;

    recordInventorySyncFailure(before, new Error('DB write timeout'), 'unit-A1');

    const after = store.getApplicationById(appId);
    assert.ok(after.inventory_sync_failed_at, 'inventory_sync_failed_at not set');
    assert.equal(after.inventory_sync_error,   'DB write timeout');
    assert.equal(after.inventory_sync_unit_id, 'unit-A1');

    const events = (after.timeline_events || []).slice(eventsBefore);
    const evt = events.find(e => e.type === 'inventory_sync_failed');
    assert.ok(evt, 'no inventory_sync_failed timeline event recorded');
    assert.equal(evt.data.unitId, 'unit-A1');
    assert.match(evt.data.error, /DB write timeout/);
  });

  it('a saveListing throw during status change records the failure (terminal-state path)', async () => {
    // Walk to en_aprobacion so we can transition to aprobado, which
    // triggers the inventory sync.
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'en_aprobacion' }, auth(broker.token));

    // Stub saveListing to throw so the inventory sync hits its catch.
    const origSaveListing = store.saveListing;
    store.saveListing = () => { throw new Error('PG connection lost'); };
    try {
      const res = await put(`/api/applications/${appId}/status`,
        { status: 'aprobado' }, auth(broker.token));
      assert.equal(res.status, 200,
        'workflow should still complete even when the inventory side-effect throws');

      const stored = store.getApplicationById(appId);
      assert.ok(stored.inventory_sync_failed_at, 'no inventory_sync_failed_at on app');
      assert.match(stored.inventory_sync_error, /PG connection lost/);
      const evt = (stored.timeline_events || []).find(e => e.type === 'inventory_sync_failed');
      assert.ok(evt, 'no inventory_sync_failed timeline event after throw');
    } finally {
      store.saveListing = origSaveListing;
    }
  });
});
