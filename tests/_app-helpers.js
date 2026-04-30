/**
 * Shared application/broker fixture helpers.
 *
 * Duplicated from tests/applications-workflow.test.js so multiple test
 * files can build broker + listing + application fixtures without
 * coordinating writes to the existing audit suite.
 *
 * Each helper hits the real public auth endpoints (so JWTs are valid)
 * and then mutates the user in-store to flip on the broker role +
 * subscription bits.
 *
 * Usage:
 *   const { request, post, get, put, auth, makeBroker, makeListing,
 *           makeApplication, startServer, stopServer } = require('./_app-helpers');
 *   before(async () => { ({ BASE } = await startServer()); });
 *   after(stopServer);
 */

const http   = require('node:http');
const { randomUUID } = require('node:crypto');

// IMPORTANT: env wiring runs before requiring server. Tests should
// `process.env.JWT_SECRET = ...` etc BEFORE requiring this helper, but
// we double-set as a safety net so we never get a real DB connection.
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-secret';
process.env.ADMIN_KEY    = process.env.ADMIN_KEY    || 'test-admin-key';
process.env.NODE_ENV     = process.env.NODE_ENV     || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || '';

const app   = require('../server');
const store = require('../routes/store');

// ── State (set during startServer) ────────────────────────────────
let server  = null;
let BASE    = null;

function getBase() { return BASE; }

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
    if (options.body) {
      bodyStr = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
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
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: raw });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const get  = (p, h)    => request(p, { method: 'GET',  headers: h });
const post = (p, b, h) => request(p, { method: 'POST', body: b, headers: h });
const put  = (p, b, h) => request(p, { method: 'PUT',  body: b, headers: h });
const del  = (p, h)    => request(p, { method: 'DELETE', headers: h });
const auth = (token)   => ({ Authorization: `Bearer ${token}` });

// ── Lifecycle ─────────────────────────────────────────────────────

async function startServer() {
  await new Promise((resolve, reject) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
  return { BASE, server };
}

async function stopServer() {
  if (server) await new Promise((r) => server.close(r));
  if (store.pool && typeof store.pool.end === 'function') {
    try { await store.pool.end(); } catch { /* already closed */ }
  }
  // Force-exit shortly after teardown so cron timers don't hang the runner.
  setTimeout(() => process.exit(0), 1000).unref();
}

// ── Fixture builders ──────────────────────────────────────────────

/**
 * Register + login a unique user, then promote them to broker + active sub.
 * Returns { id, email, token }.
 */
async function makeBroker(label) {
  const tag      = `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${label}`;
  const email    = `broker-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';

  const reg = await post('/api/auth/register', {
    name: `Broker ${label}`, email, password,
  });
  if (reg.status !== 201) {
    throw new Error(`makeBroker register failed: ${reg.status} ${reg.text}`);
  }

  // Promote BEFORE login — JWT bakes role into the token at sign time,
  // so we have to mutate the user before the login call so the issued
  // token says role='broker'. Endpoints that gate on BROKER_ROLES.includes
  // (req.user.role) — tours, conversations claim — would otherwise 403.
  const u = store.getUserByEmail(email);
  if (!u) throw new Error('makeBroker: user not in store after register');
  u.role               = 'broker';
  u.subscriptionStatus = 'active';
  store.saveUser(u);

  const lg = await post('/api/auth/login', { email, password });
  if (lg.status !== 200) {
    throw new Error(`makeBroker login failed: ${lg.status} ${lg.text}`);
  }
  const token = lg.body.token;
  if (!token) throw new Error('makeBroker: login returned no token');

  return { id: u.id, email, token };
}

/**
 * Register + login a normal tenant user (role 'user'). Returns
 * { id, email, name, token }. Used for conversations tests where the
 * client side needs a real JWT.
 */
async function makeTenant(label) {
  const tag      = `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${label}`;
  const email    = `tenant-${tag}@hogaresrd-test.com`;
  const password = 'TestPass1!';
  const name     = `Tenant ${label}`;

  const reg = await post('/api/auth/register', { name, email, password });
  if (reg.status !== 201) {
    throw new Error(`makeTenant register failed: ${reg.status} ${reg.text}`);
  }

  const lg = await post('/api/auth/login', { email, password });
  if (lg.status !== 200) {
    throw new Error(`makeTenant login failed: ${lg.status} ${lg.text}`);
  }
  const token = lg.body.token;
  if (!token) throw new Error('makeTenant: login returned no token');

  const u = store.getUserByEmail(email);
  return { id: u.id, email, name, token };
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

// ── In-memory shims for PG-backed methods ─────────────────────────
//
// `store.getMessages`, `store.getMessageCount`, `store.addMessage`,
// and `store.claimConversationAtomic` go straight to `pool.query`
// against PostgreSQL. With DATABASE_URL='' the queries hang on
// connection timeout (5s default) and tests that read the
// conversations endpoint stall for tens of seconds (or fail outright
// because messages never persist).
//
// We replace those methods with in-memory implementations backed by
// per-conversation message arrays. Call this AFTER requiring
// _app-helpers (so `store` is loaded) but BEFORE startServer().
//
// This is purely for test isolation — production code is unchanged.
function installInMemoryStoreShims() {
  const _msgsByConv = new Map(); // convId → [msg, msg, ...]

  store.addMessage = function (conversationId, msg) {
    if (!_msgsByConv.has(conversationId)) _msgsByConv.set(conversationId, []);
    _msgsByConv.get(conversationId).push({ ...msg });
    // Keep parity with the real impl: bump in-memory cache count too.
    const conv = store.getConversationById(conversationId);
    if (conv) {
      conv.message_count = (conv.message_count || 0) + 1;
      store.saveConversation(conv);
    }
  };

  store.addMessageAsync = async function (conversationId, msg) {
    return store.addMessage(conversationId, msg);
  };

  store.getMessages = async function (conversationId, { since, limit = 50 } = {}) {
    const all = _msgsByConv.get(conversationId) || [];
    let filtered = all;
    if (since) filtered = all.filter(m => m.timestamp > since);
    // Mimic "last N then ASC" semantics from the real impl
    return filtered.slice(-limit);
  };

  store.getMessageCount = async function (conversationId) {
    const all = _msgsByConv.get(conversationId) || [];
    return all.length;
  };

  store.claimConversationAtomic = async function (convId, brokerId, brokerName, now, systemMessage) {
    const conv = store.getConversationById(convId);
    if (!conv) return null;
    if (conv.brokerId) return null; // already claimed
    conv.brokerId   = brokerId;
    conv.brokerName = brokerName;
    conv.updatedAt  = now;
    store.saveConversation(conv);
    if (systemMessage) store.addMessage(convId, systemMessage);
    return conv;
  };
}

module.exports = {
  // HTTP
  request, get, post, put, del, auth,
  // lifecycle
  startServer, stopServer, getBase,
  // fixtures
  makeBroker, makeTenant, makeListing, makeApplication,
  // shims
  installInMemoryStoreShims,
  // raw access
  store, app,
};
