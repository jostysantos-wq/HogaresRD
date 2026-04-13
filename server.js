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
const et = require('./utils/email-templates');
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
  limits:  { fileSize: 5 * 1024 * 1024, files: 30 },
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
// Additional security headers not covered by helmet defaults
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(self)');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

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
// CSP enforcing by default. Set CSP_REPORT_ONLY=1 to switch to report-only.
const CSP_HEADER = process.env.CSP_REPORT_ONLY === '1'
  ? 'Content-Security-Policy-Report-Only'
  : 'Content-Security-Policy';
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
// ── Apple App Site Association — must be served with application/json ──
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'apple-app-site-association'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: false,
}));

// ── Referral cookie middleware ────────────────────────────────
// When any page is visited with ?ref=TOKEN, validate it exists in DB
// then set a 30-day cookie for attribution
app.use((req, res, next) => {
  const ref = req.query.ref;
  if (ref && typeof ref === 'string' && ref.length === 16 && /^[a-f0-9]{16}$/i.test(ref)) {
    // Only set cookie if token belongs to a real agent
    const agent = store.getUserByRefToken(ref);
    if (agent) {
      res.cookie('hrd_ref', ref, {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });
    }
  }
  next();
});

// ── GPC (Global Privacy Control) signal detection ────────────
// Browsers that send Sec-GPC: 1 are automatically opted out of
// data sale/sharing per CCPA. We honor this at the response level.
app.use((req, res, next) => {
  if (req.headers['sec-gpc'] === '1') {
    res.setHeader('X-GPC-Acknowledged', '1');
  }
  next();
});

// ── Short referral links ─────────────────────────────────────
app.get('/r/:refToken', (req, res) => res.redirect(`/comprar?ref=${req.params.refToken}`));
app.get('/r/:refToken/:listingId', (req, res) => res.redirect(`/listing/${req.params.listingId}?ref=${req.params.refToken}`));

// ── API routes ─────────────────────────────────────────────────
app.use('/api/stripe',     require('./routes/stripe'));
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/listings',   require('./routes/listings'));
app.use('/api/listings',   require('./routes/ai-translate').router);
app.use('/api/user',       require('./routes/user'));
app.use('/api/newsletter', newsletterRouter);
app.use('/api/ads',        require('./routes/ads'));
app.use('/api/leads',         require('./routes/leads'));
app.use('/api/applications',  require('./routes/applications'));
app.use('/api/broker',        require('./routes/broker-dashboard'));

// Public agent count for home page stats
app.get('/api/agents', (req, res) => {
  const brokers = store.getUsersByRole('broker').length + store.getUsersByRole('agency').length;
  res.json({ total: brokers, length: brokers });
});
app.use('/api/referrals',     require('./routes/referrals'));
app.use('/api/inmobiliaria',  require('./routes/inmobiliaria'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/conversations', require('./routes/auth').userAuth, require('./routes/conversations'));
app.use('/api/lead-queue', require('./routes/auth').userAuth, require('./routes/lead-queue').router);
app.use('/api/contributions', require('./routes/auth').userAuth, require('./routes/contributions').router);
app.use('/api/webhooks/meta', require('./routes/meta-webhook'));
app.use('/api/tours',         require('./routes/tours'));
app.use('/api/listing-analytics', require('./routes/listing-analytics'));
app.use('/api/inventory',          require('./routes/inventory'));
app.use('/api/reports',            require('./routes/reports').router);
app.use('/api/paid-ads',          require('./routes/paid-ads'));
app.use('/api/push',              require('./routes/push').router);
app.use('/api/saved-searches',    savedSearchRouter);
app.use('/api/tasks',             require('./routes/tasks'));

// ── Contact Timeline CRM ──────────────────────────────────────────────────
const { userAuth: contactAuth } = require('./routes/auth');

// GET /api/contacts — list all contacts for this agent (deduplicated from apps + conversations)
app.get('/api/contacts', contactAuth, (req, res) => {
  const userId = req.user.sub;
  const apps   = store.getApplicationsByBroker(userId);
  const convs  = store.getConversationsForBroker(userId);
  const tours  = store.getToursByBroker(userId);

  // Build unique contact map from all sources
  const contactMap = new Map();

  for (const a of apps) {
    const c = a.client || {};
    const id = c.user_id || c.email || a.id;
    if (!id) continue;
    const existing = contactMap.get(id) || { id, name: '', email: '', phone: '', interactions: 0, lastInteraction: null, firstInteraction: null };
    existing.name  = existing.name || c.name || '';
    existing.email = existing.email || c.email || '';
    existing.phone = existing.phone || c.phone || '';
    existing.interactions++;
    const ts = a.updated_at || a.created_at;
    if (ts && (!existing.lastInteraction || ts > existing.lastInteraction)) existing.lastInteraction = ts;
    if (ts && (!existing.firstInteraction || ts < existing.firstInteraction)) existing.firstInteraction = ts;
    contactMap.set(id, existing);
  }

  for (const c of convs) {
    const id = c.clientId || c.clientEmail;
    if (!id) continue;
    const existing = contactMap.get(id) || { id, name: '', email: '', phone: '', interactions: 0, lastInteraction: null, firstInteraction: null };
    existing.name  = existing.name || c.clientName || '';
    existing.email = existing.email || c.clientEmail || '';
    existing.phone = existing.phone || c.clientPhone || '';
    existing.interactions += (c.messageCount || 1);
    const ts = c.updatedAt || c.createdAt;
    if (ts && (!existing.lastInteraction || ts > existing.lastInteraction)) existing.lastInteraction = ts;
    if (ts && (!existing.firstInteraction || ts < existing.firstInteraction)) existing.firstInteraction = ts;
    contactMap.set(id, existing);
  }

  for (const t of tours) {
    const id = t.client_id || t.client_email;
    if (!id) continue;
    const existing = contactMap.get(id) || { id, name: '', email: '', phone: '', interactions: 0, lastInteraction: null, firstInteraction: null };
    existing.name  = existing.name || t.client_name || '';
    existing.email = existing.email || t.client_email || '';
    existing.phone = existing.phone || t.client_phone || '';
    existing.interactions++;
    const ts = t.updated_at || t.created_at;
    if (ts && (!existing.lastInteraction || ts > existing.lastInteraction)) existing.lastInteraction = ts;
    if (ts && (!existing.firstInteraction || ts < existing.firstInteraction)) existing.firstInteraction = ts;
    contactMap.set(id, existing);
  }

  const contacts = Array.from(contactMap.values())
    .sort((a, b) => (b.lastInteraction || '').localeCompare(a.lastInteraction || ''));
  res.json({ contacts, total: contacts.length });
});

// GET /api/contacts/:id/timeline — unified activity feed for a contact
app.get('/api/contacts/:id/timeline', contactAuth, (req, res) => {
  const contactId = req.params.id;
  const typeFilter = req.query.type || null;
  const events = [];

  // 1. Applications
  const apps = store.getApplicationsByClient(contactId);
  for (const a of apps) {
    // Main application event
    events.push({
      id: 'evt_app_' + a.id,
      type: 'application',
      timestamp: a.created_at || a.createdAt,
      title: 'Nueva aplicacion',
      subtitle: a.listing_title || '',
      icon: 'doc.text.fill',
      color: '#0038A8',
      refId: a.id,
      status: a.status,
    });
    // Status change events from timeline_events
    const timeline = Array.isArray(a.timeline_events) ? a.timeline_events : [];
    for (const te of timeline) {
      const statusLabels = { en_revision: 'En revision', aprobado: 'Aprobada', rechazado: 'Rechazada', completado: 'Completada' };
      events.push({
        id: 'evt_appst_' + a.id + '_' + (te.timestamp || Date.now()),
        type: 'status_change',
        timestamp: te.timestamp || te.date,
        title: statusLabels[te.to] || ('Estado: ' + (te.to || '')),
        subtitle: a.listing_title || '',
        icon: te.to === 'aprobado' ? 'checkmark.circle.fill' : te.to === 'rechazado' ? 'xmark.circle.fill' : 'arrow.triangle.2.circlepath',
        color: te.to === 'aprobado' ? '#1B7A3E' : te.to === 'rechazado' ? '#CE1126' : '#0038A8',
        refId: a.id,
        status: te.to,
      });
    }
  }

  // 2. Conversations
  const convs = store.getConversationsByClient(contactId);
  for (const c of convs) {
    events.push({
      id: 'evt_conv_' + c.id,
      type: 'conversation',
      timestamp: c.createdAt,
      title: 'Conversacion iniciada',
      subtitle: c.propertyTitle || '',
      icon: 'bubble.left.and.bubble.right.fill',
      color: '#5B21B6',
      refId: c.id,
      status: c.closed ? 'cerrada' : 'activa',
      messageCount: c.messageCount || (c.messages || []).length,
      lastMessage: c.lastMessage,
    });
    // Last message event (if different from creation)
    if (c.updatedAt && c.updatedAt !== c.createdAt && c.lastMessage) {
      events.push({
        id: 'evt_msg_' + c.id + '_last',
        type: 'message',
        timestamp: c.updatedAt,
        title: 'Ultimo mensaje',
        subtitle: (c.lastMessage || '').slice(0, 80),
        icon: 'text.bubble.fill',
        color: '#5B21B6',
        refId: c.id,
        status: null,
      });
    }
  }

  // 3. Tours
  const tours = store.getToursByClient(contactId);
  for (const t of tours) {
    const tourLabels = { pending: 'Visita solicitada', confirmed: 'Visita confirmada', completed: 'Visita completada', rejected: 'Visita rechazada', cancelled: 'Visita cancelada' };
    events.push({
      id: 'evt_tour_' + t.id,
      type: 'tour',
      timestamp: t.created_at,
      title: tourLabels[t.status] || 'Visita',
      subtitle: t.listing_title || '',
      icon: t.status === 'completed' ? 'checkmark.seal.fill' : t.status === 'confirmed' ? 'calendar.badge.checkmark' : 'calendar.badge.clock',
      color: t.status === 'completed' ? '#1B7A3E' : t.status === 'cancelled' || t.status === 'rejected' ? '#CE1126' : '#D97706',
      refId: t.id,
      status: t.status,
      tourDate: t.requested_date,
      tourTime: t.requested_time,
      tourType: t.tour_type,
    });
    // Feedback event
    if (t.feedback_rating) {
      events.push({
        id: 'evt_feedback_' + t.id,
        type: 'feedback',
        timestamp: t.completed_at || t.updated_at,
        title: 'Feedback: ' + t.feedback_rating + '/5',
        subtitle: t.feedback_comment || '',
        icon: 'star.fill',
        color: '#D97706',
        refId: t.id,
        status: null,
      });
    }
  }

  // 4. Tasks
  const tasks = store.getTasksByUser(contactId);
  for (const t of tasks) {
    events.push({
      id: 'evt_task_' + t.id,
      type: 'task',
      timestamp: t.created_at || t.createdAt,
      title: t.title || 'Tarea',
      subtitle: t.description || '',
      icon: t.status === 'completada' ? 'checkmark.circle.fill' : 'checklist',
      color: t.status === 'completada' ? '#1B7A3E' : t.priority === 'alta' ? '#CE1126' : '#4B5563',
      refId: t.id,
      status: t.status,
    });
  }

  // Filter by type if requested
  let filtered = events;
  if (typeFilter) filtered = events.filter(e => e.type === typeFilter);

  // Sort by timestamp descending (newest first)
  filtered.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  // Build contact summary
  const user = store.getUserById(contactId);
  const contact = {
    id: contactId,
    name: user?.name || apps[0]?.client?.name || convs[0]?.clientName || tours[0]?.client_name || '',
    email: user?.email || apps[0]?.client?.email || convs[0]?.clientEmail || tours[0]?.client_email || '',
    phone: user?.phone || apps[0]?.client?.phone || convs[0]?.clientPhone || tours[0]?.client_phone || '',
    createdAt: user?.createdAt || null,
    totalInteractions: events.length,
    applications: apps.length,
    conversations: convs.length,
    tours: tours.length,
    tasks: tasks.length,
  };

  res.json({ contact, events: filtered });
});

// ── Payments Summary (CRM) ────────────────────────────────────────────────
app.get('/api/payments/summary', contactAuth, (req, res) => {
  const userId = req.user.sub;
  const user   = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Get applications this user can see
  let apps;
  if (user.role === 'inmobiliaria' || user.role === 'constructora') {
    apps = store.getApplicationsByInmobiliaria(user.inmobiliaria_id || userId);
  } else if (user.role === 'secretary') {
    apps = store.getApplicationsByInmobiliaria(user.inmobiliaria_id);
  } else {
    apps = store.getApplicationsByBroker(userId);
  }

  const now = new Date();
  const items = [];

  for (const app of apps) {
    const plan = app.payment_plan;
    const client = app.client || {};

    // Single-payment apps (no plan)
    if (!plan && app.payment && app.payment.verification_status !== 'none') {
      items.push({
        id: 'pay_' + app.id,
        applicationId: app.id,
        clientName: client.name || '',
        clientEmail: client.email || '',
        listingTitle: app.listing_title || '',
        listingId: app.listing_id || '',
        amount: app.payment.amount || 0,
        currency: app.payment.currency || 'DOP',
        dueDate: null,
        status: app.payment.verification_status,
        installmentNumber: null,
        installmentLabel: 'Pago unico',
        proofUploaded: !!app.payment.receipt_path,
        proofUploadedAt: app.payment.receipt_uploaded_at,
        reminderSent: false,
        type: 'single',
      });
      continue;
    }

    // Payment plan installments
    if (!plan || !Array.isArray(plan.installments)) continue;

    for (const inst of plan.installments) {
      const dueDate = inst.due_date ? new Date(inst.due_date) : null;
      const daysUntilDue = dueDate ? Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24)) : null;

      items.push({
        id: 'pay_' + app.id + '_' + inst.id,
        applicationId: app.id,
        installmentId: inst.id,
        clientName: client.name || '',
        clientEmail: client.email || '',
        listingTitle: app.listing_title || '',
        listingId: app.listing_id || '',
        amount: inst.amount || 0,
        currency: plan.currency || 'DOP',
        dueDate: inst.due_date,
        daysUntilDue,
        status: inst.status || 'pending',
        installmentNumber: inst.number,
        installmentLabel: inst.label || ('Cuota ' + inst.number),
        proofUploaded: !!inst.proof_path,
        proofUploadedAt: inst.proof_uploaded_at,
        reviewedAt: inst.reviewed_at,
        reviewNotes: inst.review_notes,
        reminderSent: !!inst.notification_sent,
        reminderSentAt: inst.notification_sent_at,
        paymentMethod: plan.payment_method,
        type: 'installment',
      });
    }
  }

  // Sort: overdue first, then by due date ascending
  items.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  // Stats
  const overdue       = items.filter(i => i.daysUntilDue !== null && i.daysUntilDue < 0 && i.status === 'pending').length;
  const dueSoon       = items.filter(i => i.daysUntilDue !== null && i.daysUntilDue >= 0 && i.daysUntilDue <= 7 && i.status === 'pending').length;
  const pendingReview = items.filter(i => i.status === 'proof_uploaded').length;
  const approvedMonth = items.filter(i => {
    if (i.status !== 'approved' || !i.reviewedAt) return false;
    const d = new Date(i.reviewedAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const totalPending  = items.filter(i => i.status === 'pending' || i.status === 'proof_uploaded').reduce((s, i) => s + (i.amount || 0), 0);

  res.json({
    stats: { overdue, dueSoon, pendingReview, approvedMonth, totalPending },
    payments: items,
    total: items.length,
  });
});

// ── Public config endpoint (pixel ID is intentionally public) ─────────────
// MapKit JS token — uses the same .p8 key as APNs
// Search suggestions — extracts unique locations from approved listings
app.get('/api/search-suggestions', (req, res) => {
  const allListings = store.getListings();
  const listings = Array.isArray(allListings) ? allListings : (allListings.listings || []);
  const approved = listings.filter(l => l.status === 'approved');

  const provinces = new Map();
  const cities = new Map();
  const sectors = new Map();

  approved.forEach(l => {
    if (l.province) {
      const key = l.province;
      if (!provinces.has(key)) provinces.set(key, { name: key, type: 'province', count: 0, lat: parseFloat(l.lat) || null, lng: parseFloat(l.lng) || null });
      provinces.get(key).count++;
    }
    if (l.city) {
      const key = `${l.city}|${l.province || ''}`;
      if (!cities.has(key)) cities.set(key, { name: l.city, province: l.province || '', type: 'city', count: 0, lat: parseFloat(l.lat) || null, lng: parseFloat(l.lng) || null });
      cities.get(key).count++;
    }
    if (l.sector) {
      const key = `${l.sector}|${l.city || ''}|${l.province || ''}`;
      if (!sectors.has(key)) sectors.set(key, { name: l.sector, city: l.city || '', province: l.province || '', type: 'sector', count: 0, lat: parseFloat(l.lat) || null, lng: parseFloat(l.lng) || null });
      sectors.get(key).count++;
    }
  });

  const results = [
    ...Array.from(provinces.values()).sort((a, b) => b.count - a.count),
    ...Array.from(cities.values()).sort((a, b) => b.count - a.count),
    ...Array.from(sectors.values()).sort((a, b) => b.count - a.count),
  ];

  res.json({ suggestions: results, total: approved.length });
});

app.get('/api/mapkit-token', (req, res) => {
  try {
    const keyPath = process.env.APNS_KEY_PATH;
    const keyId   = process.env.APNS_KEY_ID;
    const teamId  = process.env.APNS_TEAM_ID;
    if (!keyPath || !keyId || !teamId) return res.status(503).json({ error: 'MapKit not configured' });

    const key = require('fs').readFileSync(keyPath, 'utf8');
    const token = require('jsonwebtoken').sign(
      { iss: teamId, iat: Math.floor(Date.now() / 1000), origin: process.env.NODE_ENV === 'production' ? (process.env.BASE_URL || `https://${req.get('host')}`) : `${req.protocol}://${req.get('host')}` },
      key,
      { algorithm: 'ES256', expiresIn: '1h', header: { alg: 'ES256', kid: keyId, typ: 'JWT' } }
    );
    res.json({ token });
  } catch (err) {
    console.error('[MapKit] Token error:', err.message);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

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
const uploadLimiter = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: 20, message: { error: 'Demasiadas subidas. Intenta más tarde.' } });
app.post('/api/upload/photos', uploadLimiter, photoUpload.array('photos', 30), async (req, res) => {
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
  const safe = err.code === 'LIMIT_FILE_SIZE' ? 'Archivo demasiado grande' :
               err.code === 'LIMIT_FILE_COUNT' ? 'Demasiados archivos' :
               err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Campo de archivo inesperado' :
               'Error al subir archivo';
  res.status(400).json({ error: safe });
});

// ── Blueprint upload endpoint ──────────────────────────────────
app.post('/api/upload/blueprints', uploadLimiter, blueprintUpload.array('blueprints', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No se recibieron archivos.' });
  }
  const urls = req.files.map(f => `/uploads/blueprints/${f.filename}`);
  res.json({ urls });
}, (err, req, res, next) => {
  const safe = err.code === 'LIMIT_FILE_SIZE' ? 'Archivo demasiado grande' :
               err.code === 'LIMIT_FILE_COUNT' ? 'Demasiados archivos' :
               'Error al subir archivo';
  res.status(400).json({ error: safe });
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
} else if (!/^[a-zA-Z0-9_-]+$/.test(ADMIN_PATH)) {
  console.error('❌  ADMIN_PATH contains invalid characters — admin panel disabled');
}

// Mount admin auth API under the secret path
if (ADMIN_PATH && /^[a-zA-Z0-9_-]+$/.test(ADMIN_PATH)) {
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
app.get('/alquilar',          (req, res) => res.redirect(301, '/comprar?type=alquiler'));
app.get('/comparar',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'comparar.html')));
app.get('/busquedas-guardadas',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'busquedas-guardadas.html')));
app.get('/mapa',              (req, res) => res.redirect(301, '/comprar'));
app.get('/nuevos-proyectos',  (req, res) => res.redirect(301, '/comprar?type=proyecto'));
app.get('/profile',           (req, res) => res.redirect('/broker#perfil'));
app.get('/listing/:id',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'listing.html')));
app.get('/inmobiliaria/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inmobiliaria.html')));
app.get('/resena/:inmId',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'resena.html')));
app.get('/ciudades',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'ciudades.html')));
app.get('/ciudad/:slug',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'ciudad.html')));
app.get('/contacto',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'contacto.html')));
app.get('/terminos',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos.html')));
app.get('/privacidad',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidad.html')));
app.get('/blog',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog.html')));
app.get('/blog/:slug',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'post.html')));
app.get('/broker',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'broker.html')));
app.get('/my-applications',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'my-applications.html')));
app.get('/tareas',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'tareas.html')));
app.get('/verify-email',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'verify-email.html')));
app.get('/register-success',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'register-success.html')));
app.get('/subscribe',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscribe.html')));
app.get('/subscription',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscription.html')));
app.get('/mensajes',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'mensajes.html')));

// Generate professional listing ID: 2 uppercase letters + 4 digits (e.g., MR3456, KP8901)
function generateListingId() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O to avoid confusion with 1 and 0
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const num = Math.floor(1000 + Math.random() * 9000); // 4-digit number, 1000-9999
  const id = `${l1}${l2}${num}`;
  // Check for collision (extremely unlikely but safe)
  if (store.getListingById(id)) return generateListingId();
  return id;
}

app.post('/submit', require('./routes/auth').optionalAuth, async (req, res) => {
  const body = req.body;
  const isClaim = body.submission_type === 'agency_claim';

  // Paywall: if a logged-in pro user submits a new property, they must
  // have an active subscription. Guests and agency claims are allowed.
  if (req.user?.sub && !isClaim) {
    const user = store.getUserById(req.user.sub);
    const proRoles = ['agency', 'broker', 'inmobiliaria', 'constructora'];
    if (user && proRoles.includes(user.role)) {
      const status = user.subscriptionStatus || 'none';
      const paywallRequired = user.paywallRequired === true;
      const trialActive = status === 'trial' && user.trialEndsAt &&
                          new Date(user.trialEndsAt) > new Date();
      const legacyOk = !paywallRequired && trialActive;
      const paidOk = ['active', 'trialing'].includes(status);
      if (!legacyOk && !paidOk) {
        return res.status(402).json({
          error: 'Necesitas una suscripcion activa para publicar propiedades.',
          needsSubscription: true,
        });
      }
    }
  }

  const submission = {
    id:              generateListingId(),
    creator_user_id: req.user?.sub || null,
    submission_type: isClaim ? 'agency_claim' : 'new_property',
    // Agency claim fields
    claim_listing_id: isClaim ? (body.claim_listing_id || '') : undefined,
    // Property fields (only for new_property)
    title:       isClaim ? '' : (body.title       || ''),
    type:        isClaim ? '' : (body.type         || ''),
    condition:   isClaim ? '' : (body.condition    || ''),
    description: isClaim ? '' : (body.description  || ''),
    price:       isClaim ? '' : (body.price        || ''),
    // Optional upper bound — lets projects advertise a price RANGE
    // ("from $90,000 to $150,000") without locking in a single price.
    // Empty string when the listing is a single unit with one price.
    priceMax:    isClaim ? '' : (body.priceMax     || ''),
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
    const adminEmailBody = isClaim
      ? et.infoTable(
          et.infoRow('Tipo', 'Solicitud de Agencia') +
          et.infoRow('Anuncio ID', et.esc(submission.claim_listing_id))
        )
      : et.infoTable(
          et.infoRow('Titulo', et.esc(submission.title)) +
          et.infoRow('Tipo', et.esc(submission.type)) +
          et.infoRow('Precio', '$' + Number(submission.price).toLocaleString()) +
          et.infoRow('Ubicacion', et.esc(submission.city + ', ' + submission.province)) +
          et.infoRow('Habitaciones', submission.bedrooms + ' hab. / ' + submission.bathrooms + ' banos') +
          et.infoRow('Amenidades', et.esc(amenitiesList || 'Ninguna'))
        );

    const adminHtml = et.layout({
      title: isClaim ? 'Solicitud de Agencia' : 'Nueva Propiedad para Aprobar',
      subtitle: 'Panel de Administracion',
      preheader: 'Nueva propiedad pendiente de aprobacion',
      headerColor: et.C.red,
      body:
        adminEmailBody +
        et.divider() +
        et.infoTable(
          et.infoRow('Contacto', `${et.esc(submission.name)}`) +
          et.infoRow('Email', et.esc(submission.email)) +
          et.infoRow('Telefono', et.esc(submission.phone))
        ) +
        et.button('Revisar y Aprobar', adminPanelUrl, et.C.red) +
        et.small('Enviado el ' + new Date(submission.submittedAt).toLocaleString('es-DO') + ' — ID: ' + submission.id),
    });

    await transporter.sendMail({
      department: 'admin',
      to:      ADMIN_EMAIL,
      subject: isClaim
        ? `[IMPORTANTE] Solicitud de agencia — Anuncio #${submission.claim_listing_id}`
        : `[Accion Requerida] Nueva propiedad para aprobar: ${submission.title}`,
      headers: {
        'X-Priority':        '1',
        'X-MSMail-Priority': 'High',
        'Importance':        'High',
      },
      html: adminHtml,
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
  // Guard: a listing that's currently waiting on agent edits should
  // NOT be approvable — the admin explicitly asked for corrections
  // and approving now would skip the review loop. Force the agent to
  // resubmit first (which will flip the status back to 'pending').
  if (sub.status === 'edits_requested') {
    return res.status(400).json({
      error: 'No se puede aprobar una propiedad con ediciones solicitadas. Espera a que el agente reenvíe las correcciones.',
      code:  'listing_awaiting_edits',
    });
  }
  sub.status     = 'approved';
  sub.approvedAt = new Date().toISOString();

  // ── Auto-generate inventory units from unit_types ──────────────
  // If the listing was submitted with unit types (e.g., "Penthouse 3BR × 5"),
  // auto-create individual inventory units so the broker doesn't have to add
  // them one by one. Only runs if no inventory already exists.
  const unitTypes = Array.isArray(sub.unit_types) ? sub.unit_types : [];
  if (unitTypes.length > 0 && (!Array.isArray(sub.unit_inventory) || sub.unit_inventory.length === 0)) {
    const inventory = [];
    for (const ut of unitTypes) {
      const count = parseInt(ut.available) || 0;
      const baseName = (ut.name || 'Unidad').trim();
      // Use custom unit IDs if the broker provided them, otherwise auto-generate
      const customIds = Array.isArray(ut.unitIds) ? ut.unitIds.filter(Boolean) : [];
      // Floors can either be a single number applied to every unit
      // in this type, or a per-unit array matching customIds length.
      const floorArr = Array.isArray(ut.floors) ? ut.floors : [];
      const floorSingle = ut.floor || '';
      for (let i = 1; i <= count; i++) {
        const label = customIds[i - 1] || `${baseName}-${String(i).padStart(2, '0')}`;
        const unitFloor = floorArr[i - 1] || floorSingle || '';
        inventory.push({
          id:            'unit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          label,
          type:          `${baseName}${ut.bedrooms ? ' · ' + ut.bedrooms + ' hab.' : ''}${ut.area ? ' · ' + ut.area + ' m²' : ''}`,
          floor:         String(unitFloor || ''),
          notes:         ut.price ? `Precio: $${Number(ut.price).toLocaleString()}` : '',
          status:        'available',
          applicationId: null,
          clientName:    null,
          createdAt:     new Date().toISOString(),
        });
      }
    }
    if (inventory.length > 0) {
      sub.unit_inventory  = inventory;
      sub.units_available = inventory.length;
      console.log(`[approve] Auto-generated ${inventory.length} inventory unit(s) for listing ${sub.id} from ${unitTypes.length} type(s)`);
    }
  }

  store.saveListing(sub);
  res.json({ success: true });

  // Create contribution scores for cascade system
  const cascadeEngine = require('./routes/cascade-engine');
  if (cascadeEngine.isEnabled()) {
    const nowISO = new Date().toISOString();
    // Creator gets 50 points
    if (sub.creator_user_id) {
      store.saveContributionScore({
        id: 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        user_id: sub.creator_user_id,
        listing_id: sub.id,
        role: 'creator',
        score: 50,
        score_breakdown: { creator_bonus: 50 },
        avg_response_ms: null,
        response_count: 0,
        created_at: nowISO,
        updated_at: nowISO,
        _extra: {},
      });
    }
    // Affiliated agencies get 0 points (entry created for cascade eligibility)
    const agencies = Array.isArray(sub.agencies) ? sub.agencies : [];
    for (const agency of agencies) {
      if (agency.user_id && agency.user_id !== sub.creator_user_id) {
        store.saveContributionScore({
          id: 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
          user_id: agency.user_id,
          listing_id: sub.id,
          role: 'affiliate',
          score: 0,
          score_breakdown: {},
          avg_response_ms: null,
          response_count: 0,
          created_at: nowISO,
          updated_at: nowISO,
          _extra: {},
        });
      }
    }
  }

  // Broadcast push notification to all subscribed users
  const { broadcastNewListing } = require('./routes/push');
  broadcastNewListing(sub).catch(() => {});
});

app.post('/admin/submissions/:id/reject', adminSessionAuth, (req, res) => {
  const sub = store.getListingById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });
  sub.status     = 'rejected';
  sub.rejectedAt = new Date().toISOString();
  store.saveListing(sub);
  res.json({ success: true });
});

// ── Admin: Request edits on a submission ───────────────────────────────
// Instead of rejecting outright, the admin can send a listing back to the
// owner with a note explaining what needs to be fixed. The owner sees it
// in their broker dashboard, edits the fields, and resubmits (which flips
// status back to 'pending' for re-review).
app.post('/admin/submissions/:id/request-edits', adminSessionAuth, (req, res) => {
  const sub = store.getListingById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });

  const reason = (req.body?.reason || '').toString().trim().slice(0, 1000);
  if (!reason) {
    return res.status(400).json({ error: 'Se requiere una nota explicando qué debe editarse' });
  }

  sub.status            = 'edits_requested';
  sub.editsRequestedAt  = new Date().toISOString();
  sub.editsReason       = reason;
  sub.editsHistory      = Array.isArray(sub.editsHistory) ? sub.editsHistory : [];
  sub.editsHistory.push({
    at:     sub.editsRequestedAt,
    reason,
    by:     'admin',
  });

  store.saveListing(sub);
  res.json({ success: true });

  // Notify the owner by email (fire-and-forget)
  try {
    const ownerUserId = sub.creator_user_id || null;
    const owner = ownerUserId ? store.getUserById(ownerUserId) : null;
    const ownerEmail = owner?.email || sub.email;
    if (ownerEmail && transporter) {
      const safeReason = reason.replace(/</g,'&lt;').replace(/\n/g,'<br>');
      const subject = `Se solicitaron ediciones en tu propiedad — HogaresRD`;
      const html = et.layout({
        title: 'Se solicitaron ediciones',
        subtitle: et.esc(sub.title || 'sin titulo'),
        preheader: 'Tu publicacion requiere ajustes antes de ser aprobada',
        headerColor: '#b45309',
        body:
          et.p('Revisamos tu publicacion <strong>' + et.esc(sub.title || 'sin titulo') + '</strong> y necesitamos que hagas algunos ajustes antes de publicarla:') +
          et.alertBox(safeReason, 'warning') +
          et.p('Ingresa a tu panel, edita los campos necesarios y vuelve a enviar la publicacion. La pondremos en la cola de revision automaticamente.') +
          et.button('Editar mi propiedad', (process.env.BASE_URL || 'https://hogaresrd.com') + '/broker#pending-listings'),
      });
      transporter.sendMail({
        department: 'soporte',
        to: ownerEmail,
        subject,
        html,
      }).catch(e => console.error('[request-edits] email error:', e.message));
    }
  } catch (e) {
    console.error('[request-edits] notify error:', e.message);
  }
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

// ── Admin: Delete user account ──────────────────────────────────────────
app.delete('/admin/users/:id', adminSessionAuth, async (req, res) => {
  const user = store.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const summary = await store.deleteUserCascade(req.params.id);
  summary.user = user.email;
  console.log(`[admin] Deleted user ${user.email} (${user.role}) — ${JSON.stringify(summary)}`);
  res.json({ success: true, deleted: summary });
});

// ── Admin: Data Deletion Requests ──────────────────────────────────────
// Users can request data deletion. Admin can review, process, or export.

app.get('/admin/deletion-requests', adminSessionAuth, (req, res) => {
  const requests = store.getDeletionRequests().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(requests);
});

app.post('/admin/deletion-requests/:id/process', adminSessionAuth, async (req, res) => {
  const dr = store.getDeletionRequestById(req.params.id);
  if (!dr) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (dr.status === 'completed') return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });

  // Delete the user and all their data via unified cascade function
  const user = store.getUserById(dr.user_id);
  if (user) {
    await store.deleteUserCascade(dr.user_id);
    console.log(`[admin] Processed deletion request ${dr.id} for ${dr.user_email}`);
  }

  dr.status = 'completed';
  dr.processed_at = new Date().toISOString();
  dr.processed_by = 'admin';
  store.saveDeletionRequest(dr);
  res.json({ success: true });
});

// ── Admin: Privacy / CCPA compliance log ───────────────────────────────
app.get('/admin/privacy-log', adminSessionAuth, (req, res) => {
  const log = store.getPrivacyLog().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const optedOut = store.getUsers().filter(u => u.doNotSell).length;
  res.json({ log, stats: { total: log.length, optedOut } });
});

app.get('/api/admin/conversation-access-log', adminSessionAuth, (req, res) => {
  try {
    const fs = require('fs');
    const logPath = require('path').join(__dirname, 'data', 'security_log.json');
    let events = [];
    try { events = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { events = []; }
    const accessLog = events
      .filter(e => e.type === 'admin_conversation_access')
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ log: accessLog });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el registro' });
  }
});

app.post('/admin/deletion-requests/:id/reject', adminSessionAuth, (req, res) => {
  const dr = store.getDeletionRequestById(req.params.id);
  if (!dr) return res.status(404).json({ error: 'Solicitud no encontrada' });
  dr.status = 'rejected';
  dr.processed_at = new Date().toISOString();
  dr.processed_by = 'admin';
  store.saveDeletionRequest(dr);
  res.json({ success: true });
});

// ── Admin: Delete listing ──────────────────────────────────────────────
app.delete('/admin/catalogue/:id', adminSessionAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Anuncio no encontrado' });

  store.deleteListing(req.params.id);
  console.log(`[admin] Deleted listing "${listing.title}" (${req.params.id})`);
  res.json({ success: true, deleted: { id: req.params.id, title: listing.title } });
});

// ══════════════════════════════════════════════════════════════════
// ── Admin: Applications oversight ────────────────────────────────
// ══════════════════════════════════════════════════════════════════
//
// Admins get an unfiltered view of every application in the database
// plus the ability to reassign one to a different broker. This is
// useful when:
//   - a cascade fallback didn't reach the right agent
//   - a broker leaves the platform and their apps need to be handed off
//   - a client requests a specific agent

// GET /admin/applications — list every application
app.get('/admin/applications', adminSessionAuth, (req, res) => {
  const apps = store.getApplications() || [];
  // Optional status filter (?status=aplicado for example)
  const { status, q } = req.query;
  let filtered = apps;
  if (status) filtered = filtered.filter(a => a.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    filtered = filtered.filter(a =>
      (a.client?.name || '').toLowerCase().includes(needle) ||
      (a.client?.email || '').toLowerCase().includes(needle) ||
      (a.listing_title || '').toLowerCase().includes(needle) ||
      (a.broker?.name || '').toLowerCase().includes(needle) ||
      (a.id || '').toLowerCase().includes(needle)
    );
  }
  // Newest first
  filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  res.json(filtered);
});

// PUT /admin/applications/:id/reassign — reassign to a different broker
// body: { user_id: "usr_xxx" }  (required)
app.put('/admin/applications/:id/reassign', adminSessionAuth, (req, res) => {
  const app_ = store.getApplicationById(req.params.id);
  if (!app_) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

  const newBroker = store.getUserById(user_id);
  if (!newBroker) return res.status(404).json({ error: 'Usuario no encontrado' });

  const proRoles = ['agency', 'broker', 'inmobiliaria', 'constructora'];
  if (!proRoles.includes(newBroker.role)) {
    return res.status(400).json({ error: 'El usuario seleccionado no es un agente/inmobiliaria' });
  }

  const oldBroker = { ...(app_.broker || {}) };
  app_.broker = {
    user_id:     newBroker.id,
    name:        newBroker.name || '',
    email:       newBroker.email || '',
    phone:       newBroker.phone || '',
    agency_name: newBroker.agencyName || newBroker.companyName || '',
  };

  // Inherit inmobiliaria affiliation from the new broker
  app_.inmobiliaria_id   = newBroker.inmobiliaria_id || (['inmobiliaria','constructora'].includes(newBroker.role) ? newBroker.id : null);
  app_.inmobiliaria_name = newBroker.inmobiliaria_name || (['inmobiliaria','constructora'].includes(newBroker.role) ? (newBroker.companyName || newBroker.name) : null);
  app_.updated_at        = new Date().toISOString();

  // Log the reassignment in the timeline
  if (!Array.isArray(app_.timeline_events)) app_.timeline_events = [];
  app_.timeline_events.push({
    id:          'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    type:        'reassigned',
    description: `Reasignada por el administrador: de ${oldBroker.name || 'sin asignar'} a ${newBroker.name}`,
    actor:       'admin',
    actor_name:  'Administrador',
    data:        { from: oldBroker.user_id || null, to: newBroker.id },
    created_at:  app_.updated_at,
  });

  store.saveApplication(app_);

  // Fire-and-forget notifications
  try {
    const transporter = _createMailTransport();
    const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';
    const htmlTo = et.layout({
      title: 'Nueva Aplicacion Asignada',
      subtitle: et.esc(app_.listing_title),
      preheader: 'Se te asigno una nueva aplicacion',
      body:
        et.p('Se te ha asignado una nueva aplicacion para gestionar.') +
        et.infoTable(
          et.infoRow('Propiedad', et.esc(app_.listing_title)) +
          et.infoRow('Precio', '$' + Number(app_.listing_price || 0).toLocaleString()) +
          et.infoRow('Cliente', et.esc(app_.client.name)) +
          et.infoRow('Telefono', et.esc(app_.client.phone)) +
          et.infoRow('Email', et.esc(app_.client.email || 'N/A'))
        ) +
        et.button('Ver en Dashboard', BASE_URL + '/broker'),
    });
    if (newBroker.email && transporter?.sendMail) {
      transporter.sendMail({
        department: 'admin',
        to:         newBroker.email,
        subject:    `Aplicacion asignada — ${app_.listing_title}`,
        html:       htmlTo,
      }).catch(e => console.error('[reassign] notify-new error:', e.message));
    }
    // Best-effort push notification
    try {
      const { notify: pushNotify } = require('./routes/push');
      pushNotify(newBroker.id, {
        type:  'new_application',
        title: 'Aplicación reasignada',
        body:  `${app_.client.name} aplicó para ${app_.listing_title}`,
        url:   '/broker.html',
      });
    } catch (_) {}
  } catch (e) {
    console.error('[reassign] notify error:', e.message);
  }

  console.log(`[admin] Reassigned application ${app_.id} → ${newBroker.email}`);
  res.json({ success: true, application: app_ });
});

// ── Admin: Bulk delete users ───────────────────────────────────────────
app.post('/admin/users/bulk-delete', adminSessionAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Se requiere un arreglo de IDs' });

  const deleted = [];
  for (const id of ids) {
    const user = store.getUserById(id);
    if (!user) continue;
    const savedSearches = store.getSavedSearchesByUser(id);
    const tasks = store.getTasksByUser(id);
    for (const s of savedSearches) store.deleteSavedSearch(s.id);
    for (const t of tasks) store.deleteTask(t.id);
    store.deleteUser(id);
    deleted.push(user.email);
    console.log(`[admin] Bulk-deleted user ${user.email}`);
  }
  res.json({ success: true, deleted });
});

// ── Admin: Bulk delete listings ────────────────────────────────────────
app.post('/admin/catalogue/bulk-delete', adminSessionAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Se requiere un arreglo de IDs' });

  const deleted = [];
  for (const id of ids) {
    const listing = store.getListingById(id);
    if (!listing) continue;
    store.deleteListing(id);
    deleted.push({ id, title: listing.title });
    console.log(`[admin] Bulk-deleted listing "${listing.title}"`);
  }
  res.json({ success: true, deleted });
});

// ── Newsletter admin ────────────────────────────────────────────────────────
// ── Admin: Reports ─────────────────────────────────────────────
// ── Admin Cascade Dashboard ─────────────────────────────────────────────
app.get('/admin/cascade', adminSessionAuth, (req, res) => {
  const queue = store.getLeadQueue();
  const scores = store.getContributionScores();
  const users = store.getUsers();
  const listings = store.getAllSubmissions();

  // Build user lookup
  const userMap = {};
  for (const u of users) userMap[u.id] = u;

  // Enrich queue items
  const enrichedQueue = queue.map(q => {
    const listing = listings.find(l => l.id === q.listing_id);
    const claimer = q.claimed_by ? userMap[q.claimed_by] : null;
    return {
      id: q.id,
      inquiry_type: q.inquiry_type,
      listing_id: q.listing_id,
      listing_title: listing?.title || '—',
      buyer_name: q.buyer_name || '—',
      buyer_email: q.buyer_email || '',
      current_tier: q.current_tier,
      status: q.status,
      claimed_by: q.claimed_by,
      claimer_name: claimer?.name || '',
      claimed_at: q.claimed_at,
      auto_responded_at: q.auto_responded_at,
      created_at: q.created_at,
    };
  }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  // Aggregate agent scores across all listings
  const agentScores = {};
  for (const cs of scores) {
    if (!agentScores[cs.user_id]) {
      const user = userMap[cs.user_id];
      agentScores[cs.user_id] = {
        user_id: cs.user_id,
        name: user?.name || '—',
        email: user?.email || '',
        role: user?.role || '',
        agency: user?.agency?.name || user?.inmobiliaria_name || '',
        total_score: 0,
        listings_count: 0,
        creator_count: 0,
        affiliate_count: 0,
        avg_response_ms: null,
        total_responses: 0,
        claims: 0,
      };
    }
    const a = agentScores[cs.user_id];
    a.total_score += cs.score || 0;
    a.listings_count++;
    if (cs.role === 'creator') a.creator_count++;
    else a.affiliate_count++;
    if (cs.response_count) {
      a.total_responses += cs.response_count;
      const prevTotal = a.avg_response_ms ? a.avg_response_ms * (a.total_responses - cs.response_count) : 0;
      a.avg_response_ms = Math.round((prevTotal + (cs.avg_response_ms || 0) * cs.response_count) / a.total_responses);
    }
  }

  // Count claims per agent
  for (const q of queue) {
    if (q.status === 'claimed' && q.claimed_by && agentScores[q.claimed_by]) {
      agentScores[q.claimed_by].claims++;
    }
  }

  const agents = Object.values(agentScores).sort((a, b) => b.total_score - a.total_score);

  // Summary stats
  const stats = {
    total: queue.length,
    active: queue.filter(q => q.status === 'active').length,
    claimed: queue.filter(q => q.status === 'claimed').length,
    auto_responded: queue.filter(q => q.status === 'auto_responded').length,
    agents_count: agents.length,
    avg_claim_time_ms: null,
  };

  const claimedItems = queue.filter(q => q.status === 'claimed' && q.claimed_at);
  if (claimedItems.length) {
    const totalMs = claimedItems.reduce((sum, q) => {
      const tierField = `tier${q.current_tier}_notified_at`;
      const notified = q[tierField];
      if (!notified) return sum;
      return sum + (new Date(q.claimed_at).getTime() - new Date(notified).getTime());
    }, 0);
    stats.avg_claim_time_ms = Math.round(totalMs / claimedItems.length);
  }

  // Per-listing score breakdown
  const listingScores = {};
  for (const cs of scores) {
    if (!listingScores[cs.listing_id]) {
      const listing = listings.find(l => l.id === cs.listing_id);
      listingScores[cs.listing_id] = { listing_id: cs.listing_id, title: listing?.title || '—', agents: [] };
    }
    const user = userMap[cs.user_id];
    listingScores[cs.listing_id].agents.push({
      user_id: cs.user_id,
      name: user?.name || '—',
      role: cs.role,
      score: cs.score,
      breakdown: cs.score_breakdown || {},
      avg_response_ms: cs.avg_response_ms,
      response_count: cs.response_count || 0,
    });
  }

  res.json({ stats, queue: enrichedQueue, agents, listings: Object.values(listingScores) });
});

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

// Admin: subscriber list + manual unsubscribe
app.get('/admin/newsletter/subscribers', adminSessionAuth, (req, res) => {
  const users = store.getUsers().map(u => ({
    id: u.id, email: u.email, name: u.name, role: u.role,
    marketingOptIn: !!u.marketingOptIn, emailVerified: !!u.emailVerified,
  }));
  res.json(users);
});

app.post('/admin/newsletter/unsubscribe', adminSessionAuth, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  const user = store.getUserByEmail(email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.marketingOptIn = false;
  store.saveUser(user);
  store.appendPrivacyLog({
    id: 'priv_' + require('crypto').randomBytes(8).toString('hex'),
    user_id: user.id, user_email: user.email,
    request_type: 'email_unsubscribe', status: 'completed',
    source: 'admin_manual', details: {},
    created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  });
  console.log(`[newsletter] Admin unsubscribed: ${user.email}`);
  res.json({ success: true });
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

// ── Blog image upload ────────────────────────────────────────────
const blogUploadDir = path.join(__dirname, 'public/uploads/blog');
fsp.mkdir(blogUploadDir, { recursive: true }).catch(() => {});
const blogImgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Solo imágenes')),
});
app.post('/admin/blog/upload', adminSessionAuth, blogImgUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image' });
  try {
    const fname = `blog_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webp`;
    await sharp(req.file.buffer).resize(1200, null, { withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(blogUploadDir, fname));
    res.json({ url: `/uploads/blog/${fname}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    id:               body.id || uuidv4(),
    slug,
    title:            body.title,
    excerpt:          body.excerpt || '',
    content:          body.content || '',
    category:         body.category || 'general',
    cover_image:      body.cover_image || '',
    author:           body.author || 'Equipo HogaresRD',
    read_time:        parseInt(body.read_time) || 5,
    featured:         !!body.featured,
    status:           body.status || 'draft',
    tags:             body.tags || '',
    meta_description: (body.meta_description || '').slice(0, 160),
    publish_at:       body.publish_at || null,
    published_at:     body.status === 'published' ? new Date().toISOString() : null,
    created_at:       new Date().toISOString(),
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
  const { verifyUnsubToken } = require('./routes/newsletter');
  const userId = verifyUnsubToken(token);
  const user = userId ? store.getUserById(userId) : null;
  if (!user) {
    return res.status(400).send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>HogaresRD</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 20px;color:#1a2b40;"><h2>Enlace inválido o expirado.</h2><p><a href="/home">Volver al inicio</a></p></body></html>`);
  }
  user.marketingOptIn = false;
  store.saveUser(user);

  // Log for CAN-SPAM/CCPA compliance
  store.appendPrivacyLog({
    id:           'priv_' + require('crypto').randomBytes(8).toString('hex'),
    user_id:      user.id,
    user_email:   user.email,
    request_type: 'email_unsubscribe',
    status:       'completed',
    source:       'email_link',
    details:      {},
    created_at:   new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });
  console.log(`[newsletter] Unsubscribed: ${user.email} (email link)`);

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

// ── Tour reminders — runs every 30 min, sends 24h + 1h reminders ──────────
cron.schedule('*/30 * * * *', () => {
  try {
    const { notify: pushNotify } = require('./routes/push');
    const { createTransport } = require('./routes/mailer');
    const mailer = createTransport();
    const now = new Date();

    // Check today and tomorrow for confirmed tours
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const tours = [
      ...store.getConfirmedToursByDate(today),
      ...store.getConfirmedToursByDate(tomorrow),
    ];

    let sent = 0;
    for (const tour of tours) {
      const tourDateTime = new Date(`${tour.requested_date}T${tour.requested_time}:00-04:00`); // DR timezone
      const hoursUntil = (tourDateTime - now) / (1000 * 60 * 60);

      const reminders = tour.reminder_sent ? tour.reminder_sent.split(',') : [];

      // 24h reminder (between 23–25h before)
      if (hoursUntil >= 23 && hoursUntil <= 25 && !reminders.includes('24h')) {
        reminders.push('24h');
        const msg = `Recordatorio: tienes una visita mañana a las ${tour.requested_time} — ${tour.listing_title}`;
        if (tour.client_id) pushNotify(tour.client_id, { type: 'tour_reminder', title: 'Visita Mañana', body: msg, url: '/profile' });
        pushNotify(tour.broker_id, { type: 'tour_reminder', title: 'Visita Mañana', body: `${tour.client_name} — ${msg}`, url: '/broker.html' });

        const clientEmail = tour.client_email || (tour.client_id ? store.getUserById(tour.client_id)?.email : null);
        if (clientEmail) {
          mailer.sendMail({ to: clientEmail, subject: `Recordatorio de visita manana — ${tour.listing_title}`, department: 'noreply',
            html: et.layout({
              title: 'Recordatorio de Visita',
              subtitle: 'Tienes una visita programada para manana',
              preheader: 'Tienes una visita programada para manana',
              body:
                et.p('Tu visita a <strong>' + et.esc(tour.listing_title) + '</strong> esta programada para manana.') +
                et.infoTable(
                  et.infoRow('Propiedad', et.esc(tour.listing_title)) +
                  et.infoRow('Fecha', et.esc(tour.requested_date)) +
                  et.infoRow('Hora', et.esc(tour.requested_time))
                ) +
                et.small('Te recomendamos llegar 5 minutos antes de la hora programada.'),
            }),
          }).catch(() => {});
        }
        sent++;
      }

      // 1h reminder (between 45min–75min before)
      if (hoursUntil >= 0.75 && hoursUntil <= 1.25 && !reminders.includes('1h')) {
        reminders.push('1h');
        const msg = `Tu visita a ${tour.listing_title} es en 1 hora (${tour.requested_time})`;
        if (tour.client_id) pushNotify(tour.client_id, { type: 'tour_reminder', title: 'Visita en 1 Hora', body: msg, url: '/profile' });
        pushNotify(tour.broker_id, { type: 'tour_reminder', title: 'Visita en 1 Hora', body: `${tour.client_name} — ${msg}`, url: '/broker.html' });
        sent++;
      }

      // Update reminder_sent
      if (reminders.length > 0) {
        tour.reminder_sent = reminders.join(',');
        tour.updated_at = new Date().toISOString();
        store.saveTour(tour);
      }
    }
    if (sent > 0) console.log(`[Cron] Sent ${sent} tour reminder(s)`);
  } catch (e) {
    console.error('[Cron] Tour reminder error:', e.message);
  }
}, { timezone: 'America/Santo_Domingo' });

// ── Payment reminders — runs daily at 8 AM DR time ────────────────────────
cron.schedule('0 8 * * *', () => {
  try {
    const allApps = store.getApplications();
    const now = new Date();
    const mailTransport = require('./routes/mailer').createTransport();
    let sent = 0;

    for (const app of allApps) {
      const plan = app.payment_plan;
      if (!plan || !Array.isArray(plan.installments)) continue;
      const client = app.client || {};
      if (!client.email) continue;

      for (const inst of plan.installments) {
        if (inst.status !== 'pending' || !inst.due_date) continue;

        const dueDate = new Date(inst.due_date);
        const daysUntil = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

        // Skip if already reminded today
        if (inst.notification_sent_at) {
          const lastReminder = new Date(inst.notification_sent_at);
          if (now - lastReminder < 20 * 60 * 60 * 1000) continue; // less than 20h ago
        }

        let subject = null;
        let urgency = '';

        if (daysUntil === 3) {
          subject = `Recordatorio: Pago en 3 dias — ${inst.label || 'Cuota ' + inst.number}`;
          urgency = 'Tu pago esta programado para dentro de 3 dias.';
        } else if (daysUntil === 0) {
          subject = `Pago vence hoy — ${inst.label || 'Cuota ' + inst.number}`;
          urgency = 'Tu pago vence HOY. Por favor sube tu comprobante lo antes posible.';
        } else if (daysUntil === -1) {
          subject = `Pago vencido — ${inst.label || 'Cuota ' + inst.number}`;
          urgency = 'Tu pago esta vencido. Por favor realiza el pago y sube el comprobante.';
        }

        if (!subject) continue;

        const firstName = (client.name || '').split(' ')[0] || 'Cliente';
        const formattedAmount = (inst.amount || 0).toLocaleString('es-DO');
        const formattedDate = new Date(inst.due_date).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });

        const alertType = daysUntil < 0 ? 'danger' : daysUntil === 0 ? 'warning' : 'info';
        mailTransport.sendMail({
          to: client.email,
          subject: subject + ' — HogaresRD',
          department: 'noreply',
          html: et.layout({
            title: subject,
            preheader: 'Tienes un pago pendiente',
            body:
              et.p('Hola ' + et.esc(firstName) + ',') +
              et.alertBox(urgency, alertType) +
              et.infoTable(
                et.infoRow('Propiedad', et.esc(app.listing_title || '—')) +
                et.infoRow('Cuota', et.esc(inst.label || 'Cuota ' + inst.number)) +
                et.infoRow('Monto', (plan.currency || 'DOP') + ' $' + formattedAmount) +
                et.infoRow('Fecha limite', et.esc(formattedDate)) +
                (plan.payment_method ? et.infoRow('Metodo de pago', et.esc(plan.payment_method + (plan.method_details ? ' — ' + plan.method_details : ''))) : '')
              ) +
              et.button('Ver mis pagos', (process.env.BASE_URL || 'https://hogaresrd.com') + '/my-applications') +
              et.small('Si ya realizaste el pago, puedes ignorar este mensaje.'),
          }),
        }).catch(err => console.error('[Cron] Payment reminder email error:', err.message));

        // Mark reminder sent
        inst.notification_sent = true;
        inst.notification_sent_at = now.toISOString();
        sent++;
      }

      // Save if any installments were updated
      if (sent > 0) store.saveApplication(app);
    }

    if (sent > 0) console.log(`[Cron] Payment reminders sent: ${sent}`);
  } catch (e) {
    console.error('[Cron] Payment reminder error:', e.message);
  }
}, { timezone: 'America/Santo_Domingo' });

// Also send reminders on 1st of month for all pending payments
cron.schedule('0 9 1 * *', () => {
  try {
    const allApps = store.getApplications();
    const mailTransport = require('./routes/mailer').createTransport();
    let sent = 0;

    for (const app of allApps) {
      const plan = app.payment_plan;
      if (!plan || !Array.isArray(plan.installments)) continue;
      const client = app.client || {};
      if (!client.email) continue;

      const pendingInstallments = plan.installments.filter(i => i.status === 'pending' && i.due_date);
      if (pendingInstallments.length === 0) continue;

      const firstName = (client.name || '').split(' ')[0] || 'Cliente';
      const summaryRows = pendingInstallments.map(i => {
        const d = new Date(i.due_date).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' });
        return et.infoRow(et.esc(i.label || 'Cuota ' + i.number), (plan.currency || 'DOP') + ' $' + (i.amount || 0).toLocaleString('es-DO') + ' — ' + d);
      }).join('');

      mailTransport.sendMail({
        to: client.email,
        subject: `Resumen mensual de pagos pendientes — HogaresRD`,
        department: 'noreply',
        html: et.layout({
          title: 'Resumen de Pagos Pendientes',
          subtitle: et.esc(app.listing_title || 'Tu propiedad'),
          preheader: 'Resumen de pagos pendientes del mes',
          body:
            et.p('Hola ' + et.esc(firstName) + ', este es tu resumen de pagos pendientes para <strong>' + et.esc(app.listing_title || 'tu propiedad') + '</strong>:') +
            et.infoTable(summaryRows) +
            et.button('Ir a mis pagos', (process.env.BASE_URL || 'https://hogaresrd.com') + '/my-applications'),
        }),
      }).catch(err => console.error('[Cron] Monthly payment summary error:', err.message));
      sent++;
    }

    if (sent > 0) console.log(`[Cron] Monthly payment summaries sent: ${sent}`);
  } catch (e) {
    console.error('[Cron] Monthly payment summary error:', e.message);
  }
}, { timezone: 'America/Santo_Domingo' });

// ── Memory cleanup — runs daily at 3 AM DR time ────────────────────────────
// Prunes expired data that accumulates in memory over time:
//   - Revoked JWT tokens older than 14 days (token TTL)
//   - Expired 2FA sessions
//   - Claimed/expired lead queue items older than 30 days
cron.schedule('0 3 * * *', () => {
  try {
    let cleaned = 0;

    // 1. Prune revoked tokens older than JWT expiry (14 days)
    const revokedCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    if (store._revokedTokens instanceof Set) {
      // Revoked tokens are stored as JTIs; we can't check age from JTI alone.
      // Instead, clear expired tokens from PostgreSQL and reload.
      store.pool.query(`DELETE FROM revoked_tokens WHERE created_at < NOW() - INTERVAL '14 days'`)
        .then(r => { if (r.rowCount) console.log(`[Cleanup] Pruned ${r.rowCount} expired revoked tokens`); })
        .catch(() => {});
    }

    // 2. Prune expired 2FA sessions (older than 10 minutes)
    const twofaCutoff = Date.now() - 10 * 60 * 1000;
    if (Array.isArray(store._twofa)) {
      const before = store._twofa.length;
      store._twofa = store._twofa.filter(s => {
        const exp = s.expiresAt || s.data?.expiresAt;
        return exp && new Date(exp).getTime() > twofaCutoff;
      });
      cleaned += before - store._twofa.length;
    }

    // 3. Prune old lead queue items (claimed/auto_responded > 30 days)
    const lqCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (Array.isArray(store._leadQueue)) {
      const before = store._leadQueue.length;
      store._leadQueue = store._leadQueue.filter(item => {
        if (item.status === 'active') return true; // never prune active cascades
        const created = item.created_at ? new Date(item.created_at).getTime() : Date.now();
        return created > lqCutoff;
      });
      cleaned += before - store._leadQueue.length;
      // Also clean from DB
      store.pool.query(`DELETE FROM lead_queue WHERE status != 'active' AND created_at < NOW() - INTERVAL '30 days'`)
        .catch(() => {});
    }

    if (cleaned > 0) console.log(`[Cleanup] Pruned ${cleaned} expired items from memory`);
  } catch (e) {
    console.error('[Cleanup] Error:', e.message);
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

    const cascadeEngine = require('./routes/cascade-engine');
    if (cascadeEngine.isEnabled()) {
      setTimeout(() => cascadeEngine.recoverStaleCascades(), 5000);
      setInterval(() => cascadeEngine.recoverStaleCascades(), 30000);
      console.log('[cascade] Recovery timer started (30s interval)');
    }

    // ── Transfer request expiration (every 30 min) ──────────────────────────
    // Use targeted DB query to find only conversations with pending transfers
    // instead of iterating ALL conversations in memory.
    const _pushNotifyRef = require('./routes/push').notify;
    setInterval(async () => {
      try {
        const { rows } = await store.pool.query(
          `SELECT id, data FROM conversations
           WHERE data->'transfer_requests' IS NOT NULL
             AND data::text LIKE '%"status":"pending"%'`
        );
        const candidates = rows.map(r => {
          const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
          return { ...d, id: r.id };
        }).filter(c => Array.isArray(c.transfer_requests) && c.transfer_requests.some(tr => tr.status === 'pending'));
        const now = new Date();
        let expiredCount = 0;
        for (const conv of candidates) {
          let dirty = false;
          for (const tr of conv.transfer_requests) {
            if (tr.status === 'pending' && new Date(tr.expiresAt) < now) {
              tr.status = 'expired';
              tr.respondedAt = now.toISOString();
              dirty = true;
              expiredCount++;
              // Notify director that request expired
              try {
                _pushNotifyRef(tr.requestedBy, {
                  type: 'transfer_expired',
                  title: 'Solicitud de transferencia expirada',
                  body: `La solicitud de transferencia para ${conv.propertyTitle || 'una conversacion'} expiro sin respuesta`,
                  url: '/broker',
                });
              } catch (e) { console.warn('[transfer-expiry] push failed:', e.message); }
            }
          }
          if (dirty) {
            conv.updatedAt = now.toISOString();
            store.saveConversation(conv);
          }
        }
        if (expiredCount > 0) console.log(`[transfer-expiry] Expired ${expiredCount} transfer request(s)`);
      } catch (err) {
        console.error('[transfer-expiry] interval error:', err.message);
      }
    }, 30 * 60 * 1000); // every 30 minutes
  });
}

module.exports = app;
