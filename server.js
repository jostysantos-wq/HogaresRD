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
// nodemailer replaced by centralized mailer.js (Resend HTTP API)
const multer       = require('multer');
const sharp        = require('sharp');
const fsp          = require('fs').promises;
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

// ── Email transporter (uses Resend via mailer.js) ─────────────
const { createTransport: _createMailTransport } = require('./routes/mailer');
const transporter = _createMailTransport();

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
// HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy etc.
// always active. CSP is Report-Only for now — logs violations without
// blocking, so we can tighten into enforcing mode once the inline-script
// footprint is measured. Tighten CSP with nonces/hashes in a future sprint.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false, // pages embed cross-origin media
}));

// Report-only CSP. Browsers log violations to /api/csp-report but won't
// block anything. After a week of clean logs, flip CSP_ENFORCE=1 in .env
// to switch the header to `Content-Security-Policy` (enforcing mode).
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://checkout.stripe.com https://www.googletagmanager.com https://connect.facebook.net https://*.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://*.openstreetmap.org",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.openstreetmap.org",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://api.stripe.com https://www.facebook.com https://*.facebook.com https://graph.facebook.com https://*.openstreetmap.org https://nominatim.openstreetmap.org",
  "frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://hooks.stripe.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'self'",
  "report-uri /api/csp-report",
].join('; ');
const CSP_HEADER = process.env.CSP_ENFORCE === '1'
  ? 'Content-Security-Policy'
  : 'Content-Security-Policy-Report-Only';
app.use((req, res, next) => {
  res.setHeader(CSP_HEADER, CSP_DIRECTIVES);
  next();
});

// CSP violation sink. Browsers POST here with the offending resource;
// we append to the existing security log for review.
app.post('/api/csp-report',
  express.json({ type: ['application/csp-report', 'application/json'], limit: '16kb' }),
  (req, res) => {
    try {
      const r = req.body?.['csp-report'] || req.body || {};
      const { logSec } = require('./routes/security-log');
      logSec('csp_violation', req, {
        documentURI: (r['document-uri'] || '').slice(0, 200),
        blockedURI:  (r['blocked-uri']  || '').slice(0, 200),
        violatedDirective: (r['violated-directive'] || '').slice(0, 100),
        sourceFile:  (r['source-file']  || '').slice(0, 200),
      });
    } catch {}
    res.status(204).end();
  }
);

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
app.use('/api/inventory',          require('./routes/inventory'));
app.use('/api/reports',            require('./routes/reports').router);
app.use('/api/paid-ads',          require('./routes/paid-ads'));
app.use('/api/push',              require('./routes/push').router);
app.use('/api/saved-searches',    savedSearchRouter);
app.use('/api/tasks',             require('./routes/tasks'));

// ── Public config endpoint (pixel ID is intentionally public) ─────────────
app.get('/api/config/meta', (req, res) => {
  const pixelId = process.env.META_PIXEL_ID;
  if (!pixelId) return res.json({ pixelId: null });
  res.json({ pixelId });
});

// ── Photo upload endpoint ──────────────────────────────────────
// After multer writes the file, we pipe it through sharp to strip
// EXIF (GPS coords, device serial, etc.) and cap dimensions at 1920px.
// This protects user privacy (no home-GPS leaking from a property
// photo) and trims bandwidth on view.
app.post('/api/upload/photos', photoUpload.array('photos', 5), async (req, res) => {
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No se recibieron imágenes.' });

  const urls = [];
  for (const f of req.files) {
    try {
      const buf = await fsp.readFile(f.path);
      // rotate() honors existing EXIF orientation, then strips metadata.
      // resize() only downscales (withoutEnlargement).
      const out = await sharp(buf)
        .rotate()
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
      await fsp.writeFile(f.path, out);
    } catch (e) {
      console.warn('[upload/photos] sharp processing failed for', f.filename, '-', e.message);
      // If sharp fails, fall back to the original file (user still gets upload).
    }
    urls.push(`/uploads/photos/${f.filename}`);
  }
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
  limits:  { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // Accept any image MIME type — the client (iOS/web) handles format conversion
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    // Also accept by extension as fallback
    if (/\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Solo se permiten archivos de imagen'));
  },
});

// POST /api/upload/avatar — authenticated, replaces user's profile picture
app.post('/api/upload/avatar', (req, res, next) => {
  const { userAuth } = require('./routes/auth');
  userAuth(req, res, next);
}, avatarUpload.single('avatar'), (req, res) => {
  console.log('[avatar] Upload received:', req.file ? { name: req.file.originalname, mime: req.file.mimetype, size: req.file.size } : 'NO FILE');
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen.' });
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Delete old avatar file if it exists
  if (user.avatarUrl && user.avatarUrl.startsWith('/uploads/avatars/')) {
    try { fs.unlinkSync(path.join(__dirname, 'public', user.avatarUrl)); } catch {}
  }

  user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
  store.saveUser(user);
  console.log('[avatar] Saved:', user.avatarUrl);
  res.json({ success: true, avatarUrl: user.avatarUrl });
}, (err, req, res, next) => {
  console.error('[avatar] Upload error:', err.message);
  res.status(400).json({ error: err.message });
});

// ── Report attachment upload ──────────────────────────────────────
const REPORTS_DIR = path.join(__dirname, 'public', 'uploads', 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const reportStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, REPORTS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `rpt_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const reportUpload = multer({
  storage: reportStorage,
  limits:  { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf')) return cb(null, true);
    cb(new Error('Solo se permiten imagenes o PDF'));
  },
});

app.post('/api/upload/report-attachment', (req, res, next) => {
  const { userAuth } = require('./routes/auth');
  userAuth(req, res, next);
}, reportUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio archivo.' });
  res.json({ success: true, url: `/uploads/reports/${req.file.filename}` });
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
app.get('/register-constructora', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-constructora.html')));
app.get('/register-secretary', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-secretary.html')));
app.get('/reset-password',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/forgot-password',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/terminos-usuario',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-usuario.html')));
app.get('/terminos-agente',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-agente.html')));
app.get('/terminos-publicacion', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-publicacion.html')));
app.get('/terminos-inmobiliaria',(req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos-inmobiliaria.html')));
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
app.get('/blog/:slug',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'post.html')));
app.get('/broker',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'broker.html')));
app.get('/my-applications',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-applications.html')));
app.get('/tareas',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'tareas.html')));
app.get('/profile',           (req, res) => res.redirect('/broker#perfil'));
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

  // AI review — fire-and-forget (runs in background, stores result on listing)
  if (submission.submission_type !== 'agency_claim') {
    const { reviewListing } = require('./routes/ai-review');
    setImmediate(() => reviewListing(submission.id).catch(e =>
      console.error('[ai-review] Background error:', e.message)
    ));
  }

  // Send notification email
  try {
    const amenitiesList = Array.isArray(submission.amenities)
      ? submission.amenities.join(', ')
      : submission.amenities;

    const adminPanelUrl = `${process.env.BASE_URL || 'https://hogaresrd.com'}/${process.env.ADMIN_PATH || 'admin'}`;
    await transporter.sendMail({
      department: 'admin',
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

// Audit middleware: every non-GET admin request is written to the
// security log so we can reconstruct what an admin touched.
const { logSec: _logSec } = require('./routes/security-log');
app.use('/admin', (req, res, next) => {
  if (req.method !== 'GET') {
    _logSec('admin_action', req, {
      method: req.method,
      path:   req.path,
      body:   Object.keys(req.body || {}).slice(0, 20), // keys only, not values
    });
  }
  next();
});

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
// ── Admin: Reports ─────────────────────────────────────────────
// Lists all user-submitted reports (listings / agents / inmobiliarias)
// with duplicate-target grouping so admins can see repeat offenders.
app.get('/admin/reports', adminSessionAuth, (req, res) => {
  const status = req.query.status || null;
  const reports = store.getReports(status);
  // Count how many total reports exist per target (across all statuses) so the
  // UI can flag repeat offenders even when filtering by status.
  const all = status ? store.getReports(null) : reports;
  const counts = {};
  for (const r of all) {
    const key = r.type + ':' + r.target_id;
    counts[key] = (counts[key] || 0) + 1;
  }
  const enriched = reports.map(r => ({
    ...r,
    target_report_count: counts[r.type + ':' + r.target_id] || 1,
  }));
  res.json({ reports: enriched });
});

app.put('/admin/reports/:id', adminSessionAuth, (req, res) => {
  const report = store.getReportById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });
  const { status, admin_notes } = req.body;
  if (status) report.status = status;
  if (admin_notes !== undefined) report.admin_notes = admin_notes;
  report.updated_at = new Date().toISOString();
  store.saveReport(report);
  res.json(report);
});

app.get('/admin/newsletter', adminSessionAuth, (req, res) => {
  const users = store.getUsers();
  res.json({
    total:       users.length,
    subscribers: users.filter(u => u.marketingOptIn).length,
    verified:    users.filter(u => u.emailVerified).length,
    brokers:     users.filter(u => ['broker', 'inmobiliaria', 'constructora'].includes(u.role)).length,
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

// ── Featured listings (public) ───────────────────────────────────────────────
app.get('/api/listings/featured', (req, res) => {
  const featured = store.getAllSubmissions().filter(s =>
    s.status === 'approved' &&
    s.submission_type !== 'agency_claim' &&
    s._extra && s._extra.featured
  );
  res.json({ listings: featured });
});

// ── Catalogue / Listings admin ───────────────────────────────────────────────
// Returns all submissions (all statuses) as a compact catalogue for the admin.
app.get('/admin/catalogue', adminSessionAuth, (req, res) => {
  const subs = store.getAllSubmissions()
    .filter(s => s.submission_type !== 'agency_claim')
    .map(s => ({
      id:          s.id,
      title:       s.title,
      type:        s.type,
      condition:   s.condition,
      price:       s.price,
      province:    s.province,
      city:        s.city,
      sector:      s.sector,
      bedrooms:    s.bedrooms,
      bathrooms:   s.bathrooms,
      status:      s.status,
      views:       s.views || 0,
      submittedAt: s.submittedAt,
      approvedAt:  s.approvedAt,
      name:        s.name,
      email:       s.email,
      images:      Array.isArray(s.images) ? s.images.slice(0, 1) : [],
      featured:    !!(s._extra && s._extra.featured),
    }));
  res.json(subs);
});

// Toggle featured flag on a listing
app.post('/admin/catalogue/:id/feature', adminSessionAuth, (req, res) => {
  const sub = store.getListingById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Anuncio no encontrado' });
  if (!sub._extra || typeof sub._extra !== 'object') sub._extra = {};
  sub._extra.featured = !sub._extra.featured;
  sub.updatedAt = new Date().toISOString();
  store.saveListing(sub);
  res.json({ success: true, featured: sub._extra.featured });
});

// Unpublish — move approved listing back to pending for re-review
app.post('/admin/catalogue/:id/unpublish', adminSessionAuth, (req, res) => {
  const sub = store.getListingById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Anuncio no encontrado' });
  sub.status      = 'pending';
  sub.approvedAt  = null;
  sub.updatedAt   = new Date().toISOString();
  store.saveListing(sub);
  console.log(`[admin] Unpublished listing ${sub.id} (${sub.title})`);
  res.json({ success: true });
});

// ── Public Blog API ──────────────────────────────────────────────────────────
app.get('/api/blog/posts', (req, res) => {
  const posts = store.getBlogPosts('published').map(p => ({
    id: p.id, slug: p.slug, title: p.title, excerpt: p.excerpt,
    category: p.category, cover_image: p.cover_image, author: p.author,
    read_time: p.read_time, featured: p.featured, views: p.views,
    published_at: p.published_at,
  }));
  res.json({ posts });
});

app.get('/api/blog/posts/:slug', (req, res) => {
  const post = store.getBlogPostBySlug(req.params.slug);
  if (!post || post.status !== 'published') return res.status(404).json({ error: 'Not found' });
  store.incrementBlogViews(req.params.slug);
  res.json({ post });
});

// ── Public Page Content API ───────────────────────────────────────────────────
app.get('/api/page-content/:page', (req, res) => {
  const all = store.getAllPageContent().filter(s => s.page === req.params.page);
  const result = {};
  all.forEach(s => { result[s.section] = s.data; });
  res.json(result);
});

// ── Admin Blog API ───────────────────────────────────────────────────────────
app.get('/admin/blog/posts', adminSessionAuth, (req, res) => {
  res.json(store.getBlogPosts());
});

app.post('/admin/blog/posts', adminSessionAuth, (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const body = req.body;
  if (!body.title) return res.status(400).json({ error: 'title required' });

  // Auto-generate slug from title if not provided
  let slug = body.slug || body.title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  // Ensure unique slug
  let base = slug, n = 1;
  while (store.getBlogPostBySlug(slug)) { slug = `${base}-${n++}`; }

  const post = {
    id:          body.id || uuidv4(),
    slug,
    title:       body.title,
    excerpt:     body.excerpt || '',
    content:     body.content || '',
    category:    body.category || 'general',
    cover_image: body.cover_image || '',
    author:      body.author || 'Equipo HogaresRD',
    read_time:   parseInt(body.read_time) || 5,
    featured:    !!body.featured,
    status:      body.status || 'draft',
    published_at:body.status === 'published' ? new Date().toISOString() : null,
    created_at:  new Date().toISOString(),
  };
  store.saveBlogPost(post);
  res.json({ success: true, post });
});

app.put('/admin/blog/posts/:id', adminSessionAuth, (req, res) => {
  const existing = store.getBlogPostById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const body = req.body;

  // Handle slug change — check uniqueness
  let slug = body.slug || existing.slug;
  if (slug !== existing.slug) {
    let base = slug, n = 1;
    const other = store.getBlogPostBySlug(slug);
    while (other && other.id !== existing.id) { slug = `${base}-${n++}`; }
  }

  const wasPublished = existing.status === 'published';
  const isPublishing = body.status === 'published' && !wasPublished;

  const post = {
    ...existing,
    slug,
    title:       body.title       !== undefined ? body.title       : existing.title,
    excerpt:     body.excerpt     !== undefined ? body.excerpt     : existing.excerpt,
    content:     body.content     !== undefined ? body.content     : existing.content,
    category:    body.category    !== undefined ? body.category    : existing.category,
    cover_image: body.cover_image !== undefined ? body.cover_image : existing.cover_image,
    author:      body.author      !== undefined ? body.author      : existing.author,
    read_time:   body.read_time   !== undefined ? parseInt(body.read_time) : existing.read_time,
    featured:    body.featured    !== undefined ? !!body.featured  : existing.featured,
    status:      body.status      || existing.status,
    published_at: isPublishing ? new Date().toISOString() : existing.published_at,
  };
  store.saveBlogPost(post);
  res.json({ success: true, post });
});

app.delete('/admin/blog/posts/:id', adminSessionAuth, (req, res) => {
  const existing = store.getBlogPostById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  store.deleteBlogPost(req.params.id);
  res.json({ success: true });
});

// ── Admin Page Content API ───────────────────────────────────────────────────
app.get('/admin/page-content', adminSessionAuth, (req, res) => {
  res.json(store.getAllPageContent());
});

app.post('/admin/page-content', adminSessionAuth, (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const { page, section, data } = req.body;
  if (!page || !section) return res.status(400).json({ error: 'page and section required' });
  const id = `${page}_${section}`;
  store.savePageSection(id, page, section, data || {});
  res.json({ success: true });
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

// ── Auto-archive closed conversations after 24h (hourly check) ──────────
cron.schedule('17 * * * *', () => {
  try {
    const allConvs = store.getConversations();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    let archived = 0;
    for (const conv of allConvs) {
      if (conv.closed && !conv.archived && conv.closedAt) {
        if (new Date(conv.closedAt).getTime() <= cutoff) {
          conv.archived   = true;
          conv.archivedAt = new Date().toISOString();
          conv.archivedBy = 'system';
          conv.updatedAt  = conv.archivedAt;
          store.saveConversation(conv);
          archived++;
        }
      }
    }
    if (archived > 0) console.log(`[Cron] Auto-archived ${archived} conversation(s) closed >24h`);
  } catch (e) {
    console.error('[Cron] Auto-archive error:', e.message);
  }
}, { timezone: 'America/Santo_Domingo' });

// ── Admin: re-run AI review on a listing ─────────────────────────
app.post('/admin/ai-review/:id', adminSessionAuth, async (req, res) => {
  const { reviewListing } = require('./routes/ai-review');
  try {
    await reviewListing(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin error tracking endpoint ─────────────────────────────────
app.use('/api/admin', errorTracker.router);

// ── 404 handler for unmatched API routes ──────────────────────────
app.use('/api/*', errorTracker.notFoundHandler);

// ── Global error handler ──────────────────────────────────────────
app.use(errorTracker.errorHandler);

// ── Blog seed (runs once on first boot if no posts exist) ──────────────────
(function seedBlogIfEmpty() {
  try {
    if (store.getBlogPosts().length > 0) return;
    const { v4: uuidv4 } = require('uuid');
    const seed = [
      { slug:'como-comprar-primera-propiedad-rd', title:'Cómo comprar tu primera propiedad en República Dominicana: guía paso a paso', excerpt:'Desde la búsqueda inicial hasta la firma del contrato, te explicamos todo lo que debes saber para comprar tu primera casa o apartamento en RD sin complicaciones.', content:'<p>Comprar una propiedad por primera vez puede ser una de las decisiones más importantes de tu vida. En HogaresRD queremos acompañarte en ese proceso con información clara y práctica.</p><h2>1. Define tu presupuesto</h2><p>Antes de buscar cualquier propiedad, es fundamental conocer cuánto puedes invertir. Considera el precio de compra, los costos de cierre (aproximadamente un 3-5% del valor), el seguro de título, y los gastos de mantenimiento mensual.</p><h2>2. Explora el mercado</h2><p>Utiliza plataformas como HogaresRD para comparar propiedades en diferentes zonas, tipos y rangos de precio.</p><h2>3. Verifica la documentación</h2><p>Solicita el certificado de título y verifica que el vendedor sea el propietario legítimo en el Registro de Títulos. Un abogado inmobiliario puede ayudarte en este proceso.</p>', category:'guia', cover_image:'https://picsum.photos/seed/blogfeatured/800/600', read_time:15, featured:true, published_at:'2026-03-15T10:00:00.000Z' },
      { slug:'mercado-lujo-punta-cana-2026', title:'El mercado de lujo en Punta Cana sigue creciendo: ¿qué está pasando?', excerpt:'Los precios en el corredor turístico del Este no dejan de subir. Analizamos los factores detrás del boom y qué significa para compradores e inversores.', content:'<p>El corredor turístico del Este dominicano, y en particular Punta Cana, sigue siendo uno de los mercados inmobiliarios más dinámicos del Caribe en 2026.</p><h2>Factores que impulsan el crecimiento</h2><p>El turismo récord de los últimos años ha generado una demanda sostenida de propiedades de lujo, tanto para uso propio como para inversión con renta.</p>', category:'mercado', cover_image:'https://picsum.photos/seed/blog1/600/400', read_time:8, featured:false, published_at:'2026-03-10T10:00:00.000Z' },
      { slug:'5-razones-invertir-bienes-raices-rd', title:'5 razones para invertir en bienes raíces en RD ahora mismo', excerpt:'Tipo de cambio favorable, crecimiento turístico sostenido y alta demanda de alquileres. República Dominicana se posiciona como uno de los mercados más atractivos del Caribe.', content:'<p>Si estás pensando en dónde poner tu dinero a trabajar, República Dominicana merece estar en tu lista.</p><h2>1. Economía en crecimiento</h2><p>RD ha mantenido un crecimiento del PIB por encima del promedio latinoamericano durante la última década.</p><h2>2. Ley CONFOTUR</h2><p>Ofrece exenciones fiscales de hasta 20 años para desarrollos turísticos aprobados.</p>', category:'inversion', cover_image:'https://picsum.photos/seed/blog2/600/400', read_time:6, featured:false, published_at:'2026-02-20T10:00:00.000Z' },
      { slug:'alquilar-o-comprar-como-decidir', title:'¿Alquilar o comprar? Cómo decidir según tu situación financiera', excerpt:'No siempre comprar es la mejor opción. Te damos las claves para evaluar qué te conviene más.', content:'<p>Esta es una de las preguntas más frecuentes que recibimos en HogaresRD.</p><h2>Cuándo tiene sentido comprar</h2><p>Si tienes estabilidad laboral y financiera y planeas quedarte al menos 5 años, comprar suele ser la opción más beneficiosa a largo plazo.</p><h2>Cuándo es mejor alquilar</h2><p>Si estás en etapa de transición o tu flujo de caja es ajustado, alquilar te da flexibilidad sin comprometer tu liquidez.</p>', category:'alquiler', cover_image:'https://picsum.photos/seed/blog3/600/400', read_time:7, featured:false, published_at:'2026-02-10T10:00:00.000Z' },
      { slug:'santo-domingo-vs-santiago-2026', title:'Santo Domingo vs. Santiago: ¿en qué ciudad vivir mejor en 2026?', excerpt:'Calidad de vida, costo de vivienda, acceso a servicios y oportunidades laborales. Comparamos las dos ciudades más grandes de RD.', content:'<p>Si tienes que elegir entre la capital y la Ciudad Corazón, esta guía te ayudará.</p><h2>Santo Domingo</h2><p>La capital ofrece la mayor concentración de empleos formales y universidades. Los precios son los más altos del país.</p><h2>Santiago</h2><p>Los precios son entre un 20-35% más bajos que en la capital, con excelente calidad de vida y una economía industrial robusta.</p>', category:'ciudad', cover_image:'https://picsum.photos/seed/blog4/600/400', read_time:10, featured:false, published_at:'2026-01-25T10:00:00.000Z' },
      { slug:'revisar-contrato-compraventa-rd', title:'Todo lo que debes revisar antes de firmar un contrato de compraventa', excerpt:'El contrato es el momento más importante de la transacción. Conoce las cláusulas clave y cómo protegerte legalmente.', content:'<p>Firmar un contrato de compraventa es uno de los momentos más importantes en la adquisición de una propiedad.</p><h2>Verificación del título</h2><p>Confirma que el certificado de título no tenga hipotecas ni gravámenes. Esto se verifica en el Registro de Títulos.</p><h2>Precio y forma de pago</h2><p>El contrato debe especificar el precio total, las cuotas, la forma de pago y las penalidades por incumplimiento.</p>', category:'guia', cover_image:'https://picsum.photos/seed/blog5/600/400', read_time:9, featured:false, published_at:'2026-01-15T10:00:00.000Z' },
      { slug:'portafolio-inmobiliario-agentes-rd', title:'Cómo crear un portafolio inmobiliario que genere confianza y cierre más ventas', excerpt:'Tu portafolio digital es tu carta de presentación. Aprende a mostrar tus propiedades de manera profesional.', content:'<p>En un mercado cada vez más digital, tu presencia online como agente puede ser la diferencia entre cerrar o perder una venta.</p><h2>Fotografías profesionales</h2><p>Invierte en fotografía profesional. La primera impresión es la foto.</p><h2>Descripciones que venden</h2><p>Evita las descripciones genéricas. Resalta características únicas y el vecindario.</p><h2>Responde rápido</h2><p>Los compradores evalúan múltiples opciones. Responder en menos de 2 horas aumenta las probabilidades de concretar una cita.</p>', category:'agentes', cover_image:'https://picsum.photos/seed/blog6/600/400', read_time:5, featured:false, published_at:'2026-01-05T10:00:00.000Z' },
    ];
    seed.forEach(p => store.saveBlogPost({ ...p, id: uuidv4(), author: 'Equipo HogaresRD', status: 'published', views: 0 }));
    console.log('[Blog] Seeded', seed.length, 'initial blog posts');
  } catch(e) {
    console.error('[Blog] Seed error:', e.message);
  }
})();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`HogaresRD running at http://localhost:${PORT}`);
  });
}

module.exports = app;
