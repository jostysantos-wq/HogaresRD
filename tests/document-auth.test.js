/**
 * E5: GET /api/applications/:id/documents/:docId/file must reject
 * `?token=` query auth and require either the JWT cookie or an
 * `Authorization: Bearer …` header.
 *
 * Run:  node --test tests/document-auth.test.js
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  request, get, auth,
  startServer, stopServer,
  makeBroker, makeListing, makeApplication,
  store,
} = require('./_app-helpers');

let broker, listing, app, doc, docPath;

before(async () => {
  await startServer();
  broker  = await makeBroker('docauth');
  listing = makeListing(broker);
  app     = makeApplication(listing, broker, {
    client: { name: 'C', phone: '+18095559999', email: 'c@x.com', user_id: null },
  });

  // Create a fake document file on disk + attach it to the app.
  const dir = path.join(__dirname, '..', 'data', 'documents');
  fs.mkdirSync(dir, { recursive: true });
  docPath = path.join(dir, `test-${Date.now()}.txt`);
  fs.writeFileSync(docPath, 'hello docauth');

  doc = {
    id: 'doc-test-1',
    type: 'other',
    label: 'Test Document',
    original_name: 'test.txt',
    path: docPath,
    mime_type: 'text/plain',
    size: 13,
    status: 'uploaded',
    uploaded_at: new Date().toISOString(),
  };
  app.documents_uploaded = [doc];
  store.saveApplication(app);
});

after(() => {
  try { fs.unlinkSync(docPath); } catch {}
  return stopServer();
});

describe('E5 document download header-auth only', () => {
  it('rejects ?token= query auth with 401', async () => {
    const url = `/api/applications/${app.id}/documents/${doc.id}/file?token=${encodeURIComponent(broker.token)}`;
    const r = await get(url);
    assert.equal(r.status, 401, 'query token must NOT authenticate this endpoint');
  });

  it('returns 200 with Authorization: Bearer header', async () => {
    const r = await get(
      `/api/applications/${app.id}/documents/${doc.id}/file`,
      auth(broker.token),
    );
    assert.equal(r.status, 200, r.text);
    // The body is the file contents — content-disposition makes Express
    // stream it through.
    assert.match(r.text, /hello docauth/);
  });

  it('returns 401 with no auth at all', async () => {
    const r = await get(`/api/applications/${app.id}/documents/${doc.id}/file`);
    assert.equal(r.status, 401);
  });
});
