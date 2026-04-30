/**
 * P1 #17 — When an iOS APNs send returns Unregistered/BadDeviceToken,
 * notify() must:
 *   1. remove the dead device token from the user's push subscription, AND
 *   2. set user.pushFallbackToEmail = true so future notifications go
 *      via email until the user re-subscribes.
 *
 * The web branch already does this; this test confirms the iOS branch
 * now mirrors that behavior.
 */

'use strict';

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const { startServer, stopServer, store, makeTenant } = helpers;
const push = require('../routes/push');

describe('P1 #17 — iOS APNs Unregistered sets pushFallbackToEmail', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  it('sets pushFallbackToEmail when every iOS token returns Unregistered', async () => {
    const tenant = await makeTenant('apns-unreg');

    // Seed an iOS-only push sub so notify() takes the iOS branch.
    store.savePushSubscription(tenant.id, {
      web: [],
      ios: ['ios-token-bogus-1'],
      preferences: {},
    });

    // Sanity: flag is not set yet.
    let u = store.getUserById(tenant.id);
    assert.notEqual(u.pushFallbackToEmail, true);

    // Stub APNs to return Unregistered for every send.
    push.__test._setApnsSendOverride(async () => ({
      success: false,
      statusCode: 410,
      reason: 'Unregistered',
    }));
    // Also stub the email transporter so the fallback step doesn't try
    // to open a real SMTP connection.
    push.__test._setTransporter({ sendMail: async () => ({ ok: true }) });

    try {
      await push.notify(tenant.id, {
        type: 'new_message',
        title: 'Test',
        body:  'Hi',
        url:   '/',
      });
    } finally {
      push.__test._setApnsSendOverride(null);
    }

    u = store.getUserById(tenant.id);
    assert.equal(u.pushFallbackToEmail, true,
      'iOS Unregistered must sticky the email-fallback flag');

    // The dead token must also have been removed.
    const subs = store.getPushSubscriptionsByUser(tenant.id);
    assert.equal(subs.ios.length, 0,
      'invalid iOS token should be removed');
  });

  it('also handles BadDeviceToken (parity with Unregistered)', async () => {
    const tenant = await makeTenant('apns-bad');
    store.savePushSubscription(tenant.id, {
      web: [],
      ios: ['ios-token-bogus-2'],
      preferences: {},
    });

    push.__test._setApnsSendOverride(async () => ({
      success: false,
      statusCode: 400,
      reason: 'BadDeviceToken',
    }));
    push.__test._setTransporter({ sendMail: async () => ({ ok: true }) });
    try {
      await push.notify(tenant.id, { type: 'general', title: 'x', body: 'y', url: '/' });
    } finally {
      push.__test._setApnsSendOverride(null);
    }

    const u = store.getUserById(tenant.id);
    assert.equal(u.pushFallbackToEmail, true);
  });

  it('does NOT set the flag when APNs succeeds', async () => {
    const tenant = await makeTenant('apns-ok');
    store.savePushSubscription(tenant.id, {
      web: [],
      ios: ['ios-token-good'],
      preferences: {},
    });

    push.__test._setApnsSendOverride(async () => ({ success: true, statusCode: 200 }));
    push.__test._setTransporter({ sendMail: async () => ({ ok: true }) });
    try {
      await push.notify(tenant.id, { type: 'general', title: 'x', body: 'y', url: '/' });
    } finally {
      push.__test._setApnsSendOverride(null);
    }

    const u = store.getUserById(tenant.id);
    assert.notEqual(u.pushFallbackToEmail, true,
      'successful APNs send must not flip the fallback flag');

    const subs = store.getPushSubscriptionsByUser(tenant.id);
    assert.equal(subs.ios.length, 1, 'good token must stay');
  });

  it('does NOT set the flag for transient errors (e.g. 500)', async () => {
    const tenant = await makeTenant('apns-500');
    store.savePushSubscription(tenant.id, {
      web: [],
      ios: ['ios-token-transient'],
      preferences: {},
    });

    push.__test._setApnsSendOverride(async () => ({
      success: false,
      statusCode: 500,
      reason: 'InternalServerError',
    }));
    push.__test._setTransporter({ sendMail: async () => ({ ok: true }) });
    try {
      await push.notify(tenant.id, { type: 'general', title: 'x', body: 'y', url: '/' });
    } finally {
      push.__test._setApnsSendOverride(null);
    }

    const u = store.getUserById(tenant.id);
    assert.notEqual(u.pushFallbackToEmail, true,
      'only Unregistered/BadDeviceToken should sticky the flag');
  });
});
