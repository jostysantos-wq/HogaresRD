// ══════════════════════════════════════════════════════════════════════════
// Agency / constructora oversight tests (D1, D2, D3, D4, D6, D7).
//
// Targets the audit items shipped by Group 4. Each test wires a small
// fixture (broker / owner / app / listing) and exercises a single endpoint.
// ══════════════════════════════════════════════════════════════════════════

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, stopServer,
  get, post, put, auth,
  makeBroker, makeListing, makeApplication,
  installInMemoryStoreShims,
  store,
} = require('./_app-helpers');

let BASE;

before(async () => {
  installInMemoryStoreShims();
  ({ BASE } = await startServer());
});

after(stopServer);

// ── Fixture helpers ──────────────────────────────────────────────
async function makeOwner(label) {
  // Re-use makeBroker, then flip role to inmobiliaria/constructora
  const o = await makeBroker(label);
  const u = store.getUserById(o.id);
  u.role = 'inmobiliaria';
  u.subscriptionStatus = 'active';
  store.saveUser(u);
  return o;
}
async function makeSecretary(label, inmId) {
  const s = await makeBroker(label);
  const u = store.getUserById(s.id);
  u.role = 'secretary';
  u.inmobiliaria_id = inmId;
  u.subscriptionStatus = 'active';
  store.saveUser(u);
  return s;
}
function attachBrokerToInm(brokerId, inmId) {
  const u = store.getUserById(brokerId);
  u.inmobiliaria_id = inmId;
  u.inmobiliaria_join_status = 'approved';
  u.access_level = 1;
  store.saveUser(u);
}

// ── D1: broker remove transfers open apps; closed apps untouched ──
test('D1: removing a broker transfers open applications to the team owner', async () => {
  const owner = await makeOwner('d1-owner');
  const brokerA = await makeBroker('d1-a');
  attachBrokerToInm(brokerA.id, owner.id);

  const listing = makeListing(brokerA);
  // Two open + one closed application owned by brokerA
  const openApp1 = makeApplication(listing, brokerA, { status: 'aplicado',     inmobiliaria_id: owner.id });
  const openApp2 = makeApplication(listing, brokerA, { status: 'en_revision',  inmobiliaria_id: owner.id });
  const doneApp  = makeApplication(listing, brokerA, { status: 'completado',   inmobiliaria_id: owner.id });

  const r = await post(`/api/inmobiliaria/brokers/${brokerA.id}/remove`,
    { transferToUserId: owner.id }, auth(owner.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const a1 = store.getApplicationById(openApp1.id);
  const a2 = store.getApplicationById(openApp2.id);
  const a3 = store.getApplicationById(doneApp.id);
  assert.equal(a1.broker.user_id, owner.id, 'open app1 reassigned');
  assert.equal(a2.broker.user_id, owner.id, 'open app2 reassigned');
  assert.equal(a3.broker.user_id, brokerA.id, 'completed app NOT touched');

  const evt = (a1.timeline_events || []).find(e => e.type === 'broker_reassigned');
  assert.ok(evt, 'broker_reassigned timeline event recorded');
  assert.equal(evt.data.from, brokerA.id);
  assert.equal(evt.data.to, owner.id);
});

// ── D2: secretary cannot directly approve; can recommend; queue is owner-only ──
test('D2: secretary aprobado→403; recommend creates queue; owner-only listing', async () => {
  const owner     = await makeOwner('d2-owner');
  const broker    = await makeBroker('d2-b');
  attachBrokerToInm(broker.id, owner.id);
  const secretary = await makeSecretary('d2-sec', owner.id);

  const listing = makeListing(broker);
  // Application that's eligible to move to aprobado: en_aprobacion → aprobado.
  const app = makeApplication(listing, broker, {
    status: 'en_aprobacion',
    inmobiliaria_id: owner.id,
  });

  // Secretary tries to flip it to aprobado directly → 403.
  const r1 = await put(`/api/applications/${app.id}/status`,
    { status: 'aprobado' }, auth(secretary.token));
  assert.equal(r1.status, 403, JSON.stringify(r1.body));
  assert.equal(r1.body.code, 'requires_escalation');

  // Secretary recommends instead → 201 + pending row created.
  const r2 = await post(`/api/applications/${app.id}/recommend-status`,
    { status: 'aprobado', reason: 'cliente listo' }, auth(secretary.token));
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.approval.requested_status, 'aprobado');

  // Owner sees the queue.
  const r3 = await get('/api/inmobiliaria/pending-approvals', auth(owner.token));
  assert.equal(r3.status, 200);
  assert.ok(Array.isArray(r3.body.pending));
  assert.ok(r3.body.pending.find(p => p.application_id === app.id),
    'owner sees the recommendation in their queue');

  // A non-owner (the secretary) is blocked from the queue.
  const r4 = await get('/api/inmobiliaria/pending-approvals', auth(secretary.token));
  assert.equal(r4.status, 403);
});

// ── D3: completed without pre-reserved unit grabs an available unit ───
test('D3: completed→ auto-assigns next available unit OR logs completed_without_unit', async () => {
  const owner  = await makeOwner('d3-owner');
  const broker = await makeBroker('d3-b');
  attachBrokerToInm(broker.id, owner.id);

  // Listing with two units (one available, one already sold).
  const listing = makeListing(broker, {
    unit_inventory: [
      { id: 'u-a', label: 'A1', status: 'available', applicationId: null, clientName: null },
      { id: 'u-b', label: 'B1', status: 'sold',      applicationId: 'old', clientName: 'X' },
    ],
    units_available: 1,
  });

  // App in pago_aprobado, ready to move to completado, no assigned_unit.
  const app = makeApplication(listing, broker, {
    status: 'pago_aprobado',
    inmobiliaria_id: owner.id,
    assigned_unit:   null,
  });

  const r = await put(`/api/applications/${app.id}/status`,
    { status: 'completado' }, auth(owner.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const fresh = store.getApplicationById(app.id);
  assert.equal(fresh.status, 'completado');
  assert.ok(fresh.assigned_unit && fresh.assigned_unit.unitId === 'u-a',
    'available unit auto-assigned');
  const freshListing = store.getListingById(listing.id);
  const u = freshListing.unit_inventory.find(x => x.id === 'u-a');
  assert.equal(u.status, 'sold');

  // ── Second app on a listing whose inventory is exhausted ──
  const broker2 = await makeBroker('d3-b2');
  attachBrokerToInm(broker2.id, owner.id);
  const emptyListing = makeListing(broker2, {
    unit_inventory: [
      { id: 'eu-1', label: 'X1', status: 'sold', applicationId: 'old', clientName: 'X' },
    ],
    units_available: 0,
  });
  const app2 = makeApplication(emptyListing, broker2, {
    status: 'pago_aprobado',
    inmobiliaria_id: owner.id,
    assigned_unit:   null,
  });
  const r2 = await put(`/api/applications/${app2.id}/status`,
    { status: 'completado' }, auth(owner.token));
  assert.equal(r2.status, 200);
  const a2 = store.getApplicationById(app2.id);
  const ev = (a2.timeline_events || []).find(e => e.type === 'completed_without_unit');
  assert.ok(ev, 'completed_without_unit event recorded when inventory exhausted');
});

// ── D4: non-owner mutation on inventory → 403 with code 'not_owner' ──
test('D4: non-owner POST to /api/inventory/:id/units → 403 not_owner', async () => {
  const owner  = await makeOwner('d4-owner');
  const broker = await makeBroker('d4-b');
  attachBrokerToInm(broker.id, owner.id);
  // Owner role used to be inmobiliaria; D4 requires constructora to write.
  const u = store.getUserById(owner.id);
  u.role = 'inmobiliaria'; // explicitly NOT constructora — should be denied
  store.saveUser(u);

  const listing = makeListing(broker, { creator_user_id: owner.id });
  const r = await post(`/api/inventory/${listing.id}/units`,
    { label: 'A1' }, auth(owner.token));
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, 'not_owner');
});

// ── D6: secretary cannot APPROVE commission; owner can ──
test('D6: commission/review approve → secretary 403 requires_owner; owner 200', async () => {
  const owner     = await makeOwner('d6-owner');
  const broker    = await makeBroker('d6-b');
  attachBrokerToInm(broker.id, owner.id);
  const secretary = await makeSecretary('d6-sec', owner.id);

  const listing = makeListing(broker);
  const app = makeApplication(listing, broker, {
    status: 'pago_aprobado',
    inmobiliaria_id: owner.id,
    commission: {
      sale_amount: 100000, agent_percent: 3, agent_amount: 3000,
      inmobiliaria_amount: 1000, agent_net: 2000,
      status: 'submitted',
      submitted_by: broker.id,
      history: [],
    },
  });

  // Secretary → 403 requires_owner.
  const r1 = await put(`/api/applications/${app.id}/commission/review`,
    { action: 'approve' }, auth(secretary.token));
  assert.equal(r1.status, 403, JSON.stringify(r1.body));
  // Either requires_owner code from the explicit branch, or the generic
  // owner-gate above it. Both are correct outcomes for the secretary.
  assert.ok(r1.body.code === 'requires_owner' || /comisiones/i.test(r1.body.error || ''),
    'secretary blocked from approve');

  // Owner → 200.
  const r2 = await put(`/api/applications/${app.id}/commission/review`,
    { action: 'approve' }, auth(owner.token));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.commission.status, 'approved');
  assert.equal(r2.body.secretary_can_approve, false);
});

// ── D7: GET /profile includes companyDescription + coverImage ─────
test('D7: GET /api/inmobiliaria/profile includes companyDescription and coverImage', async () => {
  const owner = await makeOwner('d7-owner');
  // Seed the profile blob so both fields surface.
  const u = store.getUserById(owner.id);
  u.profile = {
    companyDescription: 'Constructora líder en RD',
    coverImage:         '/uploads/cover-d7.jpg',
    tagline:            'Construyendo hogares',
  };
  store.saveUser(u);

  const r = await get('/api/inmobiliaria/profile', auth(owner.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.companyDescription, 'Constructora líder en RD');
  assert.equal(r.body.coverImage, '/uploads/cover-d7.jpg');
  // The merged profile blob should also be exposed for clients that read it.
  assert.equal(r.body.profile?.tagline, 'Construyendo hogares');
});
