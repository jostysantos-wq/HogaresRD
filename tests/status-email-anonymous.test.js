/**
 * Wave 9-D regression test — statusEmail uses /track.html?token= for
 * anonymous applicants instead of /my-applications?id=.
 *
 * Background: anonymous applications (client.user_id == null) used to
 * receive a status-change email pointing at /my-applications?id=<id>.
 * That page requires login, so anon clicks bounced to /login and
 * couldn't reach their tracking view. Logged-in buyers should still get
 * the in-app deep link — they HAVE an account.
 *
 * The fix: when client.user_id is missing, mint a fresh track JWT via
 * the existing signTrackToken() helper and link to /track.html?token=...
 *
 * This test drives the real PUT /:id/status route end-to-end with a
 * stub transporter so we can assert on the captured email body.
 *
 * Run:  node --test tests/status-email-anonymous.test.js
 *  or:  npm test
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const {
  put, auth,
  startServer, stopServer,
  makeBroker, makeTenant, makeListing, makeApplication,
} = helpers;

const appsRouter = require('../routes/applications');
const { _setTransporter } = appsRouter.__test;

// ── Stub transporter — capture every outbound email for assertions ──
const sentEmails = [];
function installStubTransporter() {
  _setTransporter({
    sendMail: async (msg) => {
      sentEmails.push(msg);
      return { ok: true };
    },
  });
}

before(async () => {
  await startServer();
  installStubTransporter();
});

after(stopServer);

describe('Wave 9-D — statusEmail link routing for anonymous vs logged-in clients', () => {
  it('anonymous applicant receives /track.html?token= magic link, NOT /my-applications', async () => {
    const broker  = await makeBroker('w9d-anon');
    const listing = makeListing(broker);
    // Anonymous: no client.user_id (the helper default is already null,
    // but we set it explicitly so the intent is obvious).
    const application = makeApplication(listing, broker, {
      client: {
        name:    'Walk-in Buyer',
        phone:   '+18095559999',
        email:   `anon-${Date.now()}@hogaresrd-test.com`,
        user_id: null,
      },
      status: 'aplicado',
    });

    // Snapshot the inbox so we only inspect emails triggered by THIS test.
    const before = sentEmails.length;

    const res = await put(`/api/applications/${application.id}/status`,
      { status: 'en_revision' },
      auth(broker.token));
    assert.equal(res.status, 200, res.text);

    // Allow the fire-and-forget sendNotification to flush.
    await new Promise(r => setTimeout(r, 50));

    const ours = sentEmails.slice(before).find(m => m.to === application.client.email);
    assert.ok(ours, 'expected a status-change email to the anonymous applicant');
    assert.match(ours.html, /\/track\.html\?token=/,
      'anonymous applicant email must use the magic-link /track.html?token= URL');
    assert.doesNotMatch(ours.html, /\/my-applications\?id=/,
      'anonymous applicant email must NOT use /my-applications?id=');
  });

  it('logged-in buyer keeps the /my-applications?id= deep link', async () => {
    const broker  = await makeBroker('w9d-loggedin');
    const listing = makeListing(broker);
    const tenant  = await makeTenant('w9d-loggedin');
    const application = makeApplication(listing, broker, {
      client: {
        name:    tenant.name,
        phone:   '+18095559999',
        email:   tenant.email,
        user_id: tenant.id,
      },
      status: 'aplicado',
    });

    const before = sentEmails.length;

    const res = await put(`/api/applications/${application.id}/status`,
      { status: 'en_revision' },
      auth(broker.token));
    assert.equal(res.status, 200, res.text);

    await new Promise(r => setTimeout(r, 50));

    const ours = sentEmails.slice(before).find(m => m.to === application.client.email);
    assert.ok(ours, 'expected a status-change email to the logged-in buyer');
    assert.match(ours.html, /\/my-applications\?id=/,
      'logged-in buyer email must use the in-app /my-applications?id= deep link');
    assert.doesNotMatch(ours.html, /\/track\.html\?token=/,
      'logged-in buyer email must NOT use the anonymous magic-link URL');
  });
});
