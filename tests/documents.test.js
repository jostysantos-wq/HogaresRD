/**
 * Document upload + review workflow coverage.
 *
 * Endpoint paths verified against routes/applications.js:
 *   POST /api/applications/:id/documents/request   ({documents:[{type,label,required}]})
 *   POST /api/applications/:id/documents/upload    (multer multipart — skipped, see below)
 *   PUT  /api/applications/:id/documents/:docId/review  ({status:'approved'|'rejected', note})
 *   POST /api/applications/:id/documents/skip      (already covered in workflow tests)
 *
 * Notes vs the brief:
 *   - The request body is `{ documents: [...] }` not `{ types: [...] }` — the
 *     route validates per-doc shape and rejects strings.
 *   - The review endpoint takes `status: 'approved'|'rejected'` + `note`,
 *     not `action` + `reason`. We test the actual contract.
 *   - Upload requires multer multipart; we skip the upload test rather
 *     than introducing a multipart helper (form-data isn't a direct dep
 *     and the brief said "don't import new npm packages").
 *   - documents/skip is intentionally NOT covered here — the workflow
 *     suite already pins skip-phase semantics.
 *
 * Run:  node --test tests/documents.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const {
  put, post, auth,
  startServer, stopServer,
  makeBroker, makeListing, makeApplication,
  store,
} = require('./_app-helpers');

before(startServer);
after(stopServer);

// ════════════════════════════════════════════════════════════════════
// 1 — Broker requests documents from a tenant
// ════════════════════════════════════════════════════════════════════

describe('Documents — POST /api/applications/:id/documents/request', () => {
  let broker, listing, appId;

  before(async () => {
    broker  = await makeBroker('docs-request');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;
    // Move out of `aplicado` so the route can transition to documentos_requeridos
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
  });

  it('broker requesting documents returns the updated documents_requested[]', async () => {
    const res = await post(`/api/applications/${appId}/documents/request`, {
      documents: [
        { type: 'cedula',       label: 'Cédula de identidad',     required: true },
        { type: 'income_proof', label: 'Comprobante de ingresos', required: true },
      ],
    }, auth(broker.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);
    assert.ok(Array.isArray(res.body.documents_requested),
      'response should include documents_requested array');
    assert.equal(res.body.documents_requested.length, 2);
    const types = res.body.documents_requested.map(d => d.type).sort();
    assert.deepEqual(types, ['cedula', 'income_proof']);
    // All requested docs land in 'pending' state
    for (const d of res.body.documents_requested) {
      assert.equal(d.status, 'pending');
    }
  });

  it('rejects an empty documents list (400)', async () => {
    const res = await post(`/api/applications/${appId}/documents/request`,
      { documents: [] },
      auth(broker.token));
    assert.equal(res.status, 400);
  });

  it('rejects when documents is missing entirely (400)', async () => {
    const res = await post(`/api/applications/${appId}/documents/request`,
      {},
      auth(broker.token));
    assert.equal(res.status, 400);
  });

  it('a different broker cannot request docs on another\'s app (403)', async () => {
    const intruder = await makeBroker('docs-request-intruder');
    const res = await post(`/api/applications/${appId}/documents/request`, {
      documents: [{ type: 'rnc', label: 'RNC', required: false }],
    }, auth(intruder.token));
    assert.equal(res.status, 403);
  });

  it('returns 401 without auth', async () => {
    const res = await post(`/api/applications/${appId}/documents/request`, {
      documents: [{ type: 'rnc', label: 'RNC' }],
    });
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 — Tenant uploads documents (SKIPPED — multipart helper needed)
// ════════════════════════════════════════════════════════════════════

describe('Documents — POST /api/applications/:id/documents/upload', () => {
  it.skip('tenant uploads a file — TODO(test-harness): need multipart helper (form-data is transitive, not a direct dep; skipping per brief)');
});

// ════════════════════════════════════════════════════════════════════
// 3 — Broker reviews an uploaded document (approve)
// ════════════════════════════════════════════════════════════════════
//
// Since we can't run the upload endpoint without multipart, we seed a
// `documents_uploaded` entry directly into the store. The review
// endpoint reads from `app.documents_uploaded` and looks up the doc by
// id, so this is sufficient to exercise the review path end-to-end.

describe('Documents — PUT /api/applications/:id/documents/:docId/review (approve)', () => {
  let broker, listing, appId, docId;

  before(async () => {
    broker  = await makeBroker('docs-approve');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;

    docId = randomUUID();
    const app = store.getApplicationById(appId);
    app.documents_uploaded.push({
      id:            docId,
      type:          'cedula',
      filename:      'fake-cedula.jpg',
      original_name: 'cedula.jpg',
      size:          12345,
      path:          '/dev/null',  // never read in approve path
      uploaded_at:   new Date().toISOString(),
      review_status: 'pending',
      review_note:   '',
      reviewed_at:   null,
      reviewed_by:   null,
      required:      true,
    });
    store.saveApplication(app);
  });

  it('approving sets review_status=approved (200)', async () => {
    const res = await put(`/api/applications/${appId}/documents/${docId}/review`,
      { status: 'approved' },
      auth(broker.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);

    const stored = store.getApplicationById(appId);
    const doc = stored.documents_uploaded.find(d => d.id === docId);
    assert.equal(doc.review_status, 'approved');
    assert.equal(doc.reviewed_by, broker.id);
    assert.ok(doc.reviewed_at, 'reviewed_at should be set');
  });

  it('rejects an invalid status value (400)', async () => {
    const res = await put(`/api/applications/${appId}/documents/${docId}/review`,
      { status: 'maybe' },
      auth(broker.token));
    assert.equal(res.status, 400);
  });

  it('returns 404 for a non-existent doc id', async () => {
    const res = await put(`/api/applications/${appId}/documents/doc_does_not_exist/review`,
      { status: 'approved' },
      auth(broker.token));
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4 — Broker reviews an uploaded document (reject) → app moves to
//     documentos_insuficientes when the rejected doc was required.
// ════════════════════════════════════════════════════════════════════

describe('Documents — PUT /api/applications/:id/documents/:docId/review (reject)', () => {
  let broker, listing, appId, docId;

  before(async () => {
    broker  = await makeBroker('docs-reject');
    listing = makeListing(broker);
    appId   = makeApplication(listing, broker).id;

    // Walk to documentos_enviados so STATUS_FLOW allows transition into
    // documentos_insuficientes on a required-doc reject.
    await put(`/api/applications/${appId}/status`,
      { status: 'en_revision' }, auth(broker.token));
    await put(`/api/applications/${appId}/status`,
      { status: 'documentos_requeridos' }, auth(broker.token));

    docId = randomUUID();
    const app = store.getApplicationById(appId);
    // Add a matching pending request so the reject path can flip it
    // back to 'pending' (which exercises the request-resync branch).
    const requestId = randomUUID();
    app.documents_requested.push({
      id:           requestId,
      type:         'income_proof',
      label:        'Comprobante de ingresos',
      required:     true,
      requested_at: new Date().toISOString(),
      status:       'uploaded',
    });
    app.documents_uploaded.push({
      id:            docId,
      request_id:    requestId,
      type:          'income_proof',
      filename:      'fake-income.pdf',
      original_name: 'income.pdf',
      size:          54321,
      path:          '/dev/null',
      uploaded_at:   new Date().toISOString(),
      review_status: 'pending',
      review_note:   '',
      reviewed_at:   null,
      reviewed_by:   null,
      required:      true,
    });
    // Move to documentos_enviados manually so the STATUS_FLOW→insufficient
    // transition is allowed during the reject. (`STATUS_FLOW.documentos_enviados`
    // includes 'documentos_insuficientes' per applications.js.)
    app.status = 'documentos_enviados';
    store.saveApplication(app);
  });

  it('rejecting with note=illegible flips status to documentos_insuficientes (200)', async () => {
    const res = await put(`/api/applications/${appId}/documents/${docId}/review`,
      { status: 'rejected', note: 'illegible' },
      auth(broker.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);

    const stored = store.getApplicationById(appId);
    const doc = stored.documents_uploaded.find(d => d.id === docId);
    assert.equal(doc.review_status, 'rejected');
    assert.equal(doc.review_note, 'illegible');
    // Required-doc reject transitions the app to documentos_insuficientes
    assert.equal(stored.status, 'documentos_insuficientes',
      'rejecting a required doc should move the app to documentos_insuficientes');
    // The matching request should be re-opened to pending so the client
    // can re-upload against it.
    const reqEntry = stored.documents_requested.find(r => r.id === doc.request_id);
    assert.equal(reqEntry.status, 'pending', 'request should be reset to pending after reject');
  });
});

// ════════════════════════════════════════════════════════════════════
// 5 — documents/skip (NOT duplicated)
// ════════════════════════════════════════════════════════════════════
//
// The skip endpoint is exhaustively covered in
// tests/applications-workflow.test.js (Scenario 5 — Skip-phase). We
// intentionally don't duplicate that coverage here.
