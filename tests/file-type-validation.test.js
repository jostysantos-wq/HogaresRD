/**
 * Wave 9-D regression test — file-type@16 import.
 *
 * Background: routes/applications.js used to destructure
 * `{ fileTypeFromFile }` from `require('file-type')`, but file-type@16
 * exports `fromFile` (camelCase) — `fileTypeFromFile` is the v17+ name
 * and resolves to `undefined` against v16. The result was that
 * `_validateMimeImpl` threw on every call in production, silently
 * rejecting EVERY upload. Tests stub the indirection via
 * `__test._setValidateMime` so the breakage was invisible to CI.
 *
 * This file calls the REAL `_validateMimeImpl` (no stub layer) against
 * temp files with hand-crafted magic-byte headers to prove the import
 * fix works end-to-end.
 *
 * Run:  node --test tests/file-type-validation.test.js
 *  or:  npm test
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { randomUUID } = require('node:crypto');

const appsRouter = require('../routes/applications');
const { _validateMimeImpl } = appsRouter.__test;

// ── Temp-file helpers ────────────────────────────────────────────────
let TMP;
const created = [];

function writeTmp(name, bytes) {
  const p = path.join(TMP, `${randomUUID()}_${name}`);
  fs.writeFileSync(p, bytes);
  created.push(p);
  return p;
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wave9d-mime-'));
});

after(() => {
  // Best-effort cleanup. Some files are deleted by validateMime() on
  // the reject path; that's fine — we just nuke the dir.
  for (const p of created) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(TMP); } catch { /* ignore */ }
});

describe('Wave 9-D — _validateMimeImpl uses file-type@16 fromFile()', () => {
  it('accepts a known-good JPEG buffer and returns true for image/jpeg', async () => {
    // Minimal JPEG: SOI + APP0 (JFIF) + SOF0 + EOI. file-type sniffs the
    // first few bytes (FF D8 FF) plus the JFIF marker to identify as JPEG.
    const jpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xD9,
    ]);
    const p = writeTmp('good.jpg', jpeg);
    const ok = await _validateMimeImpl(p, 'image/jpeg');
    assert.equal(ok, true, 'expected JPEG buffer to validate as image/jpeg');
  });

  it('accepts a known-good PDF header and returns true for application/pdf', async () => {
    // Minimal PDF: %PDF-1.4 + EOF marker. file-type recognizes the
    // %PDF- prefix as application/pdf regardless of body.
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('1 0 obj <<>> endobj\n'),
      Buffer.from('%%EOF\n'),
    ]);
    const p = writeTmp('good.pdf', pdf);
    const ok = await _validateMimeImpl(p, 'application/pdf');
    assert.equal(ok, true, 'expected PDF header to validate as application/pdf');
  });

  it('rejects a plain-text file with a .jpg extension', async () => {
    // file-type returns undefined for plain text, which the impl treats
    // as "not allowed" → returns false AND deletes the file.
    const txt = Buffer.from('this is just text, not a real image\n');
    const p = writeTmp('lying.jpg', txt);
    const ok = await _validateMimeImpl(p);
    assert.equal(ok, false, 'expected plain text masquerading as JPG to be rejected');
    // The reject path async-deletes the file; give it a tick and confirm.
    await new Promise(r => setTimeout(r, 20));
    assert.equal(fs.existsSync(p), false, 'expected validateMime to delete the bogus file');
  });

  it('rejects a JPEG when the expectedMime says PDF (mime mismatch)', async () => {
    const jpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xD9,
    ]);
    const p = writeTmp('confusing.jpg', jpeg);
    const ok = await _validateMimeImpl(p, 'application/pdf');
    assert.equal(ok, false, 'expected mime-mismatch to be rejected');
  });
});
