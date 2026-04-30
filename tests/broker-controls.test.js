/**
 * Group 3 — Broker control surface (C1, C4, C7) tests.
 *
 * Covers:
 *   C1 — `is_internal: true` events are scrubbed from the GET /:id
 *        response when the requester is a pure client.
 *   C4 — POST /:id/reassign happy path, non-team broker rejection,
 *        non-broker caller rejection, timeline event recorded, and
 *        both brokers are emailed (assert via _setTransporter).
 *   C7 — POST /bulk reject of 3 apps, mixed permissions (one not
 *        visible) returns partial success, ids that don't exist
 *        return 'not_found'.
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const helpers = require('./_app-helpers');
const {
  post, get, auth,
  startServer, stopServer,
  makeBroker, makeListing, makeApplication, makeTenant,
  store,
} = helpers;

const appsRouter = require('../routes/applications');
const { _setTransporter } = appsRouter.__test;

// In-memory mailer stub. Each .sendMail() call is captured so tests
// can assert who got notified.
function makeFakeTransport() {
  const sent = [];
  const t = {
    sendMail: (msg) => {
      sent.push(msg);
      return Promise.resolve({ ok: true });
    },
    sent,
  };
  return t;
}

before(async () => {
  await startServer();
});

after(stopServer);

// ───────────────────────────────────────────────────────────────────
// C1 — is_internal flag filtering
// ───────────────────────────────────────────────────────────────────

describe('C1 — is_internal events filtered for clients', () => {
  it('client GET /:id never sees is_internal === true events', async () => {
    const broker = await makeBroker('c1-broker');
    const listing = makeListing(broker);
    const app = makeApplication(listing, broker);

    // Attach a real client tenant + verified email so isClient resolves.
    const tenant = await makeTenant('c1-tenant');
    app.client.user_id = tenant.id;
    app.client.email   = tenant.email;
    store.saveApplication(app);

    // Broker posts a public message.
    let r = await post(`/api/applications/${app.id}/message`,
      { message: 'Mensaje al cliente' }, auth(broker.token));
    assert.equal(r.status, 200, `public message: ${r.status} ${r.text}`);

    // Broker posts an internal note (is_internal flag).
    r = await post(`/api/applications/${app.id}/message`,
      { message: 'Nota interna del equipo', is_internal: true }, auth(broker.token));
    assert.equal(r.status, 200, `internal message: ${r.status} ${r.text}`);

    // Broker fetches: should see both.
    let view = await get(`/api/applications/${app.id}`, auth(broker.token));
    assert.equal(view.status, 200);
    const brokerEvents = (view.body.timeline_events || []).filter(e => e.type === 'message');
    assert.equal(brokerEvents.length, 2, 'broker sees both messages');
    assert.ok(brokerEvents.some(e => e.is_internal === true),
      'broker sees the internal flag');

    // Tenant fetches: should see only the public one.
    view = await get(`/api/applications/${app.id}`, auth(tenant.token));
    assert.equal(view.status, 200);
    const clientEvents = (view.body.timeline_events || []).filter(e => e.type === 'message');
    assert.equal(clientEvents.length, 1, 'client sees only the public message');
    assert.equal(clientEvents[0].description, 'Mensaje al cliente');
    assert.ok(!clientEvents.some(e => e.is_internal === true),
      'client never sees internal flag');
  });

  it('rejects internal flag from a non-broker (client cannot self-tag internal)', async () => {
    const broker = await makeBroker('c1-broker2');
    const listing = makeListing(broker);
    const app = makeApplication(listing, broker);

    const tenant = await makeTenant('c1-tenant2');
    app.client.user_id = tenant.id;
    app.client.email   = tenant.email;
    store.saveApplication(app);

    // Tenant tries to send an "internal" message — server should coerce
    // to public (is_internal becomes false because they're not broker/admin).
    const r = await post(`/api/applications/${app.id}/message`,
      { message: 'Cliente intenta nota interna', is_internal: true }, auth(tenant.token));
    assert.equal(r.status, 200);

    // Broker view: this message must NOT be flagged internal.
    const view = await get(`/api/applications/${app.id}`, auth(broker.token));
    assert.equal(view.status, 200);
    const evt = (view.body.timeline_events || []).find(e =>
      e.type === 'message' && e.description === 'Cliente intenta nota interna');
    assert.ok(evt, 'event exists');
    assert.notEqual(evt.is_internal, true, 'client cannot self-tag internal');
  });
});

// ───────────────────────────────────────────────────────────────────
// C4 — Reassign endpoint
// ───────────────────────────────────────────────────────────────────

describe('C4 — POST /:id/reassign', () => {
  it('happy path: same-team reassign records event + emails both brokers', async () => {
    const fake = makeFakeTransport();
    _setTransporter(fake);

    // Set up an inmobiliaria team with two brokers on it.
    const teamId = randomUUID();
    const brokerA = await makeBroker('c4a');
    const brokerB = await makeBroker('c4b');
    const ua = store.getUserById(brokerA.id);
    ua.inmobiliaria_id = teamId;
    store.saveUser(ua);
    const ub = store.getUserById(brokerB.id);
    ub.inmobiliaria_id = teamId;
    store.saveUser(ub);

    const listing = makeListing(brokerA);
    const app = makeApplication(listing, brokerA, { inmobiliaria_id: teamId });

    const r = await post(`/api/applications/${app.id}/reassign`,
      { newBrokerUserId: brokerB.id, reason: 'broker A vacaciones' },
      auth(brokerA.token));
    assert.equal(r.status, 200, `reassign: ${r.status} ${r.text}`);
    assert.equal(r.body.broker.user_id, brokerB.id);

    // Timeline event recorded
    const stored = store.getApplicationById(app.id);
    const ev = (stored.timeline_events || []).find(e => e.type === 'broker_reassigned');
    assert.ok(ev, 'broker_reassigned event recorded');
    assert.equal(ev.data.from, brokerA.id);
    assert.equal(ev.data.to,   brokerB.id);
    assert.equal(ev.data.reason, 'broker A vacaciones');

    // Both brokers emailed (sendNotification → fake.sendMail)
    const recipients = fake.sent.map(m => m.to);
    assert.ok(recipients.includes(brokerA.email),
      `old broker emailed (got: ${recipients.join(', ')})`);
    assert.ok(recipients.includes(brokerB.email),
      `new broker emailed (got: ${recipients.join(', ')})`);
  });

  it('rejects when the new broker is not on the same team', async () => {
    const teamA = randomUUID();
    const teamB = randomUUID();
    const brokerA = await makeBroker('c4-team-a');
    const brokerB = await makeBroker('c4-team-b');
    const ua = store.getUserById(brokerA.id);
    ua.inmobiliaria_id = teamA;
    store.saveUser(ua);
    const ub = store.getUserById(brokerB.id);
    ub.inmobiliaria_id = teamB; // different team
    store.saveUser(ub);

    const listing = makeListing(brokerA);
    const app = makeApplication(listing, brokerA, { inmobiliaria_id: teamA });

    const r = await post(`/api/applications/${app.id}/reassign`,
      { newBrokerUserId: brokerB.id, reason: 'should fail' },
      auth(brokerA.token));
    assert.equal(r.status, 400, `expected 400, got ${r.status} ${r.text}`);
  });

  it('rejects when caller is neither broker, inmobiliaria, nor admin', async () => {
    const broker = await makeBroker('c4-owner');
    const stranger = await makeBroker('c4-stranger');
    // Detach stranger from any team and remove broker role to simulate non-authorized caller
    const us = store.getUserById(stranger.id);
    us.role = 'user';
    store.saveUser(us);

    const listing = makeListing(broker);
    const app = makeApplication(listing, broker);

    const r = await post(`/api/applications/${app.id}/reassign`,
      { newBrokerUserId: broker.id, reason: 'nope' },
      auth(stranger.token));
    assert.equal(r.status, 403, `expected 403, got ${r.status} ${r.text}`);
  });
});

// ───────────────────────────────────────────────────────────────────
// C7 — Bulk operations
// ───────────────────────────────────────────────────────────────────

describe('C7 — POST /bulk', () => {
  it('rejects 3 apps in one call', async () => {
    const broker = await makeBroker('c7-rej');
    const listing = makeListing(broker);
    const a = makeApplication(listing, broker);
    const b = makeApplication(listing, broker);
    const c = makeApplication(listing, broker);

    const r = await post('/api/applications/bulk',
      { ids: [a.id, b.id, c.id], action: 'reject', reason: 'cliente desistió de comprar' },
      auth(broker.token));
    assert.equal(r.status, 200, `bulk: ${r.status} ${r.text}`);
    const okIds = r.body.results.filter(x => x.ok).map(x => x.id);
    assert.equal(okIds.length, 3, 'all three rejected');

    for (const id of [a.id, b.id, c.id]) {
      const stored = store.getApplicationById(id);
      assert.equal(stored.status, 'rechazado');
      const ev = (stored.timeline_events || []).find(e =>
        e.type === 'status_change' && e.data?.bulk === true);
      assert.ok(ev, `bulk status_change event recorded for ${id}`);
    }
  });

  it('partial success when one id is not visible to caller', async () => {
    const brokerA = await makeBroker('c7-partial-a');
    const brokerB = await makeBroker('c7-partial-b');
    const listingA = makeListing(brokerA);
    const listingB = makeListing(brokerB);

    const myApp1 = makeApplication(listingA, brokerA);
    const myApp2 = makeApplication(listingA, brokerA);
    const otherApp = makeApplication(listingB, brokerB); // owned by B, not A

    const r = await post('/api/applications/bulk',
      { ids: [myApp1.id, otherApp.id, myApp2.id], action: 'archive' },
      auth(brokerA.token));
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.results.map(x => [x.id, x]));
    assert.equal(byId[myApp1.id].ok,   true);
    assert.equal(byId[myApp2.id].ok,   true);
    assert.equal(byId[otherApp.id].ok, false);
    assert.equal(byId[otherApp.id].code, 'forbidden');

    // Confirm A's two apps got archived; B's was untouched.
    assert.equal(store.getApplicationById(myApp1.id).archived, true);
    assert.equal(store.getApplicationById(myApp2.id).archived, true);
    assert.notEqual(store.getApplicationById(otherApp.id).archived, true);
  });

  it("ids that don't exist return per-id 'not_found'", async () => {
    const broker = await makeBroker('c7-missing');
    const listing = makeListing(broker);
    const real = makeApplication(listing, broker);
    const ghost1 = randomUUID();
    const ghost2 = randomUUID();

    const r = await post('/api/applications/bulk',
      { ids: [real.id, ghost1, ghost2], action: 'mark_stale' },
      auth(broker.token));
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.results.map(x => [x.id, x]));
    assert.equal(byId[real.id].ok,   true);
    assert.equal(byId[ghost1].ok,    false);
    assert.equal(byId[ghost1].code,  'not_found');
    assert.equal(byId[ghost2].code,  'not_found');

    // Real app got the flag.
    assert.equal(store.getApplicationById(real.id).stale, true);
  });
});
