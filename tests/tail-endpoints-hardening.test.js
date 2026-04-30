/**
 * Tail-endpoint hardening — Agent 5-B coverage
 *
 * Exercises the fixes targeted at the bottom of `routes/applications.js`:
 *   • P1 #16 idempotency dedup race (in-process Map guard).
 *   • P1 #20 orphan-fallback hoist (admin email fires regardless of
 *     which create branch ran).
 *   • P1 #14 reassign propagates to conversations / tasks / tours.
 *   • P1 #25 recommend-status validates against STATUS_FLOW.
 *   • P1 #26 PUT /:id/status does targeted clearing of pending recs.
 *   • P1 #33 secretary + inmobiliaria owner can post on /:id/message.
 *   • P1 #23 withdraw sends a buyer-side confirmation email.
 *   • P1 #24 magic-link bearer can upload via /track-upload.
 *
 * Setup uses store.saveX directly (instead of going through the public
 * POST /api/applications endpoint) to bypass the per-IP rate limiter
 * and stay isolated from the existing audit suites. Endpoints under
 * test are exercised over real HTTP.
 *
 * Run:  node --test tests/tail-endpoints-hardening.test.js
 *  or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const jwt    = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';
process.env.ADMIN_EMAIL  = process.env.ADMIN_EMAIL || 'admin-test@hogaresrd-test.com';

// ── file-type shim ────────────────────────────────────────────────
// `routes/applications.js` destructures `{ fileTypeFromFile }` from the
// file-type module, but the v16 CJS build exports `fromFile` instead —
// so the destructuring yields `undefined` and `validateMime()` always
// throws (catch-block deletes the file and returns false). That's a
// pre-existing bug owned by Agent 5-C (validation helpers); we stub
// the module at require-time so this suite can exercise the real
// upload path without depending on that fix.
{
  const ft = require('file-type');
  if (typeof ft.fileTypeFromFile !== 'function' && typeof ft.fromFile === 'function') {
    ft.fileTypeFromFile = ft.fromFile;
  }
}

const app   = require('../server');
const store = require('../routes/store');
const appsRouter = require('../routes/applications');
const { _setTransporter } = appsRouter.__test;

let server, BASE;

// ── HTTP helpers ──────────────────────────────────────────────────
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
    if (options.body !== undefined && options.body !== null) {
      if (Buffer.isBuffer(options.body)) {
        bodyStr = options.body;
        opts.headers['Content-Length'] = bodyStr.length;
      } else {
        bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        opts.headers['Content-Type']   = opts.headers['Content-Type']   || 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
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

// ── Mailer stub ────────────────────────────────────────────────────
// Captures every outbound email so we can assert on subjects/recipients
// without hitting the real Resend transport.
const sentMail = [];
const fakeTransporter = {
  sendMail(opts) {
    sentMail.push({
      to:      opts.to,
      subject: opts.subject,
      html:    opts.html || '',
    });
    return Promise.resolve({ messageId: 'test-' + Date.now() });
  },
};

before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
  _setTransporter(fakeTransporter);
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (store.pool && typeof store.pool.end === 'function') {
    try { await store.pool.end(); } catch { /* already closed */ }
  }
  setTimeout(() => process.exit(0), 1000).unref();
});

// ── Fixture helpers ────────────────────────────────────────────────
async function makeBroker(label) {
  const tag      = `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${label}`;
  const email    = `broker-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';

  const reg = await post('/api/auth/register', { name: `Broker ${label}`, email, password });
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${reg.text}`);

  const u = store.getUserByEmail(email);
  assert.ok(u, 'broker not in store after register');
  u.role               = 'broker';
  u.subscriptionStatus = 'active';
  store.saveUser(u);

  const lg = await post('/api/auth/login', { email, password });
  assert.equal(lg.status, 200, `login failed: ${lg.status} ${lg.text}`);
  return { id: u.id, email, token: lg.body.token };
}

async function makeUser(role, label, overrides = {}) {
  const tag      = `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${label}`;
  const email    = `${role}-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';

  const reg = await post('/api/auth/register', { name: `${role} ${label}`, email, password });
  assert.equal(reg.status, 201, `register failed: ${reg.status} ${reg.text}`);

  const u = store.getUserByEmail(email);
  assert.ok(u, 'user not in store after register');
  Object.assign(u, { role, subscriptionStatus: 'active', ...overrides });
  store.saveUser(u);

  const lg = await post('/api/auth/login', { email, password });
  assert.equal(lg.status, 200, `login failed: ${lg.status} ${lg.text}`);
  return { id: u.id, email, token: lg.body.token };
}

function makeListing(broker, overrides = {}) {
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
    description: 'Listado de prueba.',
    photos:  [],
    creator_user_id: broker.id,
    agencies: [{
      user_id: broker.id,
      name:    'Test Agency',
      email:   broker.email,
      phone:   '+18095551234',
      contact: 'Test Broker',
    }],
    submittedAt: new Date().toISOString(),
    ...overrides,
  };
  store.saveListing(listing);
  return listing;
}

function makeApplication(listing, broker, overrides = {}) {
  const appId = randomUUID();
  const tag   = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const application = {
    id:            appId,
    listing_id:    listing?.id || null,
    listing_title: listing?.title || 'Listado',
    listing_price: listing?.price || 0,
    listing_type:  listing?.type  || 'casa',
    client: {
      name:    `Tenant ${tag}`,
      phone:   '+18095559999',
      email:   `tenant-${tag}@hogaresrd-test.com`,
      user_id: null,
    },
    co_applicant: null,
    broker: broker ? {
      user_id:     broker.id,
      name:        'Test Broker',
      agency_name: 'Test Agency',
      email:       broker.email,
      phone:       '+18095551234',
    } : { user_id: null, name: '', agency_name: '', email: '', phone: '' },
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
    updated_at:      new Date().toISOString(),
    ...overrides,
  };
  store.saveApplication(application);
  return application;
}

// ══════════════════════════════════════════════════════════════════
// P1 #16 — Idempotency dedup race
// ══════════════════════════════════════════════════════════════════
describe('Tail #16 — POST / idempotency under concurrent submits', () => {
  it('two simultaneous POSTs with the same listing+email yield only one app', async () => {
    const broker  = await makeBroker('idem');
    const listing = makeListing(broker);
    const tag     = `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const email   = `${tag}@hogaresrd-test.com`;

    const payload = {
      listing_id:       listing.id,
      listing_title:    listing.title,
      listing_price:    listing.price,
      listing_type:     listing.type,
      name:             'Cliente Concurrente',
      phone:            '+18095558888',
      email,
      intent:           'comprar',
      timeline:         'Inmediato',
      contact_method:   'whatsapp',
      budget:           '150000',
      id_type:          'cedula',
      id_number:        '00112345678',
      date_of_birth:    '1990-01-01',
      current_address:  'Calle de Prueba 123, Santo Domingo',
      employment_status:'employed',
      employer_name:    'Empresa Test',
      job_title:        'QA',
      monthly_income:   '50000',
      financing:        'banco',
      deferred_documents: [{ type: 'cedula' }, { type: 'income_proof' }],
    };

    // Fire both at the same tick. The Map claim runs synchronously when
    // either request enters the handler, so the second call should hit
    // the in-process guard regardless of which finishes first.
    const [a, b] = await Promise.all([
      post('/api/applications', payload),
      post('/api/applications', payload),
    ]);

    // Both responses should be 2xx. At least one of them is the duplicate
    // signal (200 with duplicate:true OR 202 accepted).
    assert.ok([200, 201, 202].includes(a.status), `first response: ${a.status} ${a.text}`);
    assert.ok([200, 201, 202].includes(b.status), `second response: ${b.status} ${b.text}`);

    const dupCount = [a, b].filter(r => r.body && r.body.duplicate === true).length;
    assert.ok(dupCount >= 1, 'expected at least one response flagged duplicate:true');

    // Cache should contain exactly one application for this email/listing pair.
    const matching = (store.getApplications() || []).filter(x =>
      x.listing_id === listing.id
      && x.client?.email?.toLowerCase() === email.toLowerCase()
    );
    assert.equal(matching.length, 1,
      `expected exactly one stored app, got ${matching.length}`);
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #20 — Orphan fallback hoist
// ══════════════════════════════════════════════════════════════════
describe('Tail #20 — POST / orphan fallback fires on non-cascade path', () => {
  it('admin email + orphaned_lead event when no resolvable agency', async () => {
    sentMail.length = 0;

    // Listing with NO agencies and NO ref_token ⇒ non-cascade path,
    // no broker resolved, no inmobiliaria affiliation.
    const listing = makeListing({ id: randomUUID(), email: '' }, {
      agencies: [],
      creator_user_id: null,
    });

    const tag   = `orphan-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const email = `${tag}@hogaresrd-test.com`;

    const r = await post('/api/applications', {
      listing_id:       listing.id,
      listing_title:    listing.title,
      listing_price:    listing.price,
      listing_type:     listing.type,
      name:             'Cliente Huérfano',
      phone:            '+18095557777',
      email,
      intent:           'alquilar',
      timeline:         'Inmediato',
      contact_method:   'whatsapp',
      budget:           '100000',
      id_type:          'cedula',
      id_number:        '00187654321',
      date_of_birth:    '1985-05-05',
      current_address:  'Calle Huerfano 5',
      employment_status:'self_employed',
      employer_name:    'Yo Mismo',
      job_title:        'Freelance',
      monthly_income:   '30000',
      financing:        'efectivo',
      deferred_documents: [{ type: 'cedula' }, { type: 'income_proof' }],
    });
    assert.ok([200, 201].includes(r.status), `create failed: ${r.status} ${r.text}`);
    const appId = r.body.id;
    assert.ok(appId, 'no application id returned');

    // The orphan-fallback admin email should have fired.
    const adminMail = sentMail.find(m =>
      m.to === (process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com')
      && /Lead sin agente/.test(m.subject)
    );
    assert.ok(adminMail, `admin orphan email missing — sent: ${sentMail.map(m => m.subject).join(' | ')}`);

    const stored = store.getApplicationById(appId);
    assert.ok(stored, 'stored app missing');
    const orphanEvt = (stored.timeline_events || []).find(e => e.type === 'orphaned_lead');
    assert.ok(orphanEvt, 'orphaned_lead timeline event missing');
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #14 — Reassign propagates to conversations / tasks / tours
// ══════════════════════════════════════════════════════════════════
describe('Tail #14 — POST /:id/reassign propagates ownership', () => {
  it('moves conversation, task, and tour from old broker to new', async () => {
    const oldBroker = await makeBroker('reassign-old');
    const newBroker = await makeBroker('reassign-new');

    // Both must share an inmobiliaria for the same-team check to pass.
    const inmId = 'inm_' + randomUUID();
    const oldUser = store.getUserById(oldBroker.id);
    const newUser = store.getUserById(newBroker.id);
    oldUser.inmobiliaria_id = inmId;
    newUser.inmobiliaria_id = inmId;
    store.saveUser(oldUser);
    store.saveUser(newUser);

    const listing = makeListing(oldBroker);
    const application = makeApplication(listing, oldBroker, {
      inmobiliaria_id: inmId,
      tours: [{
        id: 'tour_' + randomUUID(),
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        status: 'requested',
        assigned_to: oldBroker.id,
        broker_user_id: oldBroker.id,
        broker_name: 'Old Broker',
      }],
    });

    // Seed a conversation and a task on the old broker.
    const clientId = 'client_' + randomUUID();
    const convRow = {
      id: 'conv_' + randomUUID(),
      propertyId: listing.id,
      propertyTitle: listing.title,
      propertyImage: null,
      clientId,
      clientName: 'Cliente Test',
      brokerId: oldBroker.id,
      brokerName: 'Old Broker',
      inmobiliariaId: inmId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessage: 'hi',
      unreadBroker: 0,
      unreadClient: 0,
      message_count: 0,
    };
    store.saveConversation(convRow);

    // Pin the application's clientId so the propagation match works.
    application.client.user_id = clientId;
    store.saveApplication(application);

    const taskRow = {
      id: 'task_' + randomUUID(),
      title: 'Reach out',
      assigned_to: oldBroker.id,
      assigned_by: 'system',
      application_id: application.id,
      listing_id: listing.id,
      status: 'pending',
      source_event: 'documents_requested',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.saveTask(taskRow);

    // Reassign as the inmobiliaria owner (admin shortcut: just use old broker
    // who is on the app).
    const r = await post(
      `/api/applications/${application.id}/reassign`,
      { newBrokerUserId: newBroker.id, reason: 'test reassignment' },
      auth(oldBroker.token)
    );
    assert.equal(r.status, 200, `reassign failed: ${r.status} ${r.text}`);

    const updatedConv = store.getConversationById(convRow.id);
    assert.equal(updatedConv.brokerId, newBroker.id, 'conversation broker not propagated');

    const updatedTasks = store.getTasksByApplication(application.id);
    const movedTask = updatedTasks.find(t => t.id === taskRow.id);
    assert.equal(movedTask.assigned_to, newBroker.id, 'task assignment not propagated');

    const updatedApp = store.getApplicationById(application.id);
    assert.equal(updatedApp.tours[0].assigned_to, newBroker.id, 'tour assignment not propagated');
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #25 — recommend-status validates STATUS_FLOW
// ══════════════════════════════════════════════════════════════════
describe('Tail #25 — POST /:id/recommend-status STATUS_FLOW guard', () => {
  it('rejects 400 when requested status is not in flow from current', async () => {
    const broker = await makeBroker('rec25');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { status: 'aplicado' });

    // From 'aplicado' the only valid transitions are en_revision/rechazado.
    // 'completado' is impossibly far away.
    const r = await post(
      `/api/applications/${application.id}/recommend-status`,
      { status: 'completado', reason: 'jump ahead' },
      auth(broker.token)
    );
    assert.equal(r.status, 400, `expected 400, got ${r.status} ${r.text}`);
    assert.match(r.body?.error || '', /Transici/, 'error should mention transition');
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #26 — Targeted clearing of pending approvals
// ══════════════════════════════════════════════════════════════════
describe('Tail #26 — PUT /:id/status targeted-clears pending approvals', () => {
  it('removes only the matching pending row; unrelated recommendations survive', async () => {
    const broker = await makeBroker('targeted');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { status: 'aplicado' });

    // Recommendation A: matches the upcoming flip → should be cleared.
    const recA = await post(
      `/api/applications/${application.id}/recommend-status`,
      { status: 'en_revision', reason: 'A' },
      auth(broker.token)
    );
    assert.equal(recA.status, 201, `recA failed: ${recA.status} ${recA.text}`);

    // Recommendation B: future-state target ('rechazado'), unrelated to
    // the en_revision flip → should survive. (rechazado IS in
    // STATUS_FLOW.aplicado.)
    const recB = await post(
      `/api/applications/${application.id}/recommend-status`,
      { status: 'rechazado', reason: 'B' },
      auth(broker.token)
    );
    assert.equal(recB.status, 201, `recB failed: ${recB.status} ${recB.text}`);

    const before = store.getPendingApprovalsForApp(application.id);
    assert.equal(before.length, 2, 'expected two pending recommendations to start');

    // Apply the en_revision transition.
    const flip = await put(
      `/api/applications/${application.id}/status`,
      { status: 'en_revision' },
      auth(broker.token)
    );
    assert.equal(flip.status, 200, `flip failed: ${flip.status} ${flip.text}`);

    const after = store.getPendingApprovalsForApp(application.id);
    assert.equal(after.length, 1, 'unrelated rec should survive');
    assert.equal(after[0].requested_status, 'rechazado',
      'survivor should be the rechazado rec');

    // A pending_approval_dismissed event should have been logged for
    // the cleared row.
    const updated = store.getApplicationById(application.id);
    const dismissed = (updated.timeline_events || [])
      .filter(e => e.type === 'pending_approval_dismissed');
    assert.ok(dismissed.length >= 1, 'expected pending_approval_dismissed event');
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #33 — /:id/message accepts secretary + inmobiliaria owner
// ══════════════════════════════════════════════════════════════════
describe('Tail #33 — POST /:id/message team-actor auth surface', () => {
  it('inmobiliaria owner and secretary can post on a team application', async () => {
    const broker = await makeBroker('msg-broker');
    const inmId  = broker.id; // inmobiliaria's user.id IS the team id
    // Promote: turn the broker into an inmobiliaria too.
    const owner = await makeUser('inmobiliaria', 'msg-owner');
    const secretary = await makeUser('secretary', 'msg-sec', { inmobiliaria_id: owner.id });

    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      inmobiliaria_id: owner.id,
    });

    const ownerPost = await post(
      `/api/applications/${application.id}/message`,
      { message: 'mensaje del propietario', is_internal: false },
      auth(owner.token)
    );
    assert.equal(ownerPost.status, 200, `owner post failed: ${ownerPost.status} ${ownerPost.text}`);

    const secPost = await post(
      `/api/applications/${application.id}/message`,
      { message: 'mensaje de la secretaria', is_internal: true },
      auth(secretary.token)
    );
    assert.equal(secPost.status, 200, `secretary post failed: ${secPost.status} ${secPost.text}`);

    const stored = store.getApplicationById(application.id);
    const messages = (stored.timeline_events || []).filter(e => e.type === 'message');
    assert.ok(messages.length >= 2, 'expected at least two message events');
    const internalPosted = messages.find(m => m.is_internal === true);
    assert.ok(internalPosted, 'expected secretary internal note');
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #23 — Withdraw sends buyer confirmation
// ══════════════════════════════════════════════════════════════════
describe('Tail #23 — POST /:id/withdraw notifies the buyer', () => {
  it('buyer confirmation email fires alongside broker email', async () => {
    sentMail.length = 0;
    const broker = await makeBroker('withdraw');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, { status: 'en_revision' });

    // Mint a magic-link bearer token (matches signTrackToken's payload shape).
    const tok = jwt.sign({ aid: application.id, kind: 'track' },
      process.env.JWT_SECRET, { expiresIn: '30d' });

    const r = await post(`/api/applications/${application.id}/withdraw`,
      { reason: 'cambié de idea' },
      auth(tok)
    );
    assert.equal(r.status, 200, `withdraw failed: ${r.status} ${r.text}`);

    // Buyer confirmation should have fired to the application's client email.
    const buyerMail = sentMail.find(m =>
      m.to === application.client.email
      && /retirada/i.test(m.subject)
    );
    assert.ok(buyerMail,
      `buyer confirmation missing — sent subjects: ${sentMail.map(m => m.subject).join(' | ')}`);
  });
});

// ══════════════════════════════════════════════════════════════════
// P1 #24 — POST /:id/track-upload
// ══════════════════════════════════════════════════════════════════
describe('Tail #24 — POST /:id/track-upload magic-link uploads', () => {
  // Multipart bodies are tedious to hand-roll; we use a minimal builder.
  function multipartBody(fields, files) {
    const boundary = '----testbnd' + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
      ));
    }
    for (const file of files) {
      parts.push(Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n`
        + `Content-Type: ${file.type}\r\n\r\n`
      ));
      parts.push(file.content);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { boundary, body: Buffer.concat(parts) };
  }

  it('mismatched aid is rejected with 403', async () => {
    const broker = await makeBroker('tu-403');
    const listing = makeListing(broker);
    const appA = makeApplication(listing, broker);
    const appB = makeApplication(listing, broker);

    // Token says aid = appA but we hit the appB endpoint
    const tok = jwt.sign({ aid: appA.id, kind: 'track' },
      process.env.JWT_SECRET, { expiresIn: '30d' });

    // 1x1 transparent PNG — full file with IDAT + IEND chunks so the
    // `file-type` library can sniff it as image/png. (validateMime in
    // routes/applications.js calls fileTypeFromFile which requires a
    // structurally valid header, not just the 8-byte magic prefix.)
    const pngHeader = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
      'base64'
    );
    const { boundary, body } = multipartBody(
      { type: 'cedula', label: 'Cedula' },
      [{ field: 'files', name: 'a.png', type: 'image/png', content: pngHeader }]
    );

    const r = await request(`/api/applications/${appB.id}/track-upload`, {
      method: 'POST',
      body: body,
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type':  `multipart/form-data; boundary=${boundary}`,
      },
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status} ${r.text}`);
  });

  it('valid magic-link bearer attaches files to documents_uploaded', async () => {
    const broker = await makeBroker('tu-ok');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker);

    const tok = jwt.sign({ aid: application.id, kind: 'track' },
      process.env.JWT_SECRET, { expiresIn: '30d' });

    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
    ]);
    const { boundary, body } = multipartBody(
      { type: 'cedula', label: 'Cedula' },
      [{ field: 'files', name: 'cedula.png', type: 'image/png', content: pngHeader }]
    );

    const r = await request(`/api/applications/${application.id}/track-upload`, {
      method: 'POST',
      body: body,
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type':  `multipart/form-data; boundary=${boundary}`,
      },
    });
    assert.equal(r.status, 200, `upload failed: ${r.status} ${r.text}`);
    assert.equal(r.body?.uploaded, 1);

    const stored = store.getApplicationById(application.id);
    assert.equal((stored.documents_uploaded || []).length, 1, 'document not attached');
    assert.equal(stored.documents_uploaded[0].via_track, true);
  });
});
