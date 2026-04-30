/**
 * E2 + E3 — notification surfacing & push→email fallback
 *
 *   - GET /:id/notification-failures returns the on-app array.
 *   - GET /api/applications/notification-failures (admin) lists all
 *     applications with non-empty failures.
 *   - notify() forces an email when the user has pushFallbackToEmail=true,
 *     even if a push subscription is on file.
 *   - Re-subscribing via POST /api/push/subscribe clears the flag.
 */

'use strict';

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const {
  startServer, stopServer, post, get, auth,
  makeBroker, makeListing, makeApplication, makeTenant, store,
} = helpers;

const push = require('../routes/push');

describe('notification surfacing & fallback', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  it('GET /:id/notification-failures returns the array', async () => {
    const broker = await makeBroker('nf-get');
    const listing = makeListing(broker);
    const application = makeApplication(listing, broker, {
      notification_failures: [
        { id: 'nf1', recipient: 'a@x.com', subject: 'Test', purpose: 'unit', error: 'mailbox full', failed_at: '2026-04-29T10:00:00.000Z', retried: false },
      ],
    });

    const res = await get(`/api/applications/${application.id}/notification-failures`, auth(broker.token));
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body.failures), true);
    assert.equal(res.body.failures.length, 1);
    assert.equal(res.body.failures[0].subject, 'Test');
  });

  it('admin GET /api/applications/notification-failures lists across apps', async () => {
    // Make an admin token by promoting a user
    const admin = await makeTenant('nf-admin');
    const u = store.getUserById(admin.id);
    u.role = 'admin';
    store.saveUser(u);
    // Re-login to get a token with role=admin
    const lg = await post('/api/auth/login', { email: admin.email, password: 'TestPass1!' });
    const adminToken = lg.body?.token;
    assert.ok(adminToken, 'admin login returned token');

    const broker = await makeBroker('nf-admin-broker');
    const listing = makeListing(broker);
    makeApplication(listing, broker, {
      notification_failures: [
        { id: 'nfa1', recipient: 'b@x.com', subject: 'Boom', purpose: 'unit', error: 'bounced', failed_at: '2026-04-30T10:00:00.000Z', retried: false },
      ],
    });

    const res = await get('/api/applications/notification-failures', auth(adminToken));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const found = res.body.find(e => (e.failures || []).some(f => f.subject === 'Boom'));
    assert.ok(found, 'expected the seeded failure to appear in the admin digest');
  });

  it('admin GET /api/applications/notification-failures denies non-admin', async () => {
    const broker = await makeBroker('nf-noadmin');
    const res = await get('/api/applications/notification-failures', auth(broker.token));
    assert.equal(res.status, 403);
  });

  it('notify() emails users whose pushFallbackToEmail flag is true', async () => {
    const tenant = await makeTenant('nf-fallback');
    // Mark fallback flag and ensure a push sub exists too — we want to
    // confirm the email STILL fires even when a sub is on file.
    const u = store.getUserById(tenant.id);
    u.pushFallbackToEmail = true;
    store.saveUser(u);
    store.savePushSubscription(tenant.id, {
      web: [{ endpoint: 'https://fake/endpoint', keys: { p256dh: 'k', auth: 'a' } }],
      ios: [],
      preferences: {},
    });

    // Stub the email transporter to capture sendMail calls.
    const sent = [];
    push.__test._setTransporter({ sendMail: async (opts) => { sent.push(opts); return { ok: true }; } });

    await push.notify(tenant.id, {
      type: 'general',
      title: 'Importante',
      body:  'Tu aplicación tiene novedades.',
      url:   '/my-applications',
    });

    assert.equal(sent.length, 1, 'expected 1 fallback email');
    assert.equal(sent[0].to, tenant.email);
    assert.match(sent[0].subject || '', /Importante/);
  });

  it('re-subscribing via POST /api/push/subscribe clears pushFallbackToEmail', async () => {
    const tenant = await makeTenant('nf-resub');
    const u = store.getUserById(tenant.id);
    u.pushFallbackToEmail = true;
    store.saveUser(u);

    const res = await post('/api/push/subscribe', {
      type: 'web',
      subscription: { endpoint: 'https://fake/resub', keys: { p256dh: 'k', auth: 'a' } },
    }, auth(tenant.token));
    assert.equal(res.status, 200);

    const reread = store.getUserById(tenant.id);
    assert.equal(reread.pushFallbackToEmail, false);
  });

  it('notify() does NOT email when flag is false (sanity)', async () => {
    const tenant = await makeTenant('nf-noflag');
    store.savePushSubscription(tenant.id, {
      web: [{ endpoint: 'https://fake/none', keys: { p256dh: 'k', auth: 'a' } }],
      ios: [],
      preferences: {},
    });

    const sent = [];
    push.__test._setTransporter({ sendMail: async (opts) => { sent.push(opts); return { ok: true }; } });

    await push.notify(tenant.id, {
      type: 'general',
      title: 'Hola',
      body:  'No deberías recibir email.',
      url:   '/',
    });

    assert.equal(sent.length, 0, 'no email expected when flag is false');
  });
});
