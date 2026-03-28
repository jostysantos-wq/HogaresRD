const express      = require('express');
const nodemailer   = require('nodemailer');
const store        = require('./store');
const router       = express.Router();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// GET /api/listings?province=&city=&type=&condition=&priceMin=&priceMax=&bedroomsMin=&tags=&page=&limit=
router.get('/', (req, res) => {
  const filters = {
    province:    req.query.province    || '',
    city:        req.query.city        || '',
    type:        req.query.type        || '',
    condition:   req.query.condition   || '',
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

  // Sort: newest approved first
  listings.sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt));

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const total = listings.length;
  const items = listings.slice((page - 1) * limit, page * limit);

  res.json({ listings: items, total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/listings/trending — top 8 listings by view count in the last 7 days
router.get('/trending', (req, res) => {
  const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = store.getListingActivity(since);

  const counts = {};
  events.forEach(e => { counts[e.listingId] = (counts[e.listingId] || 0) + 1; });

  const listings = store.getListings()
    .filter(l => counts[l.id])
    .map(l => ({ ...l, _views: counts[l.id] }))
    .sort((a, b) => b._views - a._views)
    .slice(0, 8);

  res.json({ listings });
});

// GET /api/listings/:id
router.get('/:id', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });
  res.json(listing);
});

// POST /api/listings/:id/inquiry — send client inquiry to all affiliated agencies
router.post('/:id/inquiry', async (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const { name, phone, email, message } = req.body;
  if (!name || !phone || !email)
    return res.status(400).json({ error: 'Nombre, teléfono y correo son requeridos' });

  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  const agencyEmails = agencies.map(a => a.email).filter(Boolean);

  // Include developer email as fallback if no agencies
  if (!agencyEmails.length && listing.email) agencyEmails.push(listing.email);

  const agencyNames = agencies.map(a => a.name).join(', ') || 'las inmobiliarias afiliadas';
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
