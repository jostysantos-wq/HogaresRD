const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const store   = require('./store');
const { userAuth, optionalAuth } = require('./auth');

const uid = () => 'tour_' + crypto.randomBytes(8).toString('hex');
const slotUid = () => 'avail_' + crypto.randomBytes(8).toString('hex');

const BROKER_ROLES = ['agency', 'broker', 'inmobiliaria'];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate concrete time slots for a broker on a specific date.
 * Considers their weekly schedule, then removes slots already booked.
 */
function generateSlots(brokerId, dateStr) {
  const dateObj  = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = dateObj.getUTCDay(); // 0=Sun … 6=Sat

  // Get broker's weekly availability for this day
  const weeklySlots = store.getAvailabilityByBroker(brokerId)
    .filter(s => s.active && s.day_of_week === dayOfWeek && s.type !== 'override');

  // Check for date overrides
  const overrides = store.getAvailabilityByBroker(brokerId)
    .filter(s => s.type === 'override' && s.date === dateStr);

  // If any override blocks the whole day, return empty
  if (overrides.some(o => !o.available)) return [];

  // Use override hours if any, otherwise weekly slots
  const sourceSlots = overrides.length > 0 && overrides.some(o => o.available)
    ? overrides.filter(o => o.available)
    : weeklySlots;

  if (!sourceSlots.length) return [];

  // Generate individual time slots
  const slots = [];
  for (const src of sourceSlots) {
    const duration = src.slot_duration_min || 30;
    const maxConcurrent = src.max_concurrent || 1;
    const [startH, startM] = src.start_time.split(':').map(Number);
    const [endH, endM]     = src.end_time.split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin   = endH * 60 + endM;

    for (let t = startMin; t + duration <= endMin; t += duration) {
      const h1 = String(Math.floor(t / 60)).padStart(2, '0');
      const m1 = String(t % 60).padStart(2, '0');
      const h2 = String(Math.floor((t + duration) / 60)).padStart(2, '0');
      const m2 = String((t + duration) % 60).padStart(2, '0');
      slots.push({
        time:     `${h1}:${m1}`,
        end_time: `${h2}:${m2}`,
        max_concurrent: maxConcurrent,
      });
    }
  }

  // Get already booked slots
  const booked = store.getBookedSlots(brokerId, dateStr);

  // Filter out fully booked slots
  return slots
    .map(s => {
      const count = booked.filter(b => b.requested_time === s.time).length;
      return { ...s, booked: count, available: count < s.max_concurrent };
    })
    .filter(s => s.available)
    .map(s => ({ time: s.time, end_time: s.end_time }));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Get available slots for a broker on a date
// GET /api/tours/availability/:brokerId?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/availability/:brokerId', (req, res) => {
  const { brokerId } = req.params;
  const { date }     = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" required (YYYY-MM-DD)' });
  }

  // Don't allow past dates
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return res.json({ slots: [] });

  const slots = generateSlots(brokerId, date);
  res.json({ date, broker_id: brokerId, slots });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Get broker's schedule overview (which days have availability)
// GET /api/tours/schedule/:brokerId?month=YYYY-MM
// ─────────────────────────────────────────────────────────────────────────────
router.get('/schedule/:brokerId', (req, res) => {
  const { brokerId } = req.params;
  const month = req.query.month || new Date().toISOString().slice(0, 7);

  const weeklySlots = store.getAvailabilityByBroker(brokerId)
    .filter(s => s.active && s.type !== 'override');

  // Build a set of active weekdays
  const activeDays = new Set(weeklySlots.map(s => s.day_of_week));

  // Get blocked dates from overrides
  const overrides = store.getAvailabilityByBroker(brokerId)
    .filter(s => s.type === 'override' && s.date && s.date.startsWith(month));

  const blockedDates = new Set(
    overrides.filter(o => !o.available).map(o => o.date)
  );

  // Generate dates for the month that have availability
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);
  const availableDates = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dateStr < today) continue;
    if (blockedDates.has(dateStr)) continue;
    const dow = new Date(dateStr + 'T12:00:00').getUTCDay();
    if (activeDays.has(dow)) availableDates.push(dateStr);
  }

  res.json({ month, broker_id: brokerId, available_dates: availableDates });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT: Request a tour
// POST /api/tours/request  (optionally authenticated)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/request', optionalAuth, (req, res) => {
  const { listing_id, broker_id, date, time, name, phone, email, notes } = req.body;

  if (!listing_id || !broker_id || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Campos requeridos: listing_id, broker_id, date, time, name, phone' });
  }

  // Verify the slot is still available
  const available = generateSlots(broker_id, date);
  const slotAvailable = available.some(s => s.time === time);
  if (!slotAvailable) {
    return res.status(409).json({ error: 'Este horario ya no está disponible. Por favor selecciona otro.' });
  }

  // Get listing title
  const listing = store.getListingById(listing_id);
  const listingTitle = listing ? listing.title : 'Propiedad';

  const tour = {
    id:             uid(),
    listing_id,
    listing_title:  listingTitle,
    broker_id,
    client_id:      req.user ? req.user.sub : null,
    client_name:    name,
    client_email:   email || '',
    client_phone:   phone,
    requested_date: date,
    requested_time: time,
    status:         'pending',
    broker_notes:   '',
    client_notes:   notes || '',
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  };

  store.saveTour(tour);
  res.status(201).json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT: Get my tour requests
// GET /api/tours/my-requests
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-requests', userAuth, (req, res) => {
  const tours = store.getToursByClient(req.user.sub)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json(tours);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Get incoming tour requests
// GET /api/tours/broker-requests
// ─────────────────────────────────────────────────────────────────────────────
router.get('/broker-requests', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Solo agentes pueden ver solicitudes de visita' });
  }
  const tours = store.getToursByBroker(req.user.sub)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json(tours);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Update tour status (confirm / reject)
// PUT /api/tours/:id/status
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/status', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const tour = store.getTourById(req.params.id);
  if (!tour) return res.status(404).json({ error: 'Visita no encontrada' });
  if (tour.broker_id !== req.user.sub) return res.status(403).json({ error: 'No autorizado' });

  const { status, notes } = req.body;
  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status debe ser "confirmed" o "rejected"' });
  }

  tour.status      = status;
  tour.broker_notes = notes || tour.broker_notes;
  tour.updated_at  = new Date().toISOString();
  store.saveTour(tour);

  res.json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// BOTH: Cancel a tour
// PUT /api/tours/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/cancel', userAuth, (req, res) => {
  const tour = store.getTourById(req.params.id);
  if (!tour) return res.status(404).json({ error: 'Visita no encontrada' });

  // Only broker or the requesting client can cancel
  if (tour.broker_id !== req.user.sub && tour.client_id !== req.user.sub) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  tour.status     = 'cancelled';
  tour.updated_at = new Date().toISOString();
  store.saveTour(tour);

  res.json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Get my availability config
// GET /api/tours/broker-availability
// ─────────────────────────────────────────────────────────────────────────────
router.get('/broker-availability', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const slots = store.getAvailabilityByBroker(req.user.sub);
  const weekly    = slots.filter(s => s.type !== 'override');
  const overrides = slots.filter(s => s.type === 'override');
  res.json({ weekly, overrides });
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Create / update a weekly availability slot
// POST /api/tours/broker-availability
// ─────────────────────────────────────────────────────────────────────────────
router.post('/broker-availability', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const { id, day_of_week, start_time, end_time, slot_duration_min, max_concurrent } = req.body;

  if (day_of_week == null || !start_time || !end_time) {
    return res.status(400).json({ error: 'Campos requeridos: day_of_week, start_time, end_time' });
  }

  const slot = {
    id:                id || slotUid(),
    broker_id:         req.user.sub,
    day_of_week:       Number(day_of_week),
    start_time,
    end_time,
    slot_duration_min: slot_duration_min || 30,
    max_concurrent:    max_concurrent || 1,
    active:            true,
    type:              'weekly',
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  };

  store.saveAvailabilitySlot(slot);
  res.status(201).json(slot);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Delete a weekly availability slot
// DELETE /api/tours/broker-availability/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/broker-availability/:id', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  store.deleteAvailabilitySlot(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Add a date override (block day or special hours)
// POST /api/tours/broker-availability/override
// ─────────────────────────────────────────────────────────────────────────────
router.post('/broker-availability/override', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const { date, available, start_time, end_time, slot_duration_min } = req.body;
  if (!date) return res.status(400).json({ error: 'Campo "date" requerido' });

  const override = {
    id:                slotUid(),
    broker_id:         req.user.sub,
    type:              'override',
    date,
    available:         available !== false,
    start_time:        start_time || '09:00',
    end_time:          end_time   || '17:00',
    slot_duration_min: slot_duration_min || 30,
    max_concurrent:    1,
    active:            true,
    created_at:        new Date().toISOString(),
  };

  store.saveAvailabilitySlot(override);
  res.status(201).json(override);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Delete a date override
// DELETE /api/tours/broker-availability/override/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/broker-availability/override/:id', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  store.deleteAvailabilitySlot(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
