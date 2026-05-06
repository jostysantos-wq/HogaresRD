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
 * Round-1 security audit fix M-3:
 *   - Full X.509 chain validation against Apple's pinned Root CA G3
 *     IS now performed. Each cert in x5c is verified against the next,
 *     and the topmost cert must chain to the embedded Apple Root.
 *   - The "issuer string-match" heuristic is gone — the chain itself
 *     is the proof now, not the human-readable issuer label.
 *
 * Still TODO:
 *   - Revocation (CRL/OCSP) is not checked. Apple does not publish
 *     CRLs for the StoreKit signing chain, so this is treated as
 *     acceptable for the StoreKit-2 use case.
 *
 *  Spec refs:
 *    - StoreKit 2 JWSTransaction:
 *      https://developer.apple.com/documentation/appstoreserverapi/jwstransaction
 *    - App Store Server API – signed payloads:
 *      https://developer.apple.com/documentation/appstoreserverapi/jws-format
 *    - Apple Root CA - G3 (PEM):
 *      https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 */

'use strict';

const crypto = require('crypto');

const EXPECTED_BUNDLE_ID = () =>
  process.env.APPLE_BUNDLE_ID || 'com.josty.hogaresrd';

const PRODUCT_ID_PREFIX = 'com.josty.hogaresrd.';

// Apple Root CA - G3, the trust anchor for StoreKit 2 / App Store
// Server signed payloads. Publicly distributed at
// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// SHA-256 fingerprint:
//   63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;
const APPLE_ROOT_CA_G3 = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM);
const APPLE_ROOT_FP    = APPLE_ROOT_CA_G3.fingerprint256;

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
 * Verify an x5c certificate chain terminates at our pinned Apple
 * Root CA G3. Each cert in the chain must be signed by the next, and
 * the highest cert must either *be* the pinned root or be signed by it.
 *
 * Validity-period checks are run on every cert (rejects expired or
 * not-yet-valid certs).
 *
 * @param {string[]} x5c  Base64-encoded DER certs, leaf first.
 * @returns {{ ok: true, leaf: crypto.X509Certificate } | { ok: false, error: string }}
 */
function verifyChain(x5c) {
  if (!Array.isArray(x5c) || x5c.length === 0) {
    return { ok: false, error: 'empty x5c chain' };
  }
  let chain;
  try {
    chain = x5c.map(b64 => new crypto.X509Certificate(Buffer.from(b64, 'base64')));
  } catch (e) {
    return { ok: false, error: `x5c parse error: ${e.message}` };
  }

  const now = Date.now();
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    const notBefore = Date.parse(c.validFrom);
    const notAfter  = Date.parse(c.validTo);
    if (Number.isFinite(notBefore) && notBefore > now) {
      return { ok: false, error: `chain[${i}] not yet valid` };
    }
    if (Number.isFinite(notAfter) && notAfter < now) {
      return { ok: false, error: `chain[${i}] expired` };
    }
  }

  // Verify each cert was signed by the next one in the chain.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) {
      return { ok: false, error: `chain[${i}] signature does not verify against chain[${i + 1}]` };
    }
  }

  // Top of chain must terminate at our pinned Apple Root.
  const top = chain[chain.length - 1];
  if (top.fingerprint256 === APPLE_ROOT_FP) {
    return { ok: true, leaf: chain[0] };
  }
  // Otherwise, the top cert must be directly signed by the pinned root.
  if (top.verify(APPLE_ROOT_CA_G3.publicKey)) {
    return { ok: true, leaf: chain[0] };
  }
  return { ok: false, error: 'chain does not terminate at pinned Apple Root CA G3' };
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

  // ── 2. Pinned chain validation (audit fix M-3) ──────────────────
  const chainResult = verifyChain(header.x5c);
  if (!chainResult.ok) {
    return { valid: false, error: `chain validation failed: ${chainResult.error}` };
  }
  const leafCert = chainResult.leaf;

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
