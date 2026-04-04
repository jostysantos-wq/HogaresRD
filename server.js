require('dotenv').config();
// Force IPv4 for all DNS lookups — DigitalOcean droplets can't reach Gmail SMTP over IPv6
require('dns').setDefaultResultOrder('ipv4first');
const path       = require('path');
const fs         = require('fs');

// ── VAPID keys for Web Push ───────────────────────────────────
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const webpush = require('web-push');
  const vapidKeys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY  = vapidKeys.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  // Persist keys to .env so they survive restarts
  const envPath = path.join(__dirname, '.env');
  try {
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (!envContent.includes('VAPID_PUBLIC_KEY=')) {
      envContent += `\nVAPID_PUBLIC_KEY=${vapidKeys.publicKey}\nVAPID_PRIVATE_KEY=${vapidKeys.privateKey}\n`;
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('[vapid] Generated and saved VAPID keys to .env');
    }
  } catch (e) {
    console.warn('[vapid] Could not write VAPID keys to .env:', e.message);
  }
}

// ── Startup: fail fast if required secrets are missing ────────────
(function checkEnv() {
  const required = ['JWT_SECRET', 'ADMIN_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`\n❌  Missing required environment variables: ${missing.join(', ')}`);
    console.error('    Create a .env file with these values before starting the server.\n');
    process.exit(1);
  }
})();

// ── Ensure documents directory exists (uploads go to filesystem) ───────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DOCS_DIR = path.join(DATA_DIR, 'documents');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const nodemailer   = require('nodemailer');
const multer       = require('multer');
const cron         = require('node-cron');
const { router: newsletterRouter, sendNewsletter } = require('./routes/newsletter');
const { router: savedSearchRouter, checkSavedSearchMatches } = require('./routes/saved-searches');

const store = require('./routes/store');
const errorTracker = require('./routes/error-tracker');
errorTracker.initProcessHandlers();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (behind Nginx/Cloudflare) ─────────────────────
// Required for correct req.ip, rate limiter, and secure cookies
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
const ADMIN_KEY = process.env.ADMIN_KEY; // enforced present by checkEnv() above
const ADMIN_EMAIL = 'Jostysantos@gmail.com';

// ── Seed demo listings ─────────────────────────────────────────
(function seedListings() {
  const seedFile = path.join(__dirname, 'seeds', 'listings.json');
  if (!fs.existsSync(seedFile)) return;
  const seeds = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const existingIds = new Set(store.getAllSubmissions().map(s => s.id));
  seeds.forEach(seed => {
    if (!existingIds.has(seed.id)) {
      store.saveListing(seed);
    }
  });
})();

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

// ── CORS ───────────────────────────────────────────────────────
// Allowed origins: explicit list only — no wildcard in production.
// Add ALLOWED_ORIGINS to .env as a comma-separated list.
// In development (NODE_ENV !== 'production') localhost is always allowed.
const ALLOWED_ORIGINS = (() => {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  const defaults = process.env.NODE_ENV !== 'production'
    ? ['http://localhost:3000', 'http://127.0.0.1:3000']
    : [];
  return new Set([...fromEnv, ...defaults]);
})();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Same-origin requests (pages served by this Express app) carry no Origin header,
  // so no CORS headers are needed.
  if (origin) {
    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true'); // allow httpOnly cookie
      res.setHeader('Vary', 'Origin');
    }
    // Unrecognised origins get no CORS header → browser blocks them.
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// ── Security headers (helmet) ─────────────────────────────────────
// CSP is intentionally disabled for now — inline scripts are pervasive.
// All other headers (HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
// are active. Tighten CSP with nonces/hashes in a future sprint.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false, // pages embed cross-origin media
}));

app.use(cookieParser());

// ── Stripe webhook needs raw body — must come BEFORE express.json() ───────
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(errorTracker.requestTimer);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ─────────────────────────────────────────────────
app.use('/api/stripe',     require('./routes/stripe'));
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/listings',   require('./routes/listings'));
app.use('/api/user',       require('./routes/user'));
app.use('/api/newsletter', newsletterRouter);
app.use('/api/ads',        require('./routes/ads'));
app.use('/api/leads',         require('./routes/leads'));
app.use('/api/applications',  require('./routes/applications'));
app.use('/api/broker',        require('./routes/broker-dashboard'));
app.use('/api/inmobiliaria',  require('./routes/inmobiliaria'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/conversations', require('./routes/auth').userAuth, require('./routes/conversations'));
app.use('/api/webhooks/meta', require('./routes/meta-webhook'));
app.use('/api/tours',         require('./routes/tours'));
app.use('/api/listing-analytics', require('./routes/listing-analytics'));
app.use('/api/push',              require('./routes/push').router);
app.use('/api/saved-searches',    savedSearchRouter);

// ── Public config endpoint (pixel ID is intentionally public) ─────────────
app.get('/api/config/meta', (req, res) => {
  const pixelId = process.env.META_PIXEL_ID;
  if (!pixelId) return res.json({ pixelId: null });
  res.json({ pixelId });
});

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

// ── Avatar upload (multer) ─────────────────────────────────────
const AVATARS_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `av_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits:  { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpe?g|png|webp)$/i.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Solo se permiten imágenes JPG, PNG o WEBP'));
  },
});

// POST /api/upload/avatar — authenticated, replaces user's profile picture
app.post('/api/upload/avatar', (req, res, next) => {
  const { userAuth } = require('./routes/auth');
  userAuth(req, res, next);
}, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen.' });
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Delete old avatar file if it exists
  if (user.avatarUrl && user.avatarUrl.startsWith('/uploads/avatars/')) {
    try { fs.unlinkSync(path.join(__dirname, 'public', user.avatarUrl)); } catch {}
  }

  user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
  store.saveUser(user);
  res.json({ success: true, avatarUrl: user.avatarUrl });
}, (err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// ── Admin auth — session-based (Option C) ─────────────────────
const {
  router:           adminAuthRouter,
  adminSessionAuth,
  adminSessionPage,
} = require('./routes/admin-auth');

const ADMIN_PATH = process.env.ADMIN_PATH;
if (!ADMIN_PATH) {
  console.error('❌  ADMIN_PATH env var is missing — admin panel disabled');
}

// Mount admin auth API under the secret path
if (ADMIN_PATH) {
  app.use(`/${ADMIN_PATH}`, adminAuthRouter);

  // Dashboard page — session gated (redirect to login if not authenticated)
  app.get(`/${ADMIN_PATH}`, adminSessionPage, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  // Login page — public (but secret URL)
  app.get(`/${ADMIN_PATH}/login`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
  });
}

// Legacy key-based check — kept only for internal server-to-server calls (cron, scripts)
// DO NOT expose this to the browser / admin UI
function adminKeyAuth(req, res, next) {
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
app.get('/register-user',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-user.html')));
app.get('/register-agency',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-agency.html')));
app.get('/register-broker',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-broker.html')));
app.get('/register-inmobiliaria',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-inmobiliaria.html')));
app.get('/register-secretary', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-secretary.html')));
app.get('/reset-password',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/forgot-password',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/terminos-usuario',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-usuario.html')));
app.get('/terminos-agente',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-agente.html')));
app.get('/terminos-publicacion', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-publicacion.html')));
app.get('/about',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/comprar',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'comprar.html')));
app.get('/alquilar',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'alquilar.html')));
app.get('/comparar',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'comparar.html')));
app.get('/busquedas-guardadas',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'busquedas-guardadas.html')));
app.get('/mapa',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'mapa.html')));
app.get('/nuevos-proyectos',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'nuevos-proyectos.html')));
app.get('/profile',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/listing/:id',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'listing.html')));
app.get('/inmobiliaria/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inmobiliaria.html')));
app.get('/ciudades',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'ciudades.html')));
app.get('/ciudad/:slug',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'ciudad.html')));
app.get('/contacto',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'contacto.html')));
app.get('/terminos',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos.html')));
app.get('/blog',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog.html')));
app.get('/broker',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'broker.html')));
app.get('/my-applications',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-applications.html')));
app.get('/verify-email',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'verify-email.html')));
app.get('/register-success',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-success.html')));
app.get('/subscribe',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscribe.html')));
app.get('/subscription',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscription.html')));
app.get('/mensajes',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'mensajes.html')));

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

  // Save to store
  store.saveListing(submission);

  // Send notification email
  try {
    const amenitiesList = Array.isArray(submission.amenities)
      ? submission.amenities.join(', ')
      : submission.amenities;

    const adminPanelUrl = `${process.env.BASE_URL || 'https://hogaresrd.com'}/${process.env.ADMIN_PATH || 'admin'}`;
    await transporter.sendMail({
      from:    `"HogaresRD Admin" <${process.env.EMAIL_USER}>`,
      to:      ADMIN_EMAIL,
      subject: isClaim
        ? `🔴 [IMPORTANTE] Solicitud de agencia — Anuncio #${submission.claim_listing_id}`
        : `🔴 [ACCIÓN REQUERIDA] Nueva propiedad para aprobar: ${submission.title}`,
      headers: {
        'X-Priority':        '1',
        'X-MSMail-Priority': 'High',
        'Importance':        'High',
      },
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
          <div style="background:#CF142B;padding:10px 32px;text-align:center;">
            <span style="color:#fff;font-size:0.78rem;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">⚑ Acción Requerida — Prioridad Alta</span>
          </div>
          <div style="background:#002D62;padding:24px 32px;">
            <h2 style="color:#fff;margin:0;font-size:1.3rem;">${isClaim ? '🏢 Solicitud de Agencia' : '🏠 Nueva Propiedad para Aprobar'}</h2>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:0.9rem;">HogaresRD — Panel de Administración</p>
          </div>
          <div style="padding:28px 32px;background:#fff;">
            <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
              ${isClaim ? `
              <tr><td style="padding:8px 0;color:#4d6a8a;width:40%;">Tipo</td><td style="padding:8px 0;font-weight:600;">Solicitud de Agencia</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Anuncio ID</td><td style="padding:8px 0;font-family:monospace;font-weight:600;">${submission.claim_listing_id}</td></tr>
              ` : `
              <tr><td style="padding:8px 0;color:#4d6a8a;width:40%;">Título</td><td style="padding:8px 0;font-weight:600;">${submission.title}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Tipo</td><td style="padding:8px 0;">${submission.type}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Precio</td><td style="padding:8px 0;font-weight:700;color:#002D62;font-size:1rem;">$${Number(submission.price).toLocaleString()}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Ubicación</td><td style="padding:8px 0;">${submission.city}, ${submission.province}</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Habitaciones</td><td style="padding:8px 0;">${submission.bedrooms} hab. · ${submission.bathrooms} baños</td></tr>
              <tr><td style="padding:8px 0;color:#4d6a8a;">Amenidades</td><td style="padding:8px 0;">${amenitiesList || '—'}</td></tr>
              `}
              <tr style="border-top:1px solid #e8eef7;">
                <td style="padding:12px 0;color:#4d6a8a;">Contacto</td>
                <td style="padding:12px 0;"><strong>${submission.name}</strong><br>${submission.email}<br>${submission.phone}</td>
              </tr>
            </table>
            <div style="margin-top:24px;text-align:center;">
              <a href="${adminPanelUrl}" style="background:#CF142B;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:1rem;">
                Revisar y Aprobar Ahora →
              </a>
            </div>
          </div>
          <div style="padding:16px 32px;background:#f0f4f9;font-size:0.8rem;color:#4d6a8a;text-align:center;">
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

// ── Admin API routes — protected by session cookie ─────────────
// /admin is kept as the API base (browser fetch calls go here).
// The dashboard HTML is served at /${ADMIN_PATH} (secret path, above).
// Old /admin page route is removed — /admin now returns 404 to scanners.

app.get('/admin/submissions', adminSessionAuth, (req, res) => {
  res.json(store.getAllSubmissions());
});

app.post('/admin/submissions/:id/approve', adminSessionAuth, (req, res) => {
  const sub = store.getListingById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });
  sub.status     = 'approved';
  sub.approvedAt = new Date().toISOString();
  store.saveListing(sub);
  res.json({ success: true });
});

app.post('/admin/submissions/:id/reject', adminSessionAuth, (req, res) => {
  const sub = store.getListingById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });
  sub.status     = 'rejected';
  sub.rejectedAt = new Date().toISOString();
  store.saveListing(sub);
  res.json({ success: true });
});

app.post('/admin/submissions/:id/merge-agency', adminSessionAuth, (req, res) => {
  const claim = store.getListingById(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (claim.submission_type !== 'agency_claim') return res.status(400).json({ error: 'No es una solicitud de agencia' });

  const target = store.getListingById(claim.claim_listing_id);
  if (!target) return res.status(404).json({ error: `Anuncio #${claim.claim_listing_id} no encontrado` });

  if (!Array.isArray(target.agencies)) target.agencies = [];
  const newAgencies = Array.isArray(claim.agencies) ? claim.agencies : [];
  target.agencies.push(...newAgencies);
  target.updatedAt = new Date().toISOString();
  store.saveListing(target);

  claim.status     = 'approved';
  claim.approvedAt = new Date().toISOString();
  store.saveListing(claim);

  res.json({ success: true, targetId: target.id });
});

// ── Users admin ────────────────────────────────────────────────────────────
app.get('/admin/users', adminSessionAuth, (req, res) => {
  const users = store.getUsers().map(u => {
    // Strip sensitive fields before sending to admin UI
    const { passwordHash, password, biometricTokenHash, refToken, ...safe } = u;
    return safe;
  });
  res.json(users);
});

app.post('/admin/users/:id/lock', adminSessionAuth, (req, res) => {
  const user = store.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.lockedUntil    = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  user.loginAttempts  = 10;
  store.saveUser(user);
  console.log(`[admin] Locked user ${user.email}`);
  res.json({ success: true });
});

app.post('/admin/users/:id/unlock', adminSessionAuth, (req, res) => {
  const user = store.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.lockedUntil   = null;
  user.loginAttempts = 0;
  store.saveUser(user);
  console.log(`[admin] Unlocked user ${user.email}`);
  res.json({ success: true });
});

// ── Newsletter admin ────────────────────────────────────────────────────────
app.get('/admin/newsletter', adminSessionAuth, (req, res) => {
  const users = store.getUsers();
  res.json({
    total:       users.length,
    subscribers: users.filter(u => u.marketingOptIn).length,
    verified:    users.filter(u => u.emailVerified).length,
    brokers:     users.filter(u => u.role === 'broker' || u.role === 'inmobiliaria').length,
  });
});

app.post('/admin/newsletter/send', adminSessionAuth, async (req, res) => {
  try {
    const result = await sendNewsletter();
    console.log('[admin] Newsletter manually triggered by admin');
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tours admin ─────────────────────────────────────────────────────────────
app.get('/admin/tours', adminSessionAuth, (req, res) => {
  res.json(store.getTours());
});

// ── Unsubscribe ────────────────────────────────────────────────
app.get('/unsubscribe', (req, res) => {
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

// ── Saved search alerts cron (every 2 hours) ────────────────────────────────
cron.schedule('0 */2 * * *', () => {
  console.log('[Cron] Checking saved search matches…');
  checkSavedSearchMatches()
    .then(r => console.log('[Cron] Saved search check done:', r))
    .catch(e => console.error('[Cron] Saved search error:', e.message));
}, { timezone: 'America/Santo_Domingo' });

// ── Admin error tracking endpoint ─────────────────────────────────
app.use('/api/admin', errorTracker.router);

// ── 404 handler for unmatched API routes ──────────────────────────
app.use('/api/*', errorTracker.notFoundHandler);

// ── Global error handler ──────────────────────────────────────────
app.use(errorTracker.errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`HogaresRD running at http://localhost:${PORT}`);
  });
}

module.exports = app;
