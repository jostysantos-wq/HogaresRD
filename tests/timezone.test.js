/**
 * E4: tour timezone normalization.
 *
 * Covers POST /api/applications/:id/tours and PUT
 * /api/applications/:id/tours/:tourId in three flavors:
 *   - new client sends `scheduled_at` ISO → DR offset preserved/rewritten
 *   - legacy client sends `scheduled_date` + `scheduled_time` → still works
 *   - the email body the broker route sends out includes "(Hora RD)"
 *
 * Run:  node --test tests/timezone.test.js
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// IMPORTANT: hook the mailer BEFORE any route file requires it. Each
// route's `transporter = createTransport()` line caches the transport
// on module load, so we have to swap the factory before the very
// first require of routes/applications.js (which happens transitively
// from `_app-helpers`).
const sentMail = [];
const mailer = require('../routes/mailer');
mailer.createTransport = function () {
  return {
    sendMail: async (msg) => { sentMail.push(msg); return { messageId: 'test' }; },
    verify:   async () => true,
  };
};

const {
  post, put, auth,
  startServer, stopServer,
  makeBroker, makeListing, makeApplication,
} = require('./_app-helpers');

let broker, listing, app;

before(async () => {
  await startServer();
  broker  = await makeBroker('tz');
  listing = makeListing(broker);
  app     = makeApplication(listing, broker, {
    client: { name: 'Cliente RD', phone: '+18095559999', email: 'cliente@ex.com', user_id: null },
  });
});
after(stopServer);

describe('E4 tour timezone', () => {
  it('POST with scheduled_at stores ISO with -04:00 offset', async () => {
    // Pick a date far in the future to dodge "in the past" check.
    const isoIn = '2099-05-15T14:00:00';
    const r = await post(
      `/api/applications/${app.id}/tours`,
      { scheduled_at: isoIn, location: 'Casa Modelo', notes: '' },
      auth(broker.token),
    );
    assert.equal(r.status, 200, r.text);
    const tours = r.body.tours || [];
    assert.equal(tours.length >= 1, true);
    const t = tours[tours.length - 1];
    assert.match(t.scheduled_at, /-04:00$/, 'should end in -04:00');
    assert.equal(t.scheduled_date, '2099-05-15');
    assert.equal(t.scheduled_time, '14:00');
  });

  it('POST with legacy scheduled_date/scheduled_time still works', async () => {
    const r = await post(
      `/api/applications/${app.id}/tours`,
      { scheduled_date: '2099-06-20', scheduled_time: '09:30', location: '', notes: '' },
      auth(broker.token),
    );
    assert.equal(r.status, 200, r.text);
    const t = r.body.tours[r.body.tours.length - 1];
    assert.equal(t.scheduled_date, '2099-06-20');
    assert.equal(t.scheduled_time, '09:30');
    assert.equal(t.scheduled_at, '2099-06-20T09:30:00-04:00');
  });

  it('PUT updates time and re-normalizes scheduled_at', async () => {
    // Schedule one then update it.
    const create = await post(
      `/api/applications/${app.id}/tours`,
      { scheduled_at: '2099-07-10T11:00:00-04:00' },
      auth(broker.token),
    );
    const tourId = create.body.tours[create.body.tours.length - 1].id;
    const upd = await put(
      `/api/applications/${app.id}/tours/${tourId}`,
      { scheduled_time: '15:45' },
      auth(broker.token),
    );
    assert.equal(upd.status, 200, upd.text);
    const t = upd.body.tours.find(x => x.id === tourId);
    assert.equal(t.scheduled_time, '15:45');
    assert.equal(t.scheduled_date, '2099-07-10');
    assert.match(t.scheduled_at, /^2099-07-10T15:45:00-04:00$/);
  });

  it('client email body includes "(Hora RD)"', async () => {
    sentMail.length = 0;
    await post(
      `/api/applications/${app.id}/tours`,
      { scheduled_at: '2099-08-01T10:00:00-04:00' },
      auth(broker.token),
    );
    // The route fires sendNotification → mailer.sendMail. The mock
    // captures the html body.
    const tourMail = sentMail.find(m => /Tour Programado/i.test(m.html || ''));
    assert.ok(tourMail, 'expected a "Tour Programado" email');
    assert.match(tourMail.html, /\(Hora RD\)/, 'expected (Hora RD) suffix in email body');
  });
});
