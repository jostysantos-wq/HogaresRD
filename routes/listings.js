const express      = require('express');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');
const { userAuth } = require('./auth');
const router       = express.Router();

// Cache favorite counts (refreshed every 60s to avoid scanning all users per request)
let _favCache = {};
let _favCacheAt = 0;
function getFavoriteCounts() {
  if (Date.now() - _favCacheAt < 60_000) return _favCache;
  const counts = {};
  store.getUsers().forEach(u => {
    if (Array.isArray(u.favorites)) {
      u.favorites.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    }
  });
  _favCache = counts;
  _favCacheAt = Date.now();
  return counts;
}

function attachFavCounts(listings) {
  const counts = getFavoriteCounts();
  return listings.map(l => ({ ...l, favoriteCount: counts[l.id] || 0 }));
}

// ── Public view-counter rate limiter ────────────────────────────────────────
// One view increment per IP per listing per hour (no auth required).
const _viewSeen       = new Map(); // key: `${ip}::${listingId}` → last-seen ms
const VIEW_COOLDOWN   = 60 * 60 * 1000; // 1 hour
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

const { createTransport } = require('./mailer');
const transporter = createTransport();

// GET /api/listings?q=&province=&city=&type=&condition=&propertyType=&priceMin=&priceMax=&bedroomsMin=&tags=&page=&limit=
router.get('/', (req, res) => {
  const filters = {
    q:           req.query.q           || '',
    province:    req.query.province    || '',
    city:        req.query.city        || '',
    type:        req.query.type        || '',
    condition:   req.query.condition   || '',
    propertyType:req.query.propertyType|| '',
    priceMin:    req.query.priceMin    || '',
    priceMax:    req.query.priceMax    || '',
    bedroomsMin: req.query.bedroomsMin || '',
  };

  // Remove empty filters so store.getListings doesn't filter needlessly
  Object.keys(filters).forEach(k => { if (!filters[k]) delete filters[k]; });

  let listings = store.getListings(filters);

  // Tag filter (comma-separated, match ANY)
  if (req.query.tags) {
    const wanted = req.query.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (wanted.length) {
      listings = listings.filter(l =>
        Array.isArray(l.tags) && wanted.some(t => l.tags.includes(t))
      );
    }
  }

  // Agency filter (by slug)
  if (req.query.agency) {
    const slug = req.query.agency;
    listings = listings.filter(l =>
      (l.agencies || []).some(a =>
        a.name && a.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
      )
    );
  }

  // Constructora filter (by slug)
  if (req.query.constructora) {
    const slug = req.query.constructora;
    listings = listings.filter(l =>
      l.construction_company &&
      l.construction_company.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
    );
  }

  // Sort: newest approved first
  listings.sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt));

  // Pagination — clamp to safe ranges so bad query params can't produce
  // NaN/negative slice indices or huge pages.
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const total = listings.length;
  const items = listings.slice((page - 1) * limit, page * limit);

  res.json({ listings: attachFavCounts(items), total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/listings/trending — top 8 by combined score: total public views + recent auth views (3×)
router.get('/trending', (req, res) => {
  const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = store.getListingActivity(since);

  // Recent authenticated-user views (last 7 days) — weighted 3× for recency signal
  const recentCounts = {};
  events.forEach(e => { recentCounts[e.listingId] = (recentCounts[e.listingId] || 0) + 1; });

  const listings = store.getListings()
    .map(l => {
      const totalViews  = l.views || 0;
      const recentViews = recentCounts[l.id] || 0;
      return { ...l, _views: totalViews, _score: totalViews + recentViews * 3 };
    })
    .filter(l => l._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8);

  res.json({ listings: attachFavCounts(listings) });
});

// GET /api/listings/agent/:refToken — public: resolve affiliate token to agent name/agency
router.get('/agent/:refToken', (req, res) => {
  const agent = store.getUserByRefToken(req.params.refToken);
  const agentRoles = ['agency', 'broker', 'inmobiliaria', 'constructora'];
  if (!agent || !agentRoles.includes(agent.role))
    return res.status(404).json({ error: 'Agente no encontrado' });
  res.json({ name: agent.name, agencyName: agent.agencyName || agent.companyName || agent.name });
});

// GET /api/agencies — list all agencies with listing counts
router.get('/agencies', (req, res) => {
  const listings = store.getListings();
  const map = {};
  listings.forEach(l => {
    (l.agencies || []).forEach(a => {
      if (!a.name) return;
      const slug = String(a.name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!map[slug]) map[slug] = { name: a.name, slug, count: 0 };
      map[slug].count++;
    });
  });
  const agencies = Object.values(map).sort((a, b) => b.count - a.count);
  res.json({ agencies });
});

// GET /api/listings/constructoras — list all construction companies with listing counts
router.get('/constructoras', (req, res) => {
  const listings = store.getListings();
  const map = {};
  listings.forEach(l => {
    if (!l.construction_company) return;
    const name = String(l.construction_company);
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!map[slug]) map[slug] = { name, slug, count: 0 };
    map[slug].count++;
  });
  const constructoras = Object.values(map).sort((a, b) => b.count - a.count);
  res.json({ constructoras });
});

// GET /api/agencies/:slug — agency details + their listings
router.get('/agencies/:slug', (req, res) => {
  const { slug } = req.params;
  const listings = store.getListings();
  const matched = listings.filter(l =>
    (l.agencies || []).some(a =>
      a.name && a.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
    )
  );
  if (!matched.length) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });
  const agencyObj = matched[0].agencies.find(a =>
    a.name && a.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
  );
  if (!agencyObj) return res.status(404).json({ error: 'Agencia no encontrada' });
  const agencyName = agencyObj.name;

  // Look up the registered user for this agency to get their refToken
  const agencyUser = agencyObj.email ? store.getUserByEmail(agencyObj.email) : null;
  const refToken   = agencyUser?.refToken || null;

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 12);
  const total = matched.length;
  const items = matched.slice((page - 1) * limit, page * limit);

  res.json({ name: agencyName, slug, refToken, listings: attachFavCounts(items), total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/listings/:id
// Approved listings are visible to everyone. Non-approved listings
// (pending / edits_requested / rejected) are only returned to their
// owner or an admin so the owner can re-edit & resubmit them.
router.get('/:id', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  if (listing.status === 'approved') {
    return res.json(listing);
  }

  // Non-approved: require auth and ownership (or admin)
  const { verifyJWT } = require('./auth');
  let user = null;
  try {
    const token = req.cookies?.hrdt || (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (token) {
      const payload = verifyJWT(token);
      user = store.getUserById(payload.sub);
    }
  } catch {}

  if (!user) return res.status(404).json({ error: 'Propiedad no encontrada' });

  const isOwner = listing.creator_user_id === user.id
               || (listing.email && listing.email.toLowerCase() === (user.email || '').toLowerCase());
  const isAdmin = user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return res.status(404).json({ error: 'Propiedad no encontrada' });
  }

  res.json(listing);
});

// POST /api/listings/:id/view — public, anonymous view counter (rate-limited per IP per hour)
router.post('/:id/view', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Not found' });

  const ip  = clientIp(req);
  const key = `${ip}::${listing.id}`;
  const now = Date.now();

  if ((now - (_viewSeen.get(key) || 0)) > VIEW_COOLDOWN) {
    _viewSeen.set(key, now);
    listing.views = (listing.views || 0) + 1;
    store.saveListing(listing);
  }

  res.json({ views: listing.views || 0 });
});

// POST /api/listings/:id/inquiry — send client inquiry to all affiliated agencies
router.post('/:id/inquiry', async (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const { name, phone, email, message, refToken } = req.body;
  if (!name || !phone || !email)
    return res.status(400).json({ error: 'Nombre, teléfono y correo son requeridos' });

  // Prevent self-inquiry — user can't send inquiry to themselves
  const submitterEmail = email.toLowerCase().trim();
  const ownerEmails = new Set();
  if (listing.email) ownerEmails.add(listing.email.toLowerCase());
  if (Array.isArray(listing.agencies)) {
    listing.agencies.forEach(a => { if (a.email) ownerEmails.add(a.email.toLowerCase()); });
  }
  if (ownerEmails.has(submitterEmail)) {
    return res.status(400).json({ error: 'No puedes enviar una consulta sobre tu propia propiedad.' });
  }

  // If refToken provided, route to referring agent (or org's agents for inmobiliaria)
  let agencyEmails = [];
  let agencyNames  = 'las inmobiliarias afiliadas';
  const refAgent   = refToken ? store.getUserByRefToken(refToken) : null;
  const agentRoles = ['agency', 'broker'];
  const orgRoles   = ['inmobiliaria', 'constructora'];

  if (refAgent && agentRoles.includes(refAgent.role)) {
    // Individual agent — route directly to them
    agencyEmails = [refAgent.email];
    agencyNames  = `${refAgent.name}${refAgent.agencyName ? ' de ' + refAgent.agencyName : ''}`;
  } else if (refAgent && orgRoles.includes(refAgent.role)) {
    // Inmobiliaria/Constructora — route to ALL agents in the organization
    const teamMembers = store.getUsersByInmobiliaria(refAgent.id);
    agencyEmails = [refAgent.email, ...teamMembers.map(m => m.email)].filter(Boolean);
    agencyEmails = [...new Set(agencyEmails)]; // dedupe
    agencyNames  = refAgent.companyName || refAgent.name;
  } else {
    // No valid refToken — fall back to listing's affiliated agencies
    const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
    agencyEmails   = agencies.map(a => a.email).filter(Boolean);
    agencyNames    = agencies.map(a => a.name).join(', ') || 'las inmobiliarias afiliadas';
    if (!agencyEmails.length && listing.email) agencyEmails.push(listing.email);
  }
  const listingUrl  = `${process.env.BASE_URL || 'http://localhost:3000'}/listing/${listing.id}`;

  const et = require('../utils/email-templates');
  const agentHtml = et.layout({
    title: 'Nueva consulta recibida',
    subtitle: listing.title,
    body: et.p('Un cliente esta interesado en esta propiedad.')
        + et.infoTable(
            et.infoRow('Cliente', name)
          + et.infoRow('Telefono', `<a href="tel:${phone}" style="color:#002D62;font-weight:700;">${phone}</a>`)
          + et.infoRow('Correo', `<a href="mailto:${email}" style="color:#002D62;">${email}</a>`)
          + (message ? et.infoRow('Mensaje', message) : '')
        )
        + et.alertBox('Esta consulta fue enviada a todas las inmobiliarias afiliadas. El primer agente en contactar al cliente tiene ventaja.', 'info')
        + et.button('Ver anuncio', listingUrl),
  });

  const clientHtml = et.layout({
    title: 'Consulta recibida',
    subtitle: 'HogaresRD',
    body: et.p('Hola <strong>' + et.esc(name) + '</strong>,')
        + et.p('Tu consulta sobre <strong>' + et.esc(listing.title) + '</strong> fue enviada exitosamente a ' + agencyNames + '. Un agente se pondra en contacto contigo pronto al numero <strong>' + phone + '</strong>.')
        + et.button('Ver propiedad', listingUrl)
        + et.divider()
        + et.small('Tambien puedes chatear directamente con el agente desde la pagina de la propiedad.'),
  });

  try {
    const sends = agencyEmails.map(to =>
      transporter.sendMail({
        to,
        subject: `Nueva consulta: ${listing.title}`,
        html:    agentHtml,
      })
    );
    sends.push(transporter.sendMail({
      to:      email,
      subject: '¡Tu consulta fue enviada! — HogaresRD',
      html:    clientHtml,
    }));
    await Promise.all(sends);
  } catch (err) {
    console.error('Inquiry email error:', err.message);
  }

  res.json({ success: true });
});

// ── PUT /api/listings/:id  — Owner edits their own listing ──────────────
// Allowed states for editing: 'pending', 'edits_requested', or 'approved'.
// - pending / edits_requested → after save, status flips to 'pending' so
//   the admin picks it back up in the moderation queue.
// - approved → saves in place; the change is live immediately. We still
//   log it in editsHistory so admins can audit.
router.put('/:id', userAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  const isAdmin  = user.role === 'admin';
  const isOwner  = listing.creator_user_id === user.id
                || (listing.email && user.email && listing.email.toLowerCase() === user.email.toLowerCase());

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'No autorizado para editar esta propiedad' });
  }

  const editableStates = ['pending', 'edits_requested', 'approved'];
  if (!editableStates.includes(listing.status)) {
    return res.status(400).json({ error: `No se puede editar una propiedad en estado '${listing.status}'` });
  }

  // ── Whitelist of editable fields ────────────────────────────────
  // Anything outside this list is ignored, so clients can't flip
  // ownership, status, or other admin-controlled flags. Field names
  // match the POST /submit handler so the edit form can reuse its
  // exact payload shape.
  const FIELDS = [
    // Basic
    'title', 'description', 'type', 'propertyType', 'condition',
    // Pricing
    'price', 'currency', 'priceDOP',
    // Specs
    'bedrooms', 'bathrooms', 'parking',
    'area_const', 'area_land',
    'floors', 'floor_num', 'yearBuilt',
    // Location
    'province', 'city', 'sector', 'address', 'referencePoint',
    'lat', 'lng',
    // Lists
    'amenities', 'tags', 'images', 'blueprints',
    // Project
    'construction_company', 'units_total', 'units_available',
    'delivery_date', 'project_stage', 'unit_types',
    // Agencies
    'agencies',
    // Submitter contact (matches POST /submit: name/email/phone/role)
    'name', 'email', 'phone', 'role', 'contact_pref',
  ];

  const incoming = req.body || {};
  const changes  = [];
  for (const key of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      const newVal = incoming[key];
      if (JSON.stringify(listing[key]) !== JSON.stringify(newVal)) {
        listing[key] = newVal;
        changes.push(key);
      }
    }
  }

  if (changes.length === 0) {
    return res.status(400).json({ error: 'No hay cambios que guardar' });
  }

  listing.updatedAt = new Date().toISOString();
  listing.editsHistory = Array.isArray(listing.editsHistory) ? listing.editsHistory : [];
  listing.editsHistory.push({
    at:      listing.updatedAt,
    by:      isAdmin ? 'admin' : user.id,
    byRole:  user.role,
    changes,
    fromStatus: listing.status,
  });

  const wasInReview = listing.status === 'edits_requested' || listing.status === 'pending';
  if (wasInReview) {
    // Resubmitting: go back into the admin queue and clear the edits note
    listing.status           = 'pending';
    listing.resubmittedAt    = listing.updatedAt;
    listing.rejectedAt       = null;
    // Keep editsReason for history but clear the "active" reminder so the
    // owner's banner disappears after resubmit.
    listing.editsReasonActive = false;
  }

  store.saveListing(listing);
  res.json({
    success: true,
    listing,
    requeued: wasInReview,
    changes,
  });
});

module.exports = router;
