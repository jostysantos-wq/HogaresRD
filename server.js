require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const SUBMISSIONS_FILE = path.join(__dirname, 'data', 'submissions.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'hogaresrd-admin-2026';
const ADMIN_EMAIL = 'Jostysantos@gmail.com';

// ── Ensure data dir ────────────────────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(SUBMISSIONS_FILE)) {
  fs.writeFileSync(SUBMISSIONS_FILE, '[]');
}

function readSubmissions() {
  return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
}
function writeSubmissions(data) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2));
}

// ── Email transporter ──────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin auth middleware ──────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key === ADMIN_KEY) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ── Routes ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/submit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'submit.html'));
});

app.post('/submit', async (req, res) => {
  const body = req.body;
  const isClaim = body.submission_type === 'agency_claim';

  const submission = {
    id:              Date.now().toString(),
    submission_type: isClaim ? 'agency_claim' : 'new_property',
    // Agency claim fields
    claim_listing_id: isClaim ? (body.claim_listing_id || '') : undefined,
    // Property fields (only for new_property)
    title:       isClaim ? '' : (body.title       || ''),
    type:        isClaim ? '' : (body.type         || ''),
    condition:   isClaim ? '' : (body.condition    || ''),
    description: isClaim ? '' : (body.description  || ''),
    price:       isClaim ? '' : (body.price        || ''),
    area_const:  isClaim ? '' : (body.area_const   || ''),
    area_land:   isClaim ? '' : (body.area_land    || ''),
    bedrooms:    isClaim ? '' : (body.bedrooms     || ''),
    bathrooms:   isClaim ? '' : (body.bathrooms    || ''),
    parking:     isClaim ? '' : (body.parking      || ''),
    province:    isClaim ? '' : (body.province     || ''),
    city:        isClaim ? '' : (body.city         || ''),
    sector:      isClaim ? '' : (body.sector       || ''),
    address:     isClaim ? '' : (body.address      || ''),
    amenities:          isClaim ? [] : (body.amenities         || []),
    construction_company: isClaim ? '' : (body.construction_company || ''),
    units_total:        isClaim ? '' : (body.units_total       || ''),
    units_available:    isClaim ? '' : (body.units_available   || ''),
    delivery_date:      isClaim ? '' : (body.delivery_date     || ''),
    project_stage:      isClaim ? '' : (body.project_stage     || ''),
    unit_types:         isClaim ? [] : (Array.isArray(body.unit_types) ? body.unit_types : []),
    lat:         isClaim ? '' : (body.lat          || ''),
    lng:         isClaim ? '' : (body.lng          || ''),
    // Agencies (present in both modes)
    agencies:    Array.isArray(body.agencies) ? body.agencies : [],
    // Submitter contact
    name:        body.name        || '',
    email:       body.email       || '',
    phone:       body.phone       || '',
    role:        body.role        || '',
    status:      'pending',
    submittedAt: new Date().toISOString(),
  };

  // Save to file
  const submissions = readSubmissions();
  submissions.push(submission);
  writeSubmissions(submissions);

  // Send notification email
  try {
    const amenitiesList = Array.isArray(submission.amenities)
      ? submission.amenities.join(', ')
      : submission.amenities;

    await transporter.sendMail({
      from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
      to:      ADMIN_EMAIL,
      subject: isClaim
        ? `🏢 Solicitud de agencia para anuncio #${submission.claim_listing_id}`
        : `🏠 Nueva propiedad para aprobar: ${submission.title}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
          <div style="background:#002D62;padding:24px 32px;">
            <h2 style="color:#fff;margin:0;font-size:1.3rem;">🏠 Nueva Propiedad para Aprobar</h2>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:0.9rem;">HogaresRD — Panel de Administración</p>
          </div>
          <div style="padding:28px 32px;background:#fff;">
            <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
              <tr><td style="padding:8px 0;color:#4d6a8a;width:40%;">Título</td><td style="padding:8px 0;font-weight:600;">${submission.title}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Tipo</td><td style="padding:8px 0;">${submission.type}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Precio</td><td style="padding:8px 0;font-weight:600;color:#002D62;">$${Number(submission.price).toLocaleString()}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Ubicación</td><td style="padding:8px 0;">${submission.city}, ${submission.province}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Habitaciones</td><td style="padding:8px 0;">${submission.bedrooms} hab. · ${submission.bathrooms} baños</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Amenidades</td><td style="padding:8px 0;">${amenitiesList || '—'}</td></tr>
              <tr style="border-top:1px solid #e8eef7;"><td style="padding:12px 0;color:#4d6a8a;">Contacto</td><td style="padding:12px 0;"><strong>${submission.name}</strong><br>${submission.email}<br>${submission.phone}</td></tr>
            </table>
            <div style="margin-top:24px;">
              <a href="http://localhost:${PORT}/admin" style="background:#002D62;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
                Ir al Panel de Aprobación →
              </a>
            </div>
          </div>
          <div style="padding:16px 32px;background:#f0f4f9;font-size:0.8rem;color:#4d6a8a;">
            Enviado el ${new Date(submission.submittedAt).toLocaleString('es-DO')} · ID: ${submission.id}
          </div>
        </div>
      `,
    });
    console.log(`Email sent for submission ${submission.id}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }

  res.json({ success: true, id: submission.id });
});

// ── Admin routes ───────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/submissions', adminAuth, (req, res) => {
  res.json(readSubmissions());
});

app.post('/admin/submissions/:id/approve', adminAuth, (req, res) => {
  const submissions = readSubmissions();
  const sub = submissions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });
  sub.status     = 'approved';
  sub.approvedAt = new Date().toISOString();
  writeSubmissions(submissions);
  res.json({ success: true });
});

app.post('/admin/submissions/:id/reject', adminAuth, (req, res) => {
  const submissions = readSubmissions();
  const sub = submissions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });
  sub.status     = 'rejected';
  sub.rejectedAt = new Date().toISOString();
  writeSubmissions(submissions);
  res.json({ success: true });
});

// Merge agency claim into target listing
app.post('/admin/submissions/:id/merge-agency', adminAuth, (req, res) => {
  const submissions = readSubmissions();
  const claim = submissions.find(s => s.id === req.params.id);
  if (!claim) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (claim.submission_type !== 'agency_claim') return res.status(400).json({ error: 'No es una solicitud de agencia' });

  const target = submissions.find(s => s.id === claim.claim_listing_id);
  if (!target) return res.status(404).json({ error: `Anuncio #${claim.claim_listing_id} no encontrado` });

  // Merge agencies from claim into target listing
  if (!Array.isArray(target.agencies)) target.agencies = [];
  const newAgencies = Array.isArray(claim.agencies) ? claim.agencies : [];
  target.agencies.push(...newAgencies);
  target.updatedAt = new Date().toISOString();

  // Mark claim as approved
  claim.status     = 'approved';
  claim.approvedAt = new Date().toISOString();

  writeSubmissions(submissions);
  res.json({ success: true, targetId: target.id });
});

app.listen(PORT, () => {
  console.log(`HogaresRD running at http://localhost:${PORT}`);
});
