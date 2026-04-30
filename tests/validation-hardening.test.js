/**
 * Validation hardening — narrow regression tests for the small fixes
 * landed alongside the validation pass on routes/applications.js:
 *
 *   1. Currency whitelist on payment uploads (DOP / USD only).
 *   2. Length caps on free-text tour fields (notes, location).
 *   3. Calendar-day age check on POST /api/applications (replaces the
 *      hand-rolled 365.25 divisor that broke around leap years and TZ).
 *   4. Document auto-status: required-doc reject must flip the app
 *      to documentos_insuficientes; optional-doc reject must NOT.
 *
 * Notes:
 *   - We send the payment-upload as a hand-rolled multipart body (no
 *     external form-data dep). Just enough to drive multer.
 *   - Tour POST/PUT use plain JSON, so the length-cap check is direct.
 *   - The age check goes through the real public POST so we exercise
 *     the same parsing the front door does.
 *   - Document auto-status is verified by seeding the store and
 *     hitting the review endpoint — the same pattern documents.test.js
 *     uses (multer multipart for /upload is intentionally avoided per
 *     the existing test harness convention).
 *
 * Run:  node --test tests/validation-hardening.test.js
 *  or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const {
  post, put, auth,
  startServer, stopServer, getBase,
  makeBroker, makeListing, makeApplication,
  store,
} = require('./_app-helpers');

// Stub out the magic-byte MIME sniff: file-type's CJS export shape
// makes `fileTypeFromFile` come back undefined in this Node version,
// which causes every real upload to 400 with "Tipo de archivo no
// permitido". That's a separate (out-of-scope) bug. For currency
// validation tests we just need to drive past the MIME gate, so we
// install a passthrough stub via the route's __test hook.
const appsRouter = require('../routes/applications');

before(async () => {
  await startServer();
  appsRouter.__test._setValidateMime(async () => true);
});
after(async () => {
  appsRouter.__test._setValidateMime(null); // restore real impl
  await stopServer();
});

// ── Multipart helper ──────────────────────────────────────────────
// Build a multipart/form-data body using only Node built-ins so we
// can drive multer without pulling form-data as a dep. Each `field`
// is { name, value, filename?, contentType? }; if filename is set
// we treat it as a file part.
function multipart(fields) {
  const boundary = '----HogaresRDTestBoundary' + randomUUID().replace(/-/g, '');
  const chunks = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(String(f.value), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// Placeholder file bytes — content is irrelevant because tests stub
// the MIME validator. We just need SOMETHING for multer to write.
const FAKE_FILE_BYTES = Buffer.from('placeholder', 'utf8');

async function uploadPayment(appId, token, fields = {}) {
  const BASE = getBase();
  const partFields = [
    { name: 'receipt', value: FAKE_FILE_BYTES, filename: 'r.jpg', contentType: 'image/jpeg' },
  ];
  for (const [k, v] of Object.entries(fields)) {
    partFields.push({ name: k, value: String(v) });
  }
  const { body, contentType } = multipart(partFields);
  const res = await fetch(`${BASE}/api/applications/${appId}/payment/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    },
    body,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

// ════════════════════════════════════════════════════════════════════
// 1 — Currency whitelist on payment upload
// ════════════════════════════════════════════════════════════════════
//
// Stripped-down: only the validation gate. We move the application
// to `pendiente_pago` so the upload is permitted by STATUS_FLOW.

describe('Validation — payment upload currency whitelist', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('val-currency');
    listing = makeListing(broker, { currency: 'USD' });
    appId   = makeApplication(listing, broker, {
      // Allow client uploads — the broker is also acting as client here
      // to keep the fixture small (the route accepts broker uploads).
      status: 'pendiente_pago',
    }).id;
  });

  it('rejects an arbitrary currency string with 400', async () => {
    const res = await uploadPayment(appId, broker.token, {
      amount: '1500',
      currency: 'BTC',
    });
    assert.equal(res.status, 400, `expected 400 got ${res.status} ${res.text}`);
    assert.match(res.body?.error || '', /Moneda inv/);
  });

  it('accepts DOP (uppercased + trimmed)', async () => {
    // Reset state — last test may have left a half-written record.
    const a = store.getApplicationById(appId);
    a.payment = null;
    a.status  = 'pendiente_pago';
    store.saveApplication(a);

    const res = await uploadPayment(appId, broker.token, {
      amount: '1500',
      currency: ' dop ',
    });
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);
    const stored = store.getApplicationById(appId);
    assert.equal(stored.payment?.currency, 'DOP');
  });

  it('falls back to listing currency when missing', async () => {
    // Reset to allow a fresh upload (verification_status: 'pending'
    // blocks consecutive uploads).
    const a = store.getApplicationById(appId);
    a.payment = null;
    a.status  = 'pendiente_pago';
    store.saveApplication(a);

    const res = await uploadPayment(appId, broker.token, {
      amount: '2000',
      // currency intentionally omitted
    });
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);
    const stored = store.getApplicationById(appId);
    assert.equal(stored.payment?.currency, 'USD',
      'should fall back to listing.currency when client did not send one');
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 — Tour notes / location length caps
// ════════════════════════════════════════════════════════════════════

describe('Validation — tour notes/location length caps', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('val-tour-cap');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
  });

  it('POST /tours: notes > 500 chars is truncated to 500', async () => {
    const futureDate = new Date(Date.now() + 7 * 86400 * 1000)
      .toISOString().slice(0, 10);
    const longNotes = 'x'.repeat(600);
    const longLoc   = 'L'.repeat(700);
    const res = await post(`/api/applications/${appId}/tours`, {
      scheduled_date: futureDate,
      scheduled_time: '10:00',
      notes:    longNotes,
      location: longLoc,
    }, auth(broker.token));
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);
    const stored = store.getApplicationById(appId);
    const tour = stored.tours[stored.tours.length - 1];
    assert.equal(tour.notes.length,    500, 'notes should be capped at 500 chars');
    assert.equal(tour.location.length, 500, 'location should be capped at 500 chars');
  });

  it('PUT /tours/:tourId: notes > 500 chars is truncated', async () => {
    const stored = store.getApplicationById(appId);
    const tourId = stored.tours[stored.tours.length - 1].id;
    const longNotes = 'y'.repeat(900);
    const res = await put(`/api/applications/${appId}/tours/${tourId}`, {
      notes: longNotes,
    }, auth(broker.token));
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);
    const after = store.getApplicationById(appId);
    const tour = after.tours.find(t => t.id === tourId);
    assert.equal(tour.notes.length, 500, 'PUT notes should be capped at 500 chars');
  });
});

// ════════════════════════════════════════════════════════════════════
// 3 — Age check (calendar-day diff replaces 365.25 math)
// ════════════════════════════════════════════════════════════════════
//
// Today is 2026-04-30 (per the harness time anchor). A DOB of
// 2008-04-29 makes the applicant exactly 18-and-1-day → must pass.
// A DOB of 2008-05-01 makes them ONE day shy → must fail.

describe('Validation — age check on POST /api/applications', () => {
  // The public endpoint is rate-limited to 5/hour per IP. Two tests
  // here, well within the budget.
  let listing;
  before(async () => {
    const broker = await makeBroker('val-age');
    listing = makeListing(broker);
  });

  function buildBody(dob) {
    return {
      listing_id:        listing.id,
      name:              'Cliente de Prueba',
      phone:             '+18095551111',
      email:             `dob-${Math.floor(Math.random()*1e9)}@hogaresrd-test.com`,
      intent:            'comprar',
      timeline:          'Inmediato',
      contact_method:    'whatsapp',
      budget:            '150000',
      id_type:           'cedula',
      id_number:         '00112345678',
      date_of_birth:     dob,
      current_address:   'Calle Falsa 123, Santo Domingo',
      employment_status: 'employed',
      employer_name:     'Test Co',
      job_title:         'Engineer',
      monthly_income:    '50000',
      financing:         'banco',
      income_currency:   'DOP',
      // Step 3 expects either attached_document_types or deferred_documents
      // for the two "core" docs. We pick deferred so the test stays
      // body-only (no multipart upload required).
      deferred_documents: [
        { type: 'cedula',       label: 'Cédula' },
        { type: 'income_proof', label: 'Comprobante de Ingresos' },
      ],
    };
  }

  it('passes when applicant is 18-and-1-day old', async () => {
    // Today is 2026-04-30 per CLAUDE.md harness; subject's 18th
    // birthday was 2026-04-29. Pick the day before today's calendar.
    const today = new Date();
    const eighteenYearsAgoMinusOne = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate() - 1);
    const dob = eighteenYearsAgoMinusOne.toISOString().slice(0, 10);

    const res = await post('/api/applications', buildBody(dob));
    assert.notEqual(res.status, 400, `expected 200/201, got 400 ${res.text}`);
    // Either 200 or 201 are valid success returns.
    assert.ok(res.status >= 200 && res.status < 300,
      `expected 2xx, got ${res.status} ${res.text}`);
  });

  it('fails when applicant is 17-and-364-days old', async () => {
    // 18 years ago + 1 day → not yet 18.
    const today = new Date();
    const eighteenYearsAgoPlusOne = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate() + 1);
    const dob = eighteenYearsAgoPlusOne.toISOString().slice(0, 10);

    const res = await post('/api/applications', buildBody(dob));
    assert.equal(res.status, 400, `expected 400 got ${res.status} ${res.text}`);
    assert.match(res.body?.error || '', /mayor de edad/);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4 — Document auto-status: required reject → documentos_insuficientes
// ════════════════════════════════════════════════════════════════════
//
// We seed both a documents_requested entry (with required:true) and
// a matching documents_uploaded record, then drive the review
// endpoint. The fix means the auto-status now joins back to
// documents_requested by request_id (or type) when required is not
// stamped on the uploaded record itself.

describe('Validation — document review auto-status fix', () => {
  let broker, listing;
  before(async () => {
    broker  = await makeBroker('val-doc-status');
    listing = makeListing(broker);
  });

  it('required-doc reject flips status to documentos_insuficientes', async () => {
    const appId = makeApplication(listing, broker).id;
    // Walk to documentos_enviados so STATUS_FLOW allows transition.
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'documentos_requeridos' }, auth(broker.token));

    const requestId = randomUUID();
    const docId     = randomUUID();
    const a = store.getApplicationById(appId);
    a.documents_requested.push({
      id:           requestId,
      type:         'cedula',
      label:        'Cédula',
      required:     true,
      requested_at: new Date().toISOString(),
      status:       'uploaded',
    });
    a.documents_uploaded.push({
      // Note: deliberately do NOT stamp `required` on the uploaded
      // record. This mirrors legacy data — the join via
      // request_id is what we're verifying.
      id:            docId,
      request_id:    requestId,
      type:          'cedula',
      filename:      'fake.jpg',
      original_name: 'cedula.jpg',
      size:          1234,
      path:          '/dev/null',
      uploaded_at:   new Date().toISOString(),
      review_status: 'pending',
      review_note:   '',
      reviewed_at:   null,
      reviewed_by:   null,
    });
    a.status = 'documentos_enviados';
    store.saveApplication(a);

    const res = await put(`/api/applications/${appId}/documents/${docId}/review`,
      { status: 'rejected', note: 'borrosa' },
      auth(broker.token));
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);

    const stored = store.getApplicationById(appId);
    assert.equal(stored.status, 'documentos_insuficientes',
      'rejecting a REQUIRED doc should flip status (auto)');
  });

  it('optional-doc reject does NOT flip status', async () => {
    const appId = makeApplication(listing, broker).id;
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'documentos_requeridos' }, auth(broker.token));

    const requestId = randomUUID();
    const docId     = randomUUID();
    const a = store.getApplicationById(appId);
    a.documents_requested.push({
      id:           requestId,
      type:         'other',
      label:        'Documento extra (opcional)',
      required:     false,
      requested_at: new Date().toISOString(),
      status:       'uploaded',
    });
    a.documents_uploaded.push({
      id:            docId,
      request_id:    requestId,
      type:          'other',
      filename:      'opt.jpg',
      original_name: 'extra.jpg',
      size:          1234,
      path:          '/dev/null',
      uploaded_at:   new Date().toISOString(),
      review_status: 'pending',
      review_note:   '',
      reviewed_at:   null,
      reviewed_by:   null,
    });
    a.status = 'documentos_enviados';
    store.saveApplication(a);

    const res = await put(`/api/applications/${appId}/documents/${docId}/review`,
      { status: 'rejected', note: 'no la necesitamos' },
      auth(broker.token));
    assert.equal(res.status, 200, `expected 200 got ${res.status} ${res.text}`);

    const stored = store.getApplicationById(appId);
    assert.notEqual(stored.status, 'documentos_insuficientes',
      'rejecting an OPTIONAL doc should NOT auto-flip status');
  });
});
