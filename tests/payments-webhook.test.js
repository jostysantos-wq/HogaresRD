/**
 * Payments Webhook Contract Tests
 *
 * Documents the contract for Stripe / Apple / Meta webhooks. Three
 * tests in this file used to be `.skip`'d because we lacked a way to
 * sign requests in-process; the tests/_helpers.js module added by the
 * ops worktree fills that gap, so they're un-skipped now.
 *
 * Run with:  node --test tests/payments-webhook.test.js
 *        or: npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ── Test environment ────────────────────────────────────────────────────────
process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';
// The Stripe webhook needs both a webhook signing secret AND a
// secret-key (so the `stripe` client gets constructed at module load).
// Without the secret-key the route returns 503 before signature checks.
process.env.STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY     || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';
// The Meta-webhook signature test needs the secret set so the route
// runs the signature path (instead of returning 503 for missing config).
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'test-meta-secret';

const app   = require('../server');
const store = require('../routes/store');
const {
  signStripeEvent,
  signMetaPayload,
  postRaw,
} = require('./_helpers');

let server;
let BASE;

// ── Helper: HTTP request (mirrors api.test.js) ─────────────────────────────
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

    let bodyStr;
    if (options.body !== undefined) {
      bodyStr = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
      opts.headers['Content-Type']   = opts.headers['Content-Type']   || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: raw });
      });
    });

    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function post(path, body, headers) {
  return request(path, { method: 'POST', body, headers });
}

// ── Bring up server ────────────────────────────────────────────────────────
before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      BASE = `http://127.0.0.1:${port}`;
      console.log(`  Payments-webhook test server listening on port ${port}`);
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (store.pool && typeof store.pool.end === 'function') {
    try { await store.pool.end(); } catch { /* already closed */ }
  }
  setTimeout(() => process.exit(0), 1000).unref();
});

// ═══════════════════════════════════════════════════════════════════════════
// Stripe webhook
// ═══════════════════════════════════════════════════════════════════════════

describe('Stripe webhook — POST /api/stripe/webhook', () => {
  it('rejects request with no signature header (must NOT return 200)', async () => {
    const res = await post('/api/stripe/webhook', {
      id:   'evt_test_unsigned',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_unsigned' } },
    });
    // Contract: signature missing → 400 (bad request) or 503 (refusing to
    // process unsigned webhooks). Anything 2xx is a security bug.
    assert.notEqual(res.status, 200, 'unsigned webhook must not be accepted');
    assert.ok(
      res.status === 400 || res.status === 401 || res.status === 503,
      `expected 400/401/503, got ${res.status}`
    );
  });

  it('deduplicates a repeated event.id (second call returns deduplicated:true)', async () => {
    const eventId = `evt_dedupe_${Date.now()}`;
    const payload = {
      id:   eventId,
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_dedupe', customer: 'cus_test', subscription: 'sub_test' } },
    };
    const body   = JSON.stringify(payload);
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    // Two requests with the SAME signature/timestamp/body. Stripe's
    // constructEvent allows up to 5 minutes of clock skew so a single
    // signature is reusable across the two calls.
    const sig = signStripeEvent(body, secret);
    const headers = { 'stripe-signature': sig, 'Content-Type': 'application/json' };

    const first  = await postRaw('/api/stripe/webhook', body, headers, BASE);
    const second = await postRaw('/api/stripe/webhook', body, headers, BASE);

    assert.equal(first.status, 200,
      `first call should 200, got ${first.status}: ${first.text}`);
    assert.equal(second.status, 200, 'second dedup call should still 200');
    assert.ok(
      second.body && second.body.deduplicated === true,
      `expected body.deduplicated:true on second call, got: ${JSON.stringify(second.body)}`
    );
    assert.ok(
      !(first.body && first.body.deduplicated === true),
      'first call must not be flagged as deduplicated'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Apple subscription webhook
// ═══════════════════════════════════════════════════════════════════════════

describe('Apple subscription — POST /api/auth/apple-subscription', () => {
  it('rejects already-used transactionID claimed by a different user', async () => {
    const sharedTxId = `apple_tx_${Date.now()}`;

    // ── User A: register + login + claim transaction ─────────────
    const u1Email = `apple_a_${Date.now()}@hogaresrd-test.com`;
    const u1Pass  = 'TestPass1!';
    const reg1 = await post('/api/auth/register', {
      name: 'Apple A', email: u1Email, password: u1Pass,
    });
    assert.equal(reg1.status, 201, `user A register failed: ${reg1.text}`);

    const login1 = await post('/api/auth/login', { email: u1Email, password: u1Pass });
    assert.equal(login1.status, 200, `user A login failed: ${login1.text}`);
    const token1 = login1.body.token;
    assert.ok(token1, 'expected JWT token from login');

    const claim1 = await post('/api/auth/apple-subscription', {
      transactionID: sharedTxId,
      productID:     'com.josty.hogaresrd.broker.monthly',
      role:          'broker',
    }, { Authorization: `Bearer ${token1}` });
    // The claim should succeed (or at least not fail with 409). The
    // transactionID is now associated with user A.
    assert.ok(
      claim1.status < 500,
      `user A claim unexpectedly 5xx'd: ${claim1.status} ${claim1.text}`
    );

    // ── User B: register + login + try the SAME transaction ──────
    const u2Email = `apple_b_${Date.now()}@hogaresrd-test.com`;
    const u2Pass  = 'TestPass1!';
    const reg2 = await post('/api/auth/register', {
      name: 'Apple B', email: u2Email, password: u2Pass,
    });
    assert.equal(reg2.status, 201, `user B register failed: ${reg2.text}`);

    const login2 = await post('/api/auth/login', { email: u2Email, password: u2Pass });
    assert.equal(login2.status, 200, `user B login failed: ${login2.text}`);
    const token2 = login2.body.token;

    const claim2 = await post('/api/auth/apple-subscription', {
      transactionID: sharedTxId,
      productID:     'com.josty.hogaresrd.broker.monthly',
      role:          'broker',
    }, { Authorization: `Bearer ${token2}` });

    // Contract: cross-user reuse must be rejected with 409 or 400.
    assert.ok(
      claim2.status === 409 || claim2.status === 400,
      `expected 409/400 for reused transactionID, got ${claim2.status}: ${JSON.stringify(claim2.body)}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Meta (Facebook Lead Ads) webhook
// ═══════════════════════════════════════════════════════════════════════════

describe('Meta webhook — POST /api/webhooks/meta', () => {
  it('rejects request with a wrong x-hub-signature-256', async () => {
    const sentPayload = {
      object: 'page',
      entry: [{
        id: '123', time: Date.now(),
        changes: [{ field: 'leadgen', value: { leadgen_id: 'lead_test', form_id: 'form_test' } }],
      }],
    };
    // Sign a DIFFERENT payload than what we send, so the HMAC the route
    // computes over the actual body bytes will not match the header.
    const decoyPayload = { object: 'page', entry: [{ id: 'decoy', time: 0, changes: [] }] };
    const wrongSig = signMetaPayload(decoyPayload, process.env.META_APP_SECRET);

    const sentBody = JSON.stringify(sentPayload);
    // NOTE: send as octet-stream so the globally-mounted express.json()
    // doesn't consume the body before the route's express.raw() captures
    // it. Meta itself sends application/json, but the global parser ahead
    // of the route is a separate (known) wiring issue not in scope here.
    const res = await postRaw('/api/webhooks/meta', sentBody, {
      'x-hub-signature-256': wrongSig,
      'Content-Type':        'application/octet-stream',
    }, BASE);

    // Contract: invalid HMAC must return 401 (or 403). 200 = security bug.
    assert.ok(
      res.status === 401 || res.status === 403,
      `expected 401/403 for bad signature, got ${res.status}: ${res.text}`
    );
  });
});
