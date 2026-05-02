const express   = require('express');
const router    = express.Router();
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const store     = require('./store');
const { userAuth, optionalAuth } = require('./auth');
const { notify: pushNotify } = require('./push');
const { isReferrerAffiliatedWithListing } = require('../utils/affiliation');
const { createTransport } = require('./mailer');
const et = require('../utils/email-templates');

const transporter = createTransport();
const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';

const tourRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  message: { error: 'Demasiadas solicitudes de visita. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uid = () => 'tour_' + crypto.randomBytes(8).toString('hex');
const slotUid = () => 'avail_' + crypto.randomBytes(8).toString('hex');

const BROKER_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];

// DR phone: 809/829/849 + 7 digits, or +1-809/829/849, or general 7+ digit international
const PHONE_RE = /^[\d\s()+-]{7,20}$/;

/** Check if the user is the broker OR a secretary on the broker's team */
function canManageTour(user, tour) {
  if (tour.broker_id === user.sub) return true;
  if (user.role === 'secretary') {
    const u = store.getUserById(user.sub);
    if (u?.inmobiliaria_id) {
      const team = store.getUsersByInmobiliaria(u.inmobiliaria_id);
      return team.some(m => m.id === tour.broker_id);
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendTourEmail(to, subject, html) {
  if (!to) return;
  transporter.sendMail({ to, subject, html, department: 'noreply' })
    .catch(err => console.error('[tours] Email failed:', subject, '→', to, err.message));
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-DO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function tourTypeLabel(tour) {
  return tour.tour_type === 'virtual' ? 'Virtual' : 'Presencial';
}

function tourRequestEmail(tour, brokerName) {
  return et.layout({
    title: 'Solicitud de visita',
    subtitle: et.esc(tour.listing_title),
    preheader: `Solicitud de visita para ${tour.listing_title}`,
    body: et.p(`<strong>${et.esc(tour.client_name)}</strong> ha solicitado una visita:`)
        + et.infoTable(
            et.infoRow('Propiedad', et.esc(tour.listing_title))
          + et.infoRow('Tipo', tourTypeLabel(tour))
          + et.infoRow('Fecha', formatDate(tour.requested_date))
          + et.infoRow('Hora', et.esc(tour.requested_time))
          + et.infoRow('Telefono', et.esc(tour.client_phone))
          + (tour.client_email ? et.infoRow('Email', et.esc(tour.client_email)) : '')
          + (tour.client_notes ? et.infoRow('Notas', et.esc(tour.client_notes)) : '')
        )
        + et.button('Ver solicitud', `${BASE_URL}/broker#visitas`),
  });
}

function tourConfirmedEmail(tour, brokerName) {
  const isVirtual = tour.tour_type === 'virtual';
  return et.layout({
    title: 'Visita confirmada',
    subtitle: et.esc(tour.listing_title),
    preheader: `Tu visita a ${tour.listing_title} esta confirmada`,
    headerColor: '#1B7A3E',
    body: et.p(`Tu visita ha sido <strong>confirmada</strong> por ${et.esc(brokerName)}.`)
        + et.infoTable(
            et.infoRow('Propiedad', et.esc(tour.listing_title))
          + et.infoRow('Tipo', tourTypeLabel(tour))
          + et.infoRow('Fecha', formatDate(tour.requested_date))
          + et.infoRow('Hora', et.esc(tour.requested_time))
          + (tour.broker_notes ? et.infoRow('Notas del agente', et.esc(tour.broker_notes)) : '')
          + (isVirtual && tour.virtual_link ? et.infoRow('Enlace', `<a href="${encodeURI(tour.virtual_link)}" style="color:#002D62;font-weight:600;">Unirse a la visita virtual</a>`) : '')
        )
        + et.alertBox(
            isVirtual
              ? 'Conectate unos minutos antes para probar tu camara y audio.'
              : 'Te recomendamos llegar 5 minutos antes de la hora programada.',
            'success'
          ),
  });
}

function tourRejectedEmail(tour, brokerName) {
  return et.layout({
    title: 'Visita no disponible',
    subtitle: et.esc(tour.listing_title),
    preheader: `La visita a ${tour.listing_title} no esta disponible`,
    headerColor: '#CE1126',
    body: et.p('Lamentablemente, tu solicitud de visita no pudo ser confirmada.')
        + et.infoTable(
            et.infoRow('Propiedad', et.esc(tour.listing_title))
          + et.infoRow('Fecha solicitada', formatDate(tour.requested_date))
          + et.infoRow('Hora solicitada', et.esc(tour.requested_time))
          + (tour.broker_notes ? et.infoRow('Motivo', et.esc(tour.broker_notes)) : '')
        )
        + et.alertBox('Puedes solicitar una nueva visita en otro horario disponible.', 'info')
        + et.button('Buscar horarios', BASE_URL),
  });
}

function tourRescheduledEmail(tour, oldDate, oldTime, rescheduledByBroker) {
  const who = rescheduledByBroker ? 'el agente' : et.esc(tour.client_name);
  return et.layout({
    title: 'Visita reprogramada',
    subtitle: et.esc(tour.listing_title),
    preheader: `La visita a ${tour.listing_title} fue reprogramada`,
    body: et.p(`La visita ha sido reprogramada por <strong>${who}</strong>.`)
        + et.infoTable(
            et.infoRow('Propiedad', et.esc(tour.listing_title))
          + et.infoRow('Fecha anterior', `<span style="text-decoration:line-through;color:#999;">${formatDate(oldDate)} a las ${et.esc(oldTime)}</span>`)
          + et.infoRow('Nueva fecha', `<span style="color:#1B7A3E;font-weight:700;">${formatDate(tour.requested_date)} a las ${et.esc(tour.requested_time)}</span>`)
        )
        + et.alertBox('La visita vuelve a estado pendiente y requiere confirmacion.', 'warning'),
  });
}

function tourCancelledEmail(tour, cancelledByBroker) {
  const who = cancelledByBroker ? 'el agente' : et.esc(tour.client_name);
  return et.layout({
    title: 'Visita cancelada',
    subtitle: et.esc(tour.listing_title),
    preheader: `La visita a ${tour.listing_title} fue cancelada`,
    headerColor: '#CE1126',
    body: et.p(`La visita ha sido cancelada por <strong>${who}</strong>.`)
        + et.infoTable(
            et.infoRow('Propiedad', et.esc(tour.listing_title))
          + et.infoRow('Fecha', formatDate(tour.requested_date))
          + et.infoRow('Hora', et.esc(tour.requested_time))
        ),
  });
}

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
router.post('/request', tourRequestLimiter, optionalAuth, (req, res) => {
  const { listing_id, broker_id, date, time, name, phone, email, notes, tour_type, virtual_link, application_id } = req.body;

  if (!listing_id || !broker_id || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Campos requeridos: listing_id, broker_id, date, time, name, phone' });
  }

  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'Número de teléfono inválido' });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  // Get listing — needed for the affiliation check below.
  const listing = store.getListingById(listing_id);
  if (!listing) {
    return res.status(404).json({ error: 'Propiedad no encontrada.' });
  }
  const listingTitle = listing.title || 'Propiedad';

  // SECURITY: validate that the requested broker_id is actually affiliated
  // with this listing. Without this check, a malicious client can pass
  // ANY user_id as broker_id and book a "tour" against an unaffiliated
  // agent's calendar — same lead-theft surface the application flow
  // closed earlier. Admins may book on behalf of any broker.
  const requestedBroker = store.getUserById(broker_id);
  if (!requestedBroker) {
    return res.status(400).json({ error: 'Agente no encontrado.' });
  }
  const requesterIsAdmin = req.user?.sub
    ? (store.getUserById(req.user.sub)?.role === 'admin')
    : false;
  if (!requesterIsAdmin && !isReferrerAffiliatedWithListing(requestedBroker, listing)) {
    return res.status(403).json({
      error: 'Este agente no está asociado a esta propiedad.',
      code:  'broker_not_affiliated',
    });
  }

  // Verify the slot is still available
  const available = generateSlots(broker_id, date);
  const slotAvailable = available.some(s => s.time === time);
  if (!slotAvailable) {
    return res.status(409).json({ error: 'Este horario ya no está disponible. Por favor selecciona otro.' });
  }

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
    tour_type:      tour_type === 'virtual' ? 'virtual' : 'presencial',
    virtual_link:   tour_type === 'virtual' ? (virtual_link || '') : '',
    application_id: application_id || null,
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  };

  // Double-booking prevention: re-check availability right before save.
  // Since cache updates are synchronous (single-threaded Node.js), this
  // is a reliable lock — the first request's saveTour updates _tours cache
  // before the second request reaches this point.
  const finalCheck = generateSlots(broker_id, date);
  if (!finalCheck.some(s => s.time === time)) {
    return res.status(409).json({ error: 'Este horario acaba de ser reservado. Por favor selecciona otro.' });
  }

  // Check if broker has auto-confirm enabled
  const broker = store.getUserById(broker_id);
  if (broker?.auto_confirm_tours) {
    tour.status = 'confirmed';
  }

  store.saveTour(tour);
  res.status(201).json(tour);

  if (tour.status === 'confirmed') {
    // Auto-confirmed — notify client
    if (tour.client_id) {
      pushNotify(tour.client_id, {
        type: 'tour_update',
        title: 'Visita Confirmada ✓',
        body: `Tu visita a ${listingTitle} el ${date} a las ${time} fue confirmada automáticamente`,
        url: '/profile',
      });
    }
    const clientEmail = tour.client_email || (tour.client_id ? store.getUserById(tour.client_id)?.email : null);
    if (clientEmail) {
      sendTourEmail(clientEmail, `Visita confirmada — ${listingTitle}`, tourConfirmedEmail(tour, broker?.name || 'el agente'));
    }
    // Also notify broker of the new booking
    pushNotify(broker_id, {
      type: 'tour_update',
      title: 'Visita Auto-Confirmada',
      body: `${name} reservó una visita para ${listingTitle} el ${date} a las ${time}`,
      url: '/broker.html',
    });
  } else {
    // Pending — notify broker to review
    pushNotify(broker_id, {
      type: 'tour_update',
      title: 'Nueva Solicitud de Visita',
      body: `${name} solicitó una visita para ${listingTitle} el ${date} a las ${time}`,
      url: '/broker.html',
    });
  }

  // Email → broker
  if (broker?.email) {
    sendTourEmail(broker.email, tour.status === 'confirmed'
      ? `Visita auto-confirmada — ${listingTitle}`
      : `Nueva solicitud de visita — ${listingTitle}`, tourRequestEmail(tour, broker.name));
  }
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
  let tours;
  if (req.user.role === 'secretary') {
    const user = store.getUserById(req.user.sub);
    const teamMembers = store.getUsersByInmobiliaria(user.inmobiliaria_id);
    const teamIds = new Set(teamMembers.map(m => m.id));
    tours = store.getTours().filter(t => teamIds.has(t.broker_id));
  } else {
    tours = store.getToursByBroker(req.user.sub);
  }
  tours.sort((a, b) => b.created_at.localeCompare(a.created_at));
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
  if (!canManageTour(req.user, tour)) return res.status(403).json({ error: 'No autorizado' });

  const { status, notes, virtual_link } = req.body;
  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status debe ser "confirmed" o "rejected"' });
  }

  tour.status      = status;
  tour.broker_notes = notes || tour.broker_notes;
  if (virtual_link !== undefined) tour.virtual_link = virtual_link;
  tour.updated_at  = new Date().toISOString();
  store.saveTour(tour);

  // Push notification → client
  if (tour.client_id) {
    pushNotify(tour.client_id, {
      type: 'tour_update',
      title: status === 'confirmed' ? 'Visita Confirmada ✓' : 'Visita Rechazada',
      body: status === 'confirmed'
        ? `Tu visita a ${tour.listing_title} el ${tour.requested_date} a las ${tour.requested_time} fue confirmada`
        : `Tu visita a ${tour.listing_title} fue rechazada${notes ? ': ' + notes : ''}`,
      url: '/profile',
    });
  }

  // Email → client
  const brokerUser = store.getUserById(req.user.sub);
  const clientEmail = tour.client_email || (tour.client_id ? store.getUserById(tour.client_id)?.email : null);
  if (clientEmail) {
    const emailHtml = status === 'confirmed'
      ? tourConfirmedEmail(tour, brokerUser?.name || 'el agente')
      : tourRejectedEmail(tour, brokerUser?.name || 'el agente');
    sendTourEmail(clientEmail, status === 'confirmed'
      ? `Visita confirmada — ${tour.listing_title}`
      : `Visita no disponible — ${tour.listing_title}`, emailHtml);
  }

  res.json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// BOTH: Cancel a tour
// PUT /api/tours/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/cancel', userAuth, (req, res) => {
  const tour = store.getTourById(req.params.id);
  if (!tour) return res.status(404).json({ error: 'Visita no encontrada' });

  // Only broker (or secretary on team) or the requesting client can cancel
  if (!canManageTour(req.user, tour) && tour.client_id !== req.user.sub) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  tour.status     = 'cancelled';
  tour.updated_at = new Date().toISOString();
  store.saveTour(tour);

  // Push notification → the other party
  const cancelledByBroker = tour.broker_id === req.user.sub;
  if (cancelledByBroker && tour.client_id) {
    pushNotify(tour.client_id, {
      type: 'tour_update',
      title: 'Visita Cancelada',
      body: `La visita a ${tour.listing_title} el ${tour.requested_date} fue cancelada por el agente`,
      url: '/profile',
    });
  } else if (!cancelledByBroker) {
    pushNotify(tour.broker_id, {
      type: 'tour_update',
      title: 'Visita Cancelada',
      body: `${tour.client_name} canceló la visita a ${tour.listing_title} del ${tour.requested_date}`,
      url: '/broker.html',
    });
  }

  // Email → the other party
  const cancelHtml = tourCancelledEmail(tour, cancelledByBroker);
  if (cancelledByBroker) {
    const clientEmail = tour.client_email || (tour.client_id ? store.getUserById(tour.client_id)?.email : null);
    if (clientEmail) sendTourEmail(clientEmail, `Visita cancelada — ${tour.listing_title}`, cancelHtml);
  } else {
    const broker = store.getUserById(tour.broker_id);
    if (broker?.email) sendTourEmail(broker.email, `Visita cancelada — ${tour.listing_title}`, cancelHtml);
  }

  res.json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// BOTH: Reschedule a tour
// PUT /api/tours/:id/reschedule
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/reschedule', userAuth, (req, res) => {
  const tour = store.getTourById(req.params.id);
  if (!tour) return res.status(404).json({ error: 'Visita no encontrada' });

  // Only broker (or secretary on team) or requesting client can reschedule
  if (!canManageTour(req.user, tour) && tour.client_id !== req.user.sub) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  // Can only reschedule pending or confirmed tours
  if (!['pending', 'confirmed'].includes(tour.status)) {
    return res.status(400).json({ error: 'Solo se pueden reprogramar visitas pendientes o confirmadas' });
  }

  const { date, time } = req.body;
  if (!date || !time) {
    return res.status(400).json({ error: 'Campos requeridos: date, time' });
  }

  // Prevent rescheduling to a past date
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return res.status(400).json({ error: 'No se puede reprogramar a una fecha pasada.' });
  }

  // Verify new slot is available
  const available = generateSlots(tour.broker_id, date);
  if (!available.some(s => s.time === time)) {
    return res.status(409).json({ error: 'Este horario ya no está disponible. Por favor selecciona otro.' });
  }

  const oldDate = tour.requested_date;
  const oldTime = tour.requested_time;

  tour.requested_date = date;
  tour.requested_time = time;
  tour.status         = 'pending'; // reset to pending for re-confirmation
  tour.updated_at     = new Date().toISOString();
  store.saveTour(tour);

  const rescheduledByBroker = tour.broker_id === req.user.sub;
  const rescheduleHtml = tourRescheduledEmail(tour, oldDate, oldTime, rescheduledByBroker);

  // Notify the other party
  if (rescheduledByBroker && tour.client_id) {
    pushNotify(tour.client_id, {
      type: 'tour_update',
      title: 'Visita Reprogramada',
      body: `Tu visita a ${tour.listing_title} fue reprogramada al ${date} a las ${time}`,
      url: '/profile',
    });
    const clientEmail = tour.client_email || (tour.client_id ? store.getUserById(tour.client_id)?.email : null);
    if (clientEmail) sendTourEmail(clientEmail, `Visita reprogramada — ${tour.listing_title}`, rescheduleHtml);
  } else if (!rescheduledByBroker) {
    pushNotify(tour.broker_id, {
      type: 'tour_update',
      title: 'Visita Reprogramada',
      body: `${tour.client_name} reprogramó la visita a ${tour.listing_title} al ${date} a las ${time}`,
      url: '/broker.html',
    });
    const broker = store.getUserById(tour.broker_id);
    if (broker?.email) sendTourEmail(broker.email, `Visita reprogramada — ${tour.listing_title}`, rescheduleHtml);
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Mark tour as completed
// PUT /api/tours/:id/complete
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/complete', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const tour = store.getTourById(req.params.id);
  if (!tour) return res.status(404).json({ error: 'Visita no encontrada' });
  if (!canManageTour(req.user, tour)) return res.status(403).json({ error: 'No autorizado' });
  if (tour.status !== 'confirmed') {
    return res.status(400).json({ error: 'Solo se pueden completar visitas confirmadas' });
  }

  tour.status       = 'completed';
  tour.completed_at = new Date().toISOString();
  tour.updated_at   = new Date().toISOString();
  store.saveTour(tour);

  // Notify client to leave feedback
  if (tour.client_id) {
    pushNotify(tour.client_id, {
      type: 'tour_update',
      title: 'Visita Completada',
      body: `¿Cómo fue tu visita a ${tour.listing_title}? Déjanos tu opinión.`,
      url: '/profile',
    });
  }

  res.json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT: Leave feedback on a completed tour
// POST /api/tours/:id/feedback
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/feedback', userAuth, (req, res) => {
  const tour = store.getTourById(req.params.id);
  if (!tour) return res.status(404).json({ error: 'Visita no encontrada' });
  if (tour.client_id !== req.user.sub) return res.status(403).json({ error: 'No autorizado' });
  if (tour.status !== 'completed') {
    return res.status(400).json({ error: 'Solo se puede calificar visitas completadas' });
  }
  if (tour.feedback_rating) {
    return res.status(400).json({ error: 'Ya dejaste una calificación para esta visita' });
  }

  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'La calificación debe ser entre 1 y 5' });
  }

  // Double-check to prevent race condition
  const freshTour = store.getTourById(req.params.id);
  if (freshTour.feedback_rating) {
    return res.status(400).json({ error: 'Ya dejaste una calificación para esta visita' });
  }

  tour.feedback_rating  = Math.round(rating);
  tour.feedback_comment = (comment || '').slice(0, 500);
  tour.feedback_at      = new Date().toISOString();
  tour.updated_at       = new Date().toISOString();
  store.saveTour(tour);

  // Notify broker
  pushNotify(tour.broker_id, {
    type: 'tour_update',
    title: 'Nueva Calificación',
    body: `${tour.client_name} calificó la visita a ${tour.listing_title} con ${tour.feedback_rating}/5`,
    url: '/broker.html',
  });

  res.json(tour);
});

// ─────────────────────────────────────────────────────────────────────────────
// Get tours linked to an application
// GET /api/tours/by-application/:appId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/by-application/:appId', userAuth, (req, res) => {
  const tours = store.getTours().filter(t => t.application_id === req.params.appId);
  // Only return tours the user is involved in (as broker, team member, or client)
  const filtered = tours.filter(t =>
    t.client_id === req.user.sub || canManageTour(req.user, t)
  );
  res.json(filtered);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Toggle auto-confirm setting
// PUT /api/tours/settings/auto-confirm
// ─────────────────────────────────────────────────────────────────────────────
router.put('/settings/auto-confirm', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  user.auto_confirm_tours = !!req.body.enabled;
  store.saveUser(user);
  res.json({ auto_confirm_tours: user.auto_confirm_tours });
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER: Get tour settings
// GET /api/tours/settings
// ─────────────────────────────────────────────────────────────────────────────
router.get('/settings', userAuth, (req, res) => {
  if (!BROKER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const user = store.getUserById(req.user.sub);
  res.json({ auto_confirm_tours: !!user?.auto_confirm_tours });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tours/badge-count — Pending tours awaiting broker action
// ─────────────────────────────────────────────────────────────────────────────
// Drives the "Visitas" nav badge. Counts tours in `pending` status scoped
// by role: brokers see their own assignments; secretaries / inmobiliaria
// / constructora users see the team's pending requests.
router.get('/badge-count', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.json({ count: 0 });

  let tours;
  if (user.role === 'inmobiliaria' || user.role === 'constructora') {
    const teamIds = new Set(store.getUsersByInmobiliaria(user.id).map(m => m.id));
    teamIds.add(user.id);
    tours = store.getTours().filter(t => teamIds.has(t.broker_id));
  } else if (user.role === 'secretary' && user.inmobiliaria_id) {
    const teamIds = new Set(store.getUsersByInmobiliaria(user.inmobiliaria_id).map(m => m.id));
    teamIds.add(user.inmobiliaria_id);
    tours = store.getTours().filter(t => teamIds.has(t.broker_id));
  } else if (BROKER_ROLES.includes(user.role)) {
    tours = store.getToursByBroker(user.id);
  } else {
    // Clients: count their own pending tour requests too.
    tours = store.getToursByClient(user.id);
  }

  const count = tours.filter(t => t.status === 'pending').length;
  res.json({ count });
});

module.exports = router;
