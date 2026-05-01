/**
 * Conversation creation, messaging, and claim coverage.
 *
 * Endpoint paths verified against routes/conversations.js:
 *   POST /api/conversations              — client starts a conversation
 *   GET  /api/conversations/:id          — read messages
 *   POST /api/conversations/:id/messages — append a message
 *   POST /api/conversations/:id/claim    — pro user claims an unclaimed conv
 *
 * Notes vs the brief:
 *   - The brief said `POST /api/applications/:id/message` with `{ text }`.
 *     The actual API is the route file's `POST /api/conversations` with
 *     `{ propertyId, message, propertyTitle }`. We test the real shape.
 *   - The brief said second claim returns 409. The route returns 400
 *     ('Esta conversacion ya fue reclamada por otro agente.'). We pin
 *     400 — switching to 409 is a contract change.
 *   - A non-participant gets 403 when fetching a conversation, except
 *     for unclaimed org conversations on a listing they own.
 *
 * Run:  node --test tests/conversations.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  get, post, auth,
  startServer, stopServer,
  makeBroker, makeTenant, makeListing,
  installInMemoryStoreShims,
  store,
} = require('./_app-helpers');

// Replace `store.getMessages`/`getMessageCount`/`addMessage`/
// `claimConversationAtomic` with in-memory equivalents — without
// these, GET /api/conversations/:id stalls 5s on pool.connect()
// against the (empty) DATABASE_URL and the claim test never returns.
installInMemoryStoreShims();

before(startServer);
after(stopServer);

// Helper: turn the test broker into an inmobiliaria-owned broker so
// the org-claim path engages. The conversation route's claim handler
// requires either an inmobiliariaId match or an unscoped (null) conv.
async function makeOrgBroker(label, inmobiliariaId) {
  const broker = await makeBroker(label);
  const u = store.getUserById(broker.id);
  u.inmobiliaria_id = inmobiliariaId;
  store.saveUser(u);
  return broker;
}

// ════════════════════════════════════════════════════════════════════
// 1 — Tenant starts a conversation; subsequent messages append
// ════════════════════════════════════════════════════════════════════

describe('Conversations — POST /api/conversations + /messages', () => {
  let owner, tenant, listing, convId;

  before(async () => {
    owner   = await makeBroker('conv-owner');
    listing = makeListing(owner);
    tenant  = await makeTenant('conv-sender');
  });

  it('tenant starts a conversation and gets back a conversation id (201)', async () => {
    const res = await post('/api/conversations', {
      propertyId:    listing.id,
      propertyTitle: listing.title,
      message:       'Hi, is this still available?',
    }, auth(tenant.token));

    assert.equal(res.status, 201, `expected 201, got ${res.status} ${res.text}`);
    // Two response shapes coexist (cascade vs direct path):
    //   { id: conv.id, created: true }     ← cascade-on, line 185
    //   { conversation: conv }              ← direct, line 216
    // Test accepts either so a flag flip doesn't break this suite.
    convId = res.body.conversation?.id || res.body.id;
    assert.ok(convId, `response should include conversation id, got: ${JSON.stringify(res.body)}`);
    assert.ok(convId.startsWith('conv_'), 'conversation id should be prefixed conv_');
    if (res.body.conversation) {
      assert.equal(res.body.conversation.clientId, tenant.id);
      assert.equal(res.body.conversation.propertyId, listing.id);
    }
  });

  it('subsequent message via /:id/messages appends a second message (200)', async () => {
    const res = await post(`/api/conversations/${convId}/messages`,
      { text: 'Following up — when can we tour?' },
      auth(tenant.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);
    assert.ok(res.body.message, 'response should include the saved message');
    assert.equal(res.body.message.senderId, tenant.id);
  });

  it('GET /api/conversations/:id returns both messages', async () => {
    const res = await get(`/api/conversations/${convId}`, auth(tenant.token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
    assert.equal(res.body.messages.length, 2,
      `expected 2 messages, got ${res.body.messages.length}`);
    // Tenant is the client — both messages should be theirs
    for (const m of res.body.messages) {
      assert.equal(m.senderId, tenant.id);
    }
  });

  it('rejects an empty message body (400)', async () => {
    const res = await post(`/api/conversations/${convId}/messages`,
      { text: '   ' },
      auth(tenant.token));
    assert.equal(res.status, 400);
  });

  it('GET on a non-existent conversation returns 404', async () => {
    const res = await get('/api/conversations/conv_does_not_exist', auth(tenant.token));
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 — Claim race: first pro wins; second pro gets 400.
// ════════════════════════════════════════════════════════════════════

describe('Conversations — POST /api/conversations/:id/claim', () => {
  let inm, brokerA, brokerB, tenant, listing, convId;

  before(async () => {
    // Create an inmobiliaria owner first; their id seeds the
    // inmobiliaria_id we attach to brokerA + brokerB.
    inm = await makeBroker('conv-inm-owner');
    const inmUser = store.getUserById(inm.id);
    inmUser.role = 'inmobiliaria';
    store.saveUser(inmUser);

    brokerA = await makeOrgBroker('conv-brokerA', inm.id);
    brokerB = await makeOrgBroker('conv-brokerB', inm.id);

    // Listing owned by the inmobiliaria so unclaimed convs land in it
    listing = makeListing(inm, { creator_user_id: inm.id });
    tenant  = await makeTenant('conv-claimer-tenant');

    // Tenant starts conv — listing's creator is an inmobiliaria, so
    // POST /api/conversations sets inmobiliariaId=inm.id, brokerId=null.
    const r = await post('/api/conversations', {
      propertyId:    listing.id,
      propertyTitle: listing.title,
      message:       'Interested in this listing.',
    }, auth(tenant.token));
    assert.equal(r.status, 201, `setup conv failed: ${r.text}`);
    // Two response shapes coexist (see suite #1 for context).
    convId = r.body.conversation?.id || r.body.id;
    assert.ok(convId, `setup: missing conversation id in ${JSON.stringify(r.body)}`);

    // Sanity-check: should be unclaimed and tied to the inmobiliaria.
    const conv = store.getConversationById(convId);
    assert.equal(conv.brokerId, null, 'setup: brokerId should be null');
    assert.equal(conv.inmobiliariaId, inm.id, 'setup: inmobiliariaId should be set');
  });

  it('Broker A claims the unclaimed conversation (200)', async () => {
    const res = await post(`/api/conversations/${convId}/claim`,
      {},
      auth(brokerA.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);
    assert.ok(res.body.ok || res.body.conversation,
      'response should be ok or include conversation');

    const conv = store.getConversationById(convId);
    assert.equal(conv.brokerId, brokerA.id, 'brokerId should be set to broker A');
  });

  it('Broker B cannot claim the same conversation — 400', async () => {
    const res = await post(`/api/conversations/${convId}/claim`,
      {},
      auth(brokerB.token));
    // The route uses 400 (not 409) for "already claimed" — pin that contract.
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.text}`);
    assert.match(res.body?.error || '', /reclamad/i);
  });

  it('returns 401 without auth', async () => {
    const res = await post(`/api/conversations/${convId}/claim`, {});
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3 — Non-participant cannot read conversation messages.
// ════════════════════════════════════════════════════════════════════

describe('Conversations — non-participant access guard', () => {
  let owner, tenant, outsider, listing, convId;

  before(async () => {
    owner   = await makeBroker('conv-acc-owner');
    listing = makeListing(owner);

    // Pre-assign brokerId by setting refToken on owner so the new conv
    // is owned by `owner` (refToken path → brokerId set). Easier: just
    // mutate the conv after creation.
    tenant   = await makeTenant('conv-acc-tenant');
    outsider = await makeTenant('conv-acc-outsider');

    const r = await post('/api/conversations', {
      propertyId:    listing.id,
      propertyTitle: listing.title,
      message:       'Hi there',
    }, auth(tenant.token));
    assert.equal(r.status, 201, `setup conv failed: ${r.text}`);
    // Two response shapes coexist (see suite #1 for context).
    convId = r.body.conversation?.id || r.body.id;
    assert.ok(convId, `setup: missing conversation id in ${JSON.stringify(r.body)}`);

    // Pin the conv to `owner` so the outsider really is a third party
    // (no broker-claim path open for them).
    const conv = store.getConversationById(convId);
    conv.brokerId       = owner.id;
    conv.brokerName     = 'Test Broker';
    conv.inmobiliariaId = null;
    store.saveConversation(conv);
  });

  it('the assigned broker can read the conversation (200)', async () => {
    const res = await get(`/api/conversations/${convId}`, auth(owner.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, convId);
  });

  it('the originating tenant can read the conversation (200)', async () => {
    const res = await get(`/api/conversations/${convId}`, auth(tenant.token));
    assert.equal(res.status, 200);
  });

  it('a different user (not client, not assigned broker) gets 403', async () => {
    const res = await get(`/api/conversations/${convId}`, auth(outsider.token));
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${res.text}`);
  });

  it('non-participant cannot post a message either (403)', async () => {
    const res = await post(`/api/conversations/${convId}/messages`,
      { text: 'I should not be able to send this' },
      auth(outsider.token));
    assert.equal(res.status, 403);
  });
});
