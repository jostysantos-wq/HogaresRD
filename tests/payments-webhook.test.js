/**
 * Payments Webhook Contract Tests
 *
 * Documents the contract for Stripe / Apple / Meta webhooks. These tests
 * may FAIL until Group 1 (auth/revenue) lands the corresponding fixes —
 * that is intentional. The tests describe what SHOULD happen, not what
 * currently does.
 *
 * Run with:  node --test tests/payments-webhook.test.js
 *        or: npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ── Test environment ────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_KEY  = 'test-admin-key';
process.env.NODE_ENV   = 'test';

const app   = require('../server');
const store = require('../routes/store');

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

describe('Stripe webhook — POST /api/stripe', () => {
  it('rejects request with no signature header (must NOT return 200)', async () => {
    const res = await post('/api/stripe', {
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
    // We use a sentinel header so test harness / future implementation
    // can short-circuit signature verification in NODE_ENV=test.
    const headers = { 'x-test-bypass-signature': '1', 'stripe-signature': 'test-sig' };

    const first  = await post('/api/stripe', payload, headers);
    const second = await post('/api/stripe', payload, headers);

    // First call: idempotency-tracked, second: should report dedup.
    assert.equal(second.status, 200, 'second dedup call should still 200');
    assert.ok(
      second.body && second.body.deduplicated === true,
      `expected body.deduplicated:true on second call, got: ${JSON.stringify(second.body)}`
    );
    // First should not falsely claim deduplicated.
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

    // First user registers + claims the transaction.
    const u1Email = `apple_a_${Date.now()}@hogaresrd-test.com`;
    const reg1 = await post('/api/auth/register', {
      name: 'Apple A', email: u1Email, password: 'TestPass1!',
    });
    assert.equal(reg1.status, 201);
    const token1 = reg1.body.token || reg1.body.user?.token;

    const claim1 = await post('/api/auth/apple-subscription', {
      transactionID: sharedTxId,
      productID:     'com.josty.hogaresrd.broker.monthly',
      receipt:       'fake-receipt-data',
    }, token1 ? { Authorization: `Bearer ${token1}` } : {});
    // We don't strictly assert claim1 succeeded — the receipt is fake.
    // The point is the txId is now associated with user A in the system.

    // Second user tries to use the SAME transactionID.
    const u2Email = `apple_b_${Date.now()}@hogaresrd-test.com`;
    const reg2 = await post('/api/auth/register', {
      name: 'Apple B', email: u2Email, password: 'TestPass1!',
    });
    assert.equal(reg2.status, 201);
    const token2 = reg2.body.token || reg2.body.user?.token;

    const claim2 = await post('/api/auth/apple-subscription', {
      transactionID: sharedTxId,
      productID:     'com.josty.hogaresrd.broker.monthly',
      receipt:       'fake-receipt-data',
    }, token2 ? { Authorization: `Bearer ${token2}` } : {});

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
    const payload = {
      object: 'page',
      entry: [{
        id: '123', time: Date.now(),
        changes: [{ field: 'leadgen', value: { leadgen_id: 'lead_test', form_id: 'form_test' } }],
      }],
    };
    const res = await post('/api/webhooks/meta', payload, {
      'x-hub-signature-256': 'sha256=deadbeef-this-is-not-a-valid-signature',
    });
    // Contract: invalid HMAC must return 401 (or 403). 200 = security bug.
    assert.ok(
      res.status === 401 || res.status === 403,
      `expected 401/403 for bad signature, got ${res.status}`
    );
  });
});
