/**
 * Apple receipt JWS verification — unit tests for the helper, plus
 * route-level tests for /api/auth/apple-subscription that exercise the
 * "missing/invalid JWS" rejection paths.
 *
 * Run with:  node --test tests/apple-receipt.test.js
 *        or: npm test
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

// ── Test environment (must be set before requiring server) ─────────────────
process.env.JWT_SECRET    = process.env.JWT_SECRET    || 'test-secret';
process.env.ADMIN_KEY     = process.env.ADMIN_KEY     || 'test-admin-key';
process.env.NODE_ENV      = 'test';
process.env.DATABASE_URL  = '';
process.env.APPLE_BUNDLE_ID = 'com.josty.hogaresrd';

const { verifyAppleTransaction } = require('../routes/apple-receipts');
const app   = require('../server');
const store = require('../routes/store');

// ── Helpers: build a JWS we can verify against a self-signed cert ──────────
//
// Apple's real JWS is signed by Apple's signing key with their cert in
// x5c[0]. We can't reproduce that, but we CAN exercise the helper's
// happy path with a self-signed ES256 leaf cert whose subject contains
// "Apple". The route still rejects this in production-like code paths
// because the issuer string match is best-effort — but for the unit
// test of the verifier function it's the right shape.
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function jsonB64url(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

/**
 * Generate a self-signed ES256 (P-256) cert with the issuer/subject CN
 * containing "Apple" so the helper's issuer check passes. Returns
 * { certPem, keyObject, certDerB64 }.
 *
 * Built with `openssl` shelled out — no Node-pure way to generate X.509
 * in v22. Falls back to skipping the happy-path test if openssl isn't
 * available on the box.
 */
function generateAppleishCert() {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-receipt-test-'));
  const keyPath  = path.join(tmp, 'key.pem');
  const certPath = path.join(tmp, 'cert.pem');
  const subj = '/CN=Apple Worldwide Developer Relations Test/O=Apple Inc./C=US';

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec',
      '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes',
      '-subj', subj,
    ], { stdio: 'pipe' });
  } catch (e) {
    return null;  // openssl missing or failed — caller skips the test
  }

  const keyPem  = fs.readFileSync(keyPath,  'utf8');
  const certPem = fs.readFileSync(certPath, 'utf8');

  // Convert PEM cert to base64-DER for the JWS x5c entry.
  const certDerB64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const keyObject = crypto.createPrivateKey(keyPem);

  return { keyObject, certDerB64 };
}

function derEcdsaToJose(der) {
  // ASN.1 SEQUENCE { INTEGER r, INTEGER s }. Convert back to fixed
  // 32+32 raw concatenation expected by JOSE.
  if (der[0] !== 0x30) throw new Error('not a DER sequence');
  let off = 2;
  if (der[1] & 0x80) off = 2 + (der[1] & 0x7f);  // long-form length
  if (der[off] !== 0x02) throw new Error('expected INTEGER for r');
  const rLen = der[off + 1];
  let r = der.subarray(off + 2, off + 2 + rLen);
  off = off + 2 + rLen;
  if (der[off] !== 0x02) throw new Error('expected INTEGER for s');
  const sLen = der[off + 1];
  let s = der.subarray(off + 2, off + 2 + sLen);

  // Pad/truncate r and s to 32 bytes each.
  function pad(buf) {
    if (buf.length === 32) return buf;
    if (buf.length === 33 && buf[0] === 0) return buf.subarray(1);
    if (buf.length < 32) return Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
    throw new Error(`unexpected scalar length ${buf.length}`);
  }
  return Buffer.concat([pad(r), pad(s)]);
}

function buildSignedJws(payload, certDerB64, keyObject) {
  const header = { alg: 'ES256', x5c: [certDerB64] };
  const headerB64  = jsonB64url(header);
  const payloadB64 = jsonB64url(payload);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');

  const sigDer  = crypto.sign('sha256', signingInput, keyObject);
  const sigJose = derEcdsaToJose(sigDer);
  return `${headerB64}.${payloadB64}.${b64url(sigJose)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit tests for verifyAppleTransaction()
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyAppleTransaction — unit', () => {
  it('rejects a non-string argument', async () => {
    const r = await verifyAppleTransaction(null);
    assert.equal(r.valid, false);
  });

  it('rejects a string that is not three dot-separated segments', async () => {
    const r = await verifyAppleTransaction('not-a-jws');
    assert.equal(r.valid, false);
    assert.match(r.error, /JWS|3 segments/);
  });

  it('rejects when alg is not ES256', async () => {
    const header  = jsonB64url({ alg: 'HS256', x5c: ['xxx'] });
    const payload = jsonB64url({ bundleId: 'com.josty.hogaresrd' });
    const jws = `${header}.${payload}.${b64url(Buffer.from('sig'))}`;
    const r = await verifyAppleTransaction(jws);
    assert.equal(r.valid, false);
    assert.match(r.error, /alg/i);
  });

  it('rejects when x5c[0] is not a parseable certificate', async () => {
    const header  = jsonB64url({ alg: 'ES256', x5c: ['this-is-not-a-cert'] });
    const payload = jsonB64url({ bundleId: 'com.josty.hogaresrd' });
    // ES256 sigs are 64 bytes — pad with zeros so we reach the cert
    // check, not the sig-length check.
    const sig = b64url(Buffer.alloc(64));
    const r = await verifyAppleTransaction(`${header}.${payload}.${sig}`);
    assert.equal(r.valid, false);
    assert.match(r.error, /certificate|x5c/i);
  });

  // Happy-path test: build our own self-signed ES256 cert, sign a
  // payload with it, and watch the verifier accept the signature. This
  // exercises everything except Apple chain-of-trust validation (which
  // we explicitly defer — see routes/apple-receipts.js).
  it('accepts a self-signed JWS whose payload is valid (signature path)', async (t) => {
    const certInfo = generateAppleishCert();
    if (!certInfo) {
      t.skip('openssl not available — skipping happy-path test');
      return;
    }
    const future = Date.now() + 30 * 24 * 60 * 60 * 1000;  // +30 days
    const payload = {
      transactionId:         'tx_test_1',
      originalTransactionId: 'tx_test_1',
      productId:             'com.josty.hogaresrd.broker.monthly',
      bundleId:              'com.josty.hogaresrd',
      expiresDate:           future,
      environment:           'Sandbox',
    };
    const jws = buildSignedJws(payload, certInfo.certDerB64, certInfo.keyObject);
    const r = await verifyAppleTransaction(jws);
    assert.equal(r.valid, true, `expected valid, got ${JSON.stringify(r)}`);
    assert.equal(r.transaction.transactionId, 'tx_test_1');
    assert.equal(r.transaction.productId, 'com.josty.hogaresrd.broker.monthly');
    assert.equal(r.transaction.environment, 'Sandbox');
  });

  it('rejects expired transactions even when the signature verifies', async (t) => {
    const certInfo = generateAppleishCert();
    if (!certInfo) {
      t.skip('openssl not available — skipping expiry test');
      return;
    }
    const past = Date.now() - 1000;
    const payload = {
      transactionId: 'tx_expired',
      productId:     'com.josty.hogaresrd.broker.monthly',
      bundleId:      'com.josty.hogaresrd',
      expiresDate:   past,
    };
    const jws = buildSignedJws(payload, certInfo.certDerB64, certInfo.keyObject);
    const r = await verifyAppleTransaction(jws);
    assert.equal(r.valid, false);
    assert.match(r.error, /expir/i);
  });

  it('rejects unknown product IDs', async (t) => {
    const certInfo = generateAppleishCert();
    if (!certInfo) {
      t.skip('openssl not available — skipping product-id test');
      return;
    }
    const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const payload = {
      transactionId: 'tx_other',
      productId:     'com.someone-else.app.subscription',
      bundleId:      'com.josty.hogaresrd',
      expiresDate:   future,
    };
    const jws = buildSignedJws(payload, certInfo.certDerB64, certInfo.keyObject);
    const r = await verifyAppleTransaction(jws);
    assert.equal(r.valid, false);
    assert.match(r.error, /productId/);
  });

  // TODO: end-to-end "valid Apple-signed JWS" test. Would require a real
  // production receipt + Apple's public root CA chain — out of scope
  // until we wire the App Store Server API into integration tests.
});

// ═══════════════════════════════════════════════════════════════════════════
// Route tests for /api/auth/apple-subscription — JWS validation
// ═══════════════════════════════════════════════════════════════════════════

let server;
let BASE;

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
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text: raw });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}
const post = (p, b, h) => request(p, { method: 'POST', body: b, headers: h });

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
  setTimeout(() => process.exit(0), 1000).unref();
});

describe('POST /api/auth/apple-subscription — JWS validation', () => {
  async function makeUser(label) {
    const email = `apple_${label}_${Date.now()}_${Math.random().toString(36).slice(2,7)}@hogaresrd-test.com`;
    const pass  = 'TestPass1!';
    const reg = await post('/api/auth/register', {
      name: `Apple ${label}`, email, password: pass,
    });
    assert.equal(reg.status, 201, `register failed: ${reg.text}`);
    const login = await post('/api/auth/login', { email, password: pass });
    assert.equal(login.status, 200, `login failed: ${login.text}`);
    return login.body.token;
  }

  it('rejects a malformed signedTransactionInfo (not a JWS) with 400', async () => {
    const token = await makeUser('malformed');
    const res = await post('/api/auth/apple-subscription', {
      signedTransactionInfo: 'this-is-clearly-not-a-jws',
    }, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
    assert.ok(res.body && res.body.error, 'expected error message');
  });

  it('rejects a JWS with an invalid signature with 400', async () => {
    const certInfo = generateAppleishCert();
    if (!certInfo) {
      // Without openssl we can't build a signable JWS at all — but we
      // can still hit the path with a 3-segment string that fails for
      // a different reason. Skip cleanly.
      return;
    }
    const token = await makeUser('badsig');

    const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const payload = {
      transactionId: 'tx_badsig',
      productId:     'com.josty.hogaresrd.broker.monthly',
      bundleId:      'com.josty.hogaresrd',
      expiresDate:   future,
    };
    const valid = buildSignedJws(payload, certInfo.certDerB64, certInfo.keyObject);

    // Tamper with the payload so the signature no longer verifies.
    const [h, , s] = valid.split('.');
    const tamperedPayload = jsonB64url({ ...payload, productId: 'com.josty.hogaresrd.constructora.monthly' });
    const tampered = `${h}.${tamperedPayload}.${s}`;

    const res = await post('/api/auth/apple-subscription', {
      signedTransactionInfo: tampered,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
    assert.ok(res.body && /signature|verify/i.test(res.body.error || ''),
      `expected signature error, got: ${res.text}`);
  });

  // TODO: a full happy-path test through the route would need a JWS
  // signed by a cert chained to Apple's root CA — we don't have one in
  // unit tests. The unit test above covers the verifier helper itself.
});
