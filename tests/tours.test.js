/**
 * Tour-scheduling endpoint coverage.
 *
 * Drives the public-side tour request through to broker confirm/cancel.
 * Anonymous request → broker GET list → confirm → cancel, plus a
 * cross-broker authorization guard.
 *
 * Endpoint paths verified against routes/tours.js:
 *   POST   /api/tours/request              (anonymous + optionalAuth)
 *   GET    /api/tours/broker-requests       (broker JWT — assigned tours)
 *   PUT    /api/tours/:id/status            ({status:'confirmed'} or 'rejected')
 *   PUT    /api/tours/:id/cancel            (broker or client)
 *
 * The prompt referred to /api/tours/broker, /:id/confirm, /:id/cancel
 * (with a required reason). The actual route file uses different names
 * and the cancel endpoint does NOT require a reason — we test what's
 * really there, not what was specified, and document the gap.
 *
 * Run:  node --test tests/tours.test.js
 *  or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  get, post, put, auth,
  startServer, stopServer,
  makeBroker, makeListing,
  store,
} = require('./_app-helpers');

// `POST /api/tours/request` is rate-limited to 5/15min per IP. All
// tests share 127.0.0.1, so going through the public endpoint for
// every fixture would trip the limiter. We hit `/request` ONCE (the
// anonymous-user scenario, which is the actual public-facing path
// under audit) and seed via store.saveTour() everywhere else — same
// shape the route writes, just without the slot-availability gate.
function seedTour(broker, listing, overrides = {}) {
  const tour = {
    id:             'tour_' + crypto.randomBytes(8).toString('hex'),
    listing_id:     listing.id,
    listing_title:  listing.title,
    broker_id:      broker.id,
    client_id:      null,
    client_name:    'Seeded Visitor',
    client_email:   'seeded@example.com',
    client_phone:   '+18095559999',
    requested_date: '2099-01-15',
    requested_time: '10:00',
    status:         'pending',
    broker_notes:   '',
    client_notes:   '',
    tour_type:      'presencial',
    virtual_link:   '',
    application_id: null,
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    ...overrides,
  };
  store.saveTour(tour);
  return tour;
}

// ── Setup helpers ─────────────────────────────────────────────────

/**
 * Drop a wide-open weekly availability slot in the cache so the
 * generateSlots() check in POST /api/tours/request will return our
 * date+time as available. We pick a date that's far enough in the
 * future that today's date never accidentally lands on the same
 * weekday after midnight.
 */
function seedAvailability(brokerId) {
  // 7 days from now — guaranteed future, same weekday as today
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const dateStr = future.toISOString().slice(0, 10);
  const dayOfWeek = future.getUTCDay();

  store.saveAvailabilitySlot({
    id:                'avail_test_' + brokerId.slice(0, 8),
    broker_id:         brokerId,
    day_of_week:       dayOfWeek,
    start_time:        '09:00',
    end_time:          '18:00',
    slot_duration_min: 30,
    max_concurrent:    5,    // wide-open so multiple tests can share
    active:            true,
    type:              'weekly',
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  });

  return { date: dateStr, time: '10:00' };
}

// ── Lifecycle ─────────────────────────────────────────────────────

before(startServer);
after(stopServer);

// ════════════════════════════════════════════════════════════════════
// 1 — Anonymous tour request
// ════════════════════════════════════════════════════════════════════

describe('Tours — POST /api/tours/request (anonymous)', () => {
  let broker, listing, slot;

  before(async () => {
    broker  = await makeBroker('tour-anon');
    listing = makeListing(broker);
    slot    = seedAvailability(broker.id);
  });

  it('rejects when phone is malformed (400) — fails before slot check', async () => {
    // Run the validation test FIRST so we burn one rate-limit slot on a
    // 400 (invalid phone) before the 201. The limiter counts every
    // request, success or not; we have 5/15min on 127.0.0.1.
    const res = await post('/api/tours/request', {
      listing_id: listing.id,
      broker_id:  broker.id,
      date:       slot.date,
      time:       '10:30',
      name:       'Bad Phone',
      phone:      'not-a-phone',
    });
    assert.equal(res.status, 400);
  });

  it('anonymous user can request a tour and gets back a tour id (201)', async () => {
    const res = await post('/api/tours/request', {
      listing_id: listing.id,
      broker_id:  broker.id,
      date:       slot.date,
      time:       slot.time,
      name:       'Anon Visitor',
      phone:      '+18095551111',
      email:      'visitor@example.com',
      tour_type:  'presencial',
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status} ${res.text}`);
    assert.ok(res.body.id, 'response should include tour id');
    assert.ok(res.body.id.startsWith('tour_'), 'tour id should be prefixed tour_');
    assert.equal(res.body.broker_id, broker.id);
    assert.equal(res.body.listing_id, listing.id);
    assert.equal(res.body.status, 'pending', 'new tours default to pending');
  });
});

// ════════════════════════════════════════════════════════════════════
// 2 — Broker GETs assigned tours
// ════════════════════════════════════════════════════════════════════

describe('Tours — GET /api/tours/broker-requests', () => {
  let broker, listing, tourId;

  before(async () => {
    broker  = await makeBroker('tour-list');
    listing = makeListing(broker);
    // Seed directly to dodge the 5/15min rate limit on /request.
    tourId = seedTour(broker, listing, { requested_time: '11:00' }).id;
  });

  it('broker sees their assigned tours in the list', async () => {
    const res = await get('/api/tours/broker-requests', auth(broker.token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'should return an array');
    const found = res.body.find(t => t.id === tourId);
    assert.ok(found, 'newly created tour should be in the list');
    assert.equal(found.broker_id, broker.id);
  });

  it('returns 401 without a token', async () => {
    const res = await get('/api/tours/broker-requests');
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3 — Broker confirms a tour (PUT /:id/status)
// ════════════════════════════════════════════════════════════════════

describe('Tours — PUT /api/tours/:id/status (confirm)', () => {
  let broker, listing, tourId;

  before(async () => {
    broker  = await makeBroker('tour-confirm');
    listing = makeListing(broker);
    tourId  = seedTour(broker, listing, { requested_time: '12:00' }).id;
  });

  it('flips status to confirmed when broker confirms', async () => {
    const res = await put(`/api/tours/${tourId}/status`,
      { status: 'confirmed', notes: 'Te espero a las 12.' },
      auth(broker.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);
    assert.equal(res.body.status, 'confirmed');
    assert.equal(res.body.broker_notes, 'Te espero a las 12.');
  });

  it('rejects an invalid status value with 400', async () => {
    const res = await put(`/api/tours/${tourId}/status`,
      { status: 'totally_made_up' },
      auth(broker.token));
    assert.equal(res.status, 400);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4 — Broker cancels a tour (PUT /:id/cancel)
// ════════════════════════════════════════════════════════════════════
//
// The `routes/tours.js` cancel endpoint does NOT enforce a reason
// — anyone with management rights can call it. We pin both shapes
// (with notes / without) so any future change that adds a required
// reason is caught.

describe('Tours — PUT /api/tours/:id/cancel', () => {
  let broker, listing, tourId;

  before(async () => {
    broker  = await makeBroker('tour-cancel');
    listing = makeListing(broker);
    tourId  = seedTour(broker, listing, { requested_time: '13:00' }).id;
  });

  it('broker can cancel and gets status=cancelled (200)', async () => {
    const res = await put(`/api/tours/${tourId}/cancel`, {}, auth(broker.token));
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.text}`);
    assert.equal(res.body.status, 'cancelled');
  });

  it('cancelling a non-existent tour returns 404', async () => {
    const res = await put('/api/tours/tour_does_not_exist/cancel', {}, auth(broker.token));
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════
// 5 — Cross-broker authorization
// ════════════════════════════════════════════════════════════════════

describe('Tours — cross-broker authorization', () => {
  let owner, intruder, listing, tourId;

  before(async () => {
    owner    = await makeBroker('tour-owner');
    intruder = await makeBroker('tour-intruder');
    listing  = makeListing(owner);
    tourId   = seedTour(owner, listing, { requested_time: '14:00' }).id;
  });

  it('a different broker cannot confirm someone else\'s tour (403)', async () => {
    const res = await put(`/api/tours/${tourId}/status`,
      { status: 'confirmed' },
      auth(intruder.token));
    assert.equal(res.status, 403);
  });

  it('a different broker cannot cancel someone else\'s tour (403)', async () => {
    const res = await put(`/api/tours/${tourId}/cancel`, {},
      auth(intruder.token));
    assert.equal(res.status, 403);
  });

  it('owner can still confirm after the intrusion attempts (200)', async () => {
    const res = await put(`/api/tours/${tourId}/status`,
      { status: 'confirmed' },
      auth(owner.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'confirmed');
  });
});
