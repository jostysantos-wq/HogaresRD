require('dotenv').config();
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const cron       = require('node-cron');
const { router: newsletterRouter, sendNewsletter } = require('./routes/newsletter');

const app  = express();
const PORT = process.env.PORT || 3000;
const SUBMISSIONS_FILE = path.join(__dirname, 'data', 'submissions.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'hogaresrd-admin-2026';
const ADMIN_EMAIL = 'Jostysantos@gmail.com';

// ── Ensure data dir & seed files ───────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
[
  SUBMISSIONS_FILE,
  path.join(__dirname, 'data', 'users.json'),
  path.join(__dirname, 'data', 'activity.json'),
].forEach(f => { if (!fs.existsSync(f)) fs.writeFileSync(f, '[]'); });

// ── Seed demo listings ─────────────────────────────────────────
(function seedListings() {
  const seedFile = path.join(__dirname, 'seeds', 'listings.json');
  if (!fs.existsSync(seedFile)) return;
  const seeds = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const submissions = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
  const existingIds = new Set(submissions.map(s => s.id));
  let changed = false;
  seeds.forEach(seed => {
    if (!existingIds.has(seed.id)) {
      submissions.push(seed);
      changed = true;
    }
  });
  if (changed) fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(submissions, null, 2));
})();

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

// ── Photo upload (multer) ──────────────────────────────────────
const PHOTOS_DIR = path.join(__dirname, 'public', 'uploads', 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `ph_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits:  { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpe?g|png|webp)$/i.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Solo se permiten imágenes JPG, PNG o WEBP'));
  },
});

// ── Blueprint upload (multer) ──────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'blueprints');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const blueprintStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `bp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const blueprintUpload = multer({
  storage: blueprintStorage,
  limits:  { fileSize: 10 * 1024 * 1024, files: 5 }, // 10 MB per file, max 5
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpe?g|png|webp|gif|pdf)$/i;
    if (allowed.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Tipo de archivo no permitido'));
  },
});

// ── Middleware ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ─────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/listings',   require('./routes/listings'));
app.use('/api/user',       require('./routes/user'));
app.use('/api/newsletter', newsletterRouter);

// ── Photo upload endpoint ──────────────────────────────────────
app.post('/api/upload/photos', photoUpload.array('photos', 5), (req, res) => {
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No se recibieron imágenes.' });
  const urls = req.files.map(f => `/uploads/photos/${f.filename}`);
  res.json({ urls });
}, (err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// ── Blueprint upload endpoint ──────────────────────────────────
app.post('/api/upload/blueprints', blueprintUpload.array('blueprints', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No se recibieron archivos.' });
  }
  const urls = req.files.map(f => `/uploads/blueprints/${f.filename}`);
  res.json({ urls });
}, (err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

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

app.get('/login',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/register-agency',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-agency.html')));
app.get('/reset-password',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/forgot-password',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/terminos-usuario',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-usuario.html')));
app.get('/terminos-agente',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-agente.html')));
app.get('/terminos-publicacion', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-publicacion.html')));
app.get('/about',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/comprar',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'comprar.html')));
app.get('/alquilar',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'alquilar.html')));
app.get('/nuevos-proyectos',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'nuevos-proyectos.html')));
app.get('/profile',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/listing/:id',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'listing.html')));
app.get('/inmobiliaria/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inmobiliaria.html')));
app.get('/ciudades',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'ciudades.html')));
app.get('/ciudad/:slug',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'ciudad.html')));

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
    blueprints:         isClaim ? [] : (Array.isArray(body.blueprints) ? body.blueprints : (body.blueprints ? [body.blueprints] : [])),
    images:             isClaim ? [] : (Array.isArray(body.images) ? body.images : []),
    tags:               isClaim ? [] : (Array.isArray(body.tags) ? body.tags : (body.tags ? [body.tags] : [])),
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

// ── Unsubscribe ────────────────────────────────────────────────
app.get('/unsubscribe', (req, res) => {
  const store = require('./routes/store');
  const token = req.query.token || '';
  let userId;
  try { userId = Buffer.from(token, 'base64').toString('utf8'); } catch { userId = ''; }
  const user = store.getUsers().find(u => u.id === userId);
  if (!user) {
    return res.status(400).send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>HogaresRD</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 20px;color:#1a2b40;"><h2>Enlace inválido o expirado.</h2><p><a href="/home">Volver al inicio</a></p></body></html>`);
  }
  store.saveUser({ ...user, marketingOptIn: false });
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>HogaresRD — Cancelar suscripción</title></head><body style="font-family:'Segoe UI',sans-serif;text-align:center;padding:80px 20px;background:#eef3fa;color:#1a2b40;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:48px 40px;box-shadow:0 4px 24px rgba(0,45,98,0.10);"><div style="font-size:2.5rem;margin-bottom:16px;">✉️</div><h2 style="font-size:1.4rem;font-weight:800;color:#002D62;margin-bottom:12px;">Suscripción cancelada</h2><p style="color:#4d6a8a;line-height:1.7;margin-bottom:28px;">Has sido eliminado de nuestra lista de correos. Ya no recibirás actualizaciones del mercado inmobiliario de HogaresRD.</p><a href="/home" style="display:inline-block;background:#002D62;color:#fff;font-weight:700;padding:12px 32px;border-radius:8px;text-decoration:none;">Volver al inicio</a></div></body></html>`);
});

// ── Daily newsletter cron (8 AM Dominican Time = UTC-4 → 12:00 UTC) ────────
cron.schedule('0 12 * * *', () => {
  console.log('[Cron] Sending daily newsletter…');
  sendNewsletter()
    .then(r => console.log('[Cron] Newsletter done:', r))
    .catch(e => console.error('[Cron] Newsletter error:', e.message));
}, { timezone: 'America/Santo_Domingo' });

// ── Global error handler (keeps all errors as JSON, never HTML) ────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`HogaresRD running at http://localhost:${PORT}`);
});
