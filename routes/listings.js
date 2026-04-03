const express      = require('express');
const nodemailer   = require('nodemailer');
const store        = require('./store');
const router       = express.Router();

// ── Public view-counter rate limiter ────────────────────────────────────────
// One view increment per IP per listing per hour (no auth required).
const _viewSeen       = new Map(); // key: `${ip}::${listingId}` → last-seen ms
const VIEW_COOLDOWN   = 60 * 60 * 1000; // 1 hour
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

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

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const total = listings.length;
  const items = listings.slice((page - 1) * limit, page * limit);

  res.json({ listings: items, total, page, limit, pages: Math.ceil(total / limit) });
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

  res.json({ listings });
});

// GET /api/listings/agent/:refToken — public: resolve affiliate token to agent name/agency
router.get('/agent/:refToken', (req, res) => {
  const agent = store.getUserByRefToken(req.params.refToken);
  if (!agent || agent.role !== 'agency')
    return res.status(404).json({ error: 'Agente no encontrado' });
  res.json({ name: agent.name, agencyName: agent.agencyName });
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

  res.json({ name: agencyName, slug, refToken, listings: items, total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/listings/:id
router.get('/:id', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });
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

  // If refToken provided, route ONLY to that agent
  let agencyEmails = [];
  let agencyNames  = 'las inmobiliarias afiliadas';
  const refAgent   = refToken ? store.getUserByRefToken(refToken) : null;

  if (refAgent && refAgent.role === 'agency') {
    agencyEmails = [refAgent.email];
    agencyNames  = `${refAgent.name} de ${refAgent.agencyName}`;
  } else {
    const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
    agencyEmails   = agencies.map(a => a.email).filter(Boolean);
    agencyNames    = agencies.map(a => a.name).join(', ') || 'las inmobiliarias afiliadas';
    if (!agencyEmails.length && listing.email) agencyEmails.push(listing.email);
  }
  const listingUrl  = `${process.env.BASE_URL || 'http://localhost:3000'}/listing/${listing.id}`;

  const agentHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
      <div style="background:#002D62;padding:24px 32px;">
        <h2 style="color:#fff;margin:0;font-size:1.2rem;">Nueva Consulta — HogaresRD</h2>
        <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:0.88rem;">${listing.title}</p>
      </div>
      <div style="padding:28px 32px;background:#fff;">
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <tr><td style="padding:8px 0;color:#4d6a8a;width:35%;">Cliente</td><td style="padding:8px 0;font-weight:700;">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#4d6a8a;">Teléfono</td><td style="padding:8px 0;"><a href="tel:${phone}" style="color:#002D62;">${phone}</a></td></tr>
          <tr><td style="padding:8px 0;color:#4d6a8a;">Correo</td><td style="padding:8px 0;"><a href="mailto:${email}" style="color:#002D62;">${email}</a></td></tr>
          ${message ? `<tr><td style="padding:8px 0;color:#4d6a8a;vertical-align:top;">Mensaje</td><td style="padding:8px 0;">${message}</td></tr>` : ''}
        </table>
        <div style="margin-top:24px;padding:12px 16px;background:#f0f4f9;border-radius:8px;font-size:0.82rem;color:#4d6a8a;">
          Esta consulta fue enviada simultáneamente a todas las inmobiliarias afiliadas al proyecto. El primer agente en contactar al cliente tiene ventaja.
        </div>
        <div style="margin-top:20px;">
          <a href="${listingUrl}" style="background:#002D62;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.88rem;display:inline-block;">Ver anuncio →</a>
        </div>
      </div>
      <div style="padding:14px 32px;background:#f0f4f9;font-size:0.78rem;color:#4d6a8a;">
        HogaresRD · Consulta recibida el ${new Date().toLocaleString('es-DO')}
      </div>
    </div>`;

  const clientHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
      <div style="background:#002D62;padding:24px 32px;">
        <h2 style="color:#fff;margin:0;font-size:1.2rem;">¡Consulta recibida! 🏠</h2>
        <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:0.88rem;">HogaresRD</p>
      </div>
      <div style="padding:28px 32px;background:#fff;">
        <p style="font-size:0.95rem;color:#1a2e44;">Hola <strong>${name}</strong>,</p>
        <p style="font-size:0.9rem;color:#4d6a8a;line-height:1.6;">Tu consulta sobre <strong>${listing.title}</strong> fue enviada exitosamente a ${agencyNames}. Un agente se pondrá en contacto contigo pronto al número <strong>${phone}</strong>.</p>
        <div style="margin-top:20px;">
          <a href="${listingUrl}" style="background:#002D62;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.88rem;display:inline-block;">Ver propiedad →</a>
        </div>
      </div>
      <div style="padding:14px 32px;background:#f0f4f9;font-size:0.78rem;color:#4d6a8a;">HogaresRD · Bienes raíces en la República Dominicana</div>
    </div>`;

  try {
    const sends = agencyEmails.map(to =>
      transporter.sendMail({
        from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
        to,
        replyTo: email,
        subject: `Nueva consulta: ${listing.title}`,
        html:    agentHtml,
      })
    );
    sends.push(transporter.sendMail({
      from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
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

module.exports = router;
