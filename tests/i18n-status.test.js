/**
 * E7: status labels live in public/locales/<lang>.json. statusEmail()
 * picks up the user's preferred language and resolves the right
 * translation. We unit-test the helpers directly instead of going
 * through HTTP — the email-rendering surface is pure and the
 * tokenVersion / auth machinery is irrelevant here.
 *
 * Run:  node --test tests/i18n-status.test.js
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// applications.js doesn't export statusEmail directly, so we shell
// the locale lookup through a freshly-loaded module + the test
// helpers fixture builders. We grab `appStatusLabel` and
// `userLangFor` indirectly: the public surface is via /api/applications
// status changes, which trigger statusEmail. Here we just sanity-check
// that the locale files have parity and the right labels.

describe('E7 application status labels', () => {
  const ES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/es.json'), 'utf8'));
  const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales/en.json'), 'utf8'));

  it('both locales define application_status', () => {
    assert.ok(ES.application_status, 'es.json missing application_status');
    assert.ok(EN.application_status, 'en.json missing application_status');
  });

  it('every status key exists in both languages', () => {
    const esKeys = Object.keys(ES.application_status).sort();
    const enKeys = Object.keys(EN.application_status).sort();
    assert.deepEqual(esKeys, enKeys, 'es and en keys must match');
    // Spot-check known canonical statuses.
    for (const k of [
      'aplicado', 'en_revision', 'documentos_requeridos',
      'documentos_enviados', 'documentos_insuficientes',
      'en_aprobacion', 'reservado', 'aprobado',
      'pendiente_pago', 'pago_enviado', 'pago_aprobado',
      'completado', 'rechazado',
    ]) {
      assert.ok(ES.application_status[k], `es missing key ${k}`);
      assert.ok(EN.application_status[k], `en missing key ${k}`);
    }
  });

  it('Spanish labels include accents (Aplicación, Revisión, …)', () => {
    assert.equal(ES.application_status.en_revision, 'En Revisión');
    assert.equal(ES.application_status.documentos_requeridos, 'Documentos Requeridos');
    assert.equal(ES.application_status.aprobado, 'Aprobado');
  });

  it('English labels are translated, not Spanish', () => {
    assert.equal(EN.application_status.aplicado, 'Applied');
    assert.equal(EN.application_status.en_revision, 'In Review');
    assert.equal(EN.application_status.completado, 'Completed');
    assert.equal(EN.application_status.rechazado, 'Rejected');
  });
});

describe('E7 statusEmail picks user language', () => {
  // applications.js exposes statusEmail / appStatusLabel through the
  // __test hatch so we can drive them with synthetic app objects
  // without spinning up HTTP for every assertion.
  // We require store/applications DIRECTLY (not through
  // _app-helpers) — that helper transitively requires server.js,
  // which starts cron timers that prevent process exit.
  const store   = require('../routes/store');
  const apps    = require('../routes/applications');
  const { statusEmail, appStatusLabel } = apps.__test;

  after(() => {
    // applications.js holds a reference to the pg pool through store.
    if (store.pool && typeof store.pool.end === 'function') {
      try { store.pool.end(); } catch {}
    }
    setTimeout(() => process.exit(0), 200).unref();
  });

  function makeAppWithUser(lang) {
    const uid = 'u_' + lang + '_' + Math.random().toString(36).slice(2, 8);
    store.saveUser({
      id: uid, email: uid + '@x.com', name: 'L', role: 'user',
      tokenVersion: 0, lang,
    });
    return {
      id: 'app_' + uid,
      listing_title: 'Casa Test',
      client: { user_id: uid, name: 'L', email: uid + '@x.com' },
    };
  }

  it('appStatusLabel resolves the right label per language', () => {
    assert.equal(appStatusLabel('aprobado', 'en'), 'Approved');
    assert.equal(appStatusLabel('aprobado', 'es'), 'Aprobado');
    assert.equal(appStatusLabel('en_revision', 'en'), 'In Review');
    assert.equal(appStatusLabel('en_revision', 'es'), 'En Revisión');
  });

  it('statusEmail uses English copy + label for user.lang=en', () => {
    const app = makeAppWithUser('en');
    const out = statusEmail(app, 'en_revision', 'aprobado', '');
    assert.match(out.subject, /^Your application: Approved/);
    assert.match(out.html, /Your application/);
    assert.match(out.html, /Approved/);
    assert.doesNotMatch(out.html, /Tu aplicacion/);
  });

  it('statusEmail uses Spanish copy + label for user.lang=es', () => {
    const app = makeAppWithUser('es');
    const out = statusEmail(app, 'en_revision', 'aprobado', '');
    assert.match(out.subject, /^Tu aplicacion: Aprobado/);
    assert.match(out.html, /Tu aplicacion/);
    assert.match(out.html, /Aprobado/);
  });

  it('statusEmail defaults to Spanish when client has no user_id', () => {
    const out = statusEmail(
      { id: 'orphan', listing_title: 'Casa', client: { name: 'X' } },
      null, 'aprobado', '',
    );
    assert.match(out.subject, /Aprobado/);
    assert.match(out.html, /Tu aplicacion/);
  });
});
