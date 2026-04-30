/**
 * Shared test helpers — webhook signing + raw HTTP posting.
 *
 * The webhooks (Stripe, Meta) verify HMAC signatures over the raw
 * request body bytes, so the existing JSON-stringifying `post()` helper
 * doesn't work — we need to send the exact bytes we signed. These
 * helpers cover that gap so the payments-webhook tests can run.
 */

const crypto = require('node:crypto');
const http   = require('node:http');

/**
 * Build a Stripe webhook signature header per
 * https://stripe.com/docs/webhooks#verify-manually
 *
 *   t=<unix-ts>,v1=<HMAC_SHA256(secret, ts + '.' + body)>
 *
 * @param {string|Buffer} payload  Raw request body (the exact bytes that
 *                                 will be sent on the wire — usually the
 *                                 JSON-stringified event).
 * @param {string}        secret   The webhook signing secret.
 * @param {number=}       timestamp Override timestamp (seconds since epoch).
 *                                  Defaults to now. Useful for replay tests.
 * @returns {string} The value to put in the `Stripe-Signature` header.
 */
function signStripeEvent(payload, secret, timestamp) {
  const ts   = timestamp ?? Math.floor(Date.now() / 1000);
  const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  const sig  = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${body}`)
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

/**
 * Compute the X-Hub-Signature-256 header for Meta/Facebook webhooks.
 *
 *   sha256=<HMAC_SHA256(secret, JSON.stringify(payload))>
 *
 * @param {object|string|Buffer} payload  Either the parsed object (which
 *                                        will be JSON.stringify'd) or the
 *                                        raw bytes that were sent.
 * @param {string}               secret
 * @returns {string} The header value, including the `sha256=` prefix.
 */
function signMetaPayload(payload, secret) {
  const body = (typeof payload === 'string' || Buffer.isBuffer(payload))
    ? payload
    : JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * POST a raw body verbatim — bypasses JSON.stringify so the bytes the
 * server sees match the bytes we signed. Mirrors the shape of the
 * `post()` helper used in the test files (returns
 * { status, headers, body, text }).
 *
 * @param {string} pathname
 * @param {string|Buffer} body  Sent verbatim.
 * @param {object} headers
 * @param {string} BASE         Base URL (e.g. `http://127.0.0.1:12345`).
 */
function postRaw(pathname, body, headers, BASE) {
  return new Promise((resolve, reject) => {
    const url  = new URL(pathname, BASE);
    const buf  = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const opts = {
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        ...headers,
        'Content-Length': buf.length,
      },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: raw });
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

module.exports = { signStripeEvent, signMetaPayload, postRaw };
