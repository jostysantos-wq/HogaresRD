/**
 * Apple App Store Server JWS receipt verifier.
 *
 * Verifies an Apple StoreKit 2 `signedTransactionInfo` JWS in-process
 * with Node built-ins only (no `jsonwebtoken` / `jose` dep). Returns a
 * normalized transaction object for the route layer to act on.
 *
 *   const { verifyAppleTransaction } = require('./apple-receipts');
 *   const r = await verifyAppleTransaction(jws);
 *   if (!r.valid) return res.status(400).json({ error: r.error });
 *   // r.transaction.{transactionId, originalTransactionId, productId,
 *   //                bundleId, expiresDate, environment}
 *
 * Caveats / TODO:
 *   - Full X.509 chain validation against Apple's root CA
 *     (AppleRootCA-G3.cer) is NOT performed. We verify the JWS signature
 *     against the leaf cert and best-effort string-match the leaf's
 *     issuer for "Apple". A determined attacker who can mint a cert with
 *     an "Apple"-looking subject could in principle slip past us.
 *   - Revocation (CRL/OCSP) is not checked.
 *
 *  Spec refs:
 *    - StoreKit 2 JWSTransaction:
 *      https://developer.apple.com/documentation/appstoreserverapi/jwstransaction
 *    - App Store Server API – signed payloads:
 *      https://developer.apple.com/documentation/appstoreserverapi/jws-format
 */

'use strict';

const crypto = require('crypto');

const EXPECTED_BUNDLE_ID = () =>
  process.env.APPLE_BUNDLE_ID || 'com.josty.hogaresrd';

const PRODUCT_ID_PREFIX = 'com.josty.hogaresrd.';

// ── base64url helpers (Node 16+ supports 'base64url' encoding natively) ──
function base64UrlDecodeToBuffer(str) {
  if (typeof str !== 'string' || !str.length) {
    throw new Error('base64url segment is empty');
  }
  // Node's Buffer accepts 'base64url' directly.
  return Buffer.from(str, 'base64url');
}

function base64UrlDecodeToJson(str) {
  const buf = base64UrlDecodeToBuffer(str);
  return JSON.parse(buf.toString('utf8'));
}

/**
 * Convert a JOSE-style ES256 signature (raw r||s, 64 bytes) to a DER
 * ECDSA signature, which is what Node's crypto.verify() expects when
 * given an EC public key. (No `dsaEncoding` option on createVerify in
 * older Nodes — using crypto.verify with the option is safer.)
 */
function joseToDer(joseSig) {
  if (joseSig.length !== 64) {
    throw new Error(`ES256 JOSE signature must be 64 bytes, got ${joseSig.length}`);
  }
  const r = joseSig.subarray(0, 32);
  const s = joseSig.subarray(32, 64);

  // Strip leading zero bytes; ASN.1 INTEGER must not have unnecessary
  // leading zeros, but if the high bit of the first byte is set we have
  // to prepend a 0x00 to keep the value positive.
  function trimAndPad(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let trimmed = buf.subarray(i);
    if (trimmed[0] & 0x80) {
      trimmed = Buffer.concat([Buffer.from([0]), trimmed]);
    }
    return trimmed;
  }

  const rDer = trimAndPad(r);
  const sDer = trimAndPad(s);

  const rTlv = Buffer.concat([Buffer.from([0x02, rDer.length]), rDer]);
  const sTlv = Buffer.concat([Buffer.from([0x02, sDer.length]), sDer]);
  const seqBody = Buffer.concat([rTlv, sTlv]);
  return Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
}

/**
 * Verify an Apple StoreKit 2 signedTransactionInfo JWS.
 *
 * @param {string} signedTransactionJWS  JWS in compact form: header.payload.signature
 * @returns {Promise<{valid: true, transaction: object} | {valid: false, error: string}>}
 */
async function verifyAppleTransaction(signedTransactionJWS) {
  if (typeof signedTransactionJWS !== 'string' || !signedTransactionJWS.length) {
    return { valid: false, error: 'signedTransactionInfo missing or not a string' };
  }

  const parts = signedTransactionJWS.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'signedTransactionInfo is not a JWS (expected 3 segments)' };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // ── 1. Decode header ────────────────────────────────────────────
  let header;
  try {
    header = base64UrlDecodeToJson(headerB64);
  } catch (e) {
    return { valid: false, error: 'JWS header is not valid base64url JSON' };
  }
  if (header.alg !== 'ES256') {
    return { valid: false, error: `Unsupported JWS alg: ${header.alg}` };
  }
  if (!Array.isArray(header.x5c) || header.x5c.length === 0) {
    return { valid: false, error: 'JWS header missing x5c certificate chain' };
  }

  // ── 2. Build leaf cert public key + best-effort issuer check ────
  let leafCert;
  try {
    leafCert = new crypto.X509Certificate(Buffer.from(header.x5c[0], 'base64'));
  } catch (e) {
    return { valid: false, error: `JWS x5c[0] is not a valid X.509 certificate: ${e.message}` };
  }

  const issuer = String(leafCert.issuer || '');
  if (!/Apple/i.test(issuer)) {
    return { valid: false, error: `Leaf certificate issuer does not look like Apple: ${issuer}` };
  }

  const publicKey = leafCert.publicKey;
  if (!publicKey) {
    return { valid: false, error: 'Leaf certificate has no public key' };
  }

  // ── 3. Verify signature over `header.payload` ───────────────────
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  let sigJose;
  try {
    sigJose = base64UrlDecodeToBuffer(sigB64);
  } catch (e) {
    return { valid: false, error: 'JWS signature is not valid base64url' };
  }
  let sigDer;
  try {
    sigDer = joseToDer(sigJose);
  } catch (e) {
    return { valid: false, error: `JWS signature has wrong length: ${e.message}` };
  }

  let signatureOk;
  try {
    signatureOk = crypto.verify('sha256', signingInput, publicKey, sigDer);
  } catch (e) {
    return { valid: false, error: `Signature verification threw: ${e.message}` };
  }
  if (!signatureOk) {
    return { valid: false, error: 'JWS signature does not verify against leaf certificate' };
  }

  // ── 4. Decode payload + claim checks ────────────────────────────
  let payload;
  try {
    payload = base64UrlDecodeToJson(payloadB64);
  } catch (e) {
    return { valid: false, error: 'JWS payload is not valid base64url JSON' };
  }

  const expectedBundle = EXPECTED_BUNDLE_ID();
  if (payload.bundleId !== expectedBundle) {
    return {
      valid: false,
      error: `bundleId mismatch: got ${payload.bundleId}, expected ${expectedBundle}`,
    };
  }

  const expiresDate = Number(payload.expiresDate);
  if (!Number.isFinite(expiresDate) || expiresDate <= Date.now()) {
    return { valid: false, error: 'Transaction has no future expiresDate' };
  }

  if (typeof payload.productId !== 'string'
      || !payload.productId.startsWith(PRODUCT_ID_PREFIX)) {
    return {
      valid: false,
      error: `productId not recognized: ${payload.productId}`,
    };
  }

  return {
    valid: true,
    transaction: {
      transactionId:         String(payload.transactionId || ''),
      originalTransactionId: String(payload.originalTransactionId || ''),
      productId:             payload.productId,
      bundleId:              payload.bundleId,
      expiresDate,                             // ms-since-epoch number
      environment:           payload.environment || null,  // 'Sandbox' | 'Production'
    },
  };
}

module.exports = { verifyAppleTransaction };
