const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');
const store      = require('./store');
const { userAuth } = require('./auth');
const { logSec } = require('./security-log');
const notify     = require('../utils/twilio');
// file-type v16 is the last CJS-compatible release (v17+ is ESM-only)
const { fileTypeFromFile } = require('file-type');

const router    = express.Router();
// ADMIN_KEY removed from applications.js — Sprint 4 scopes it to /admin/* in server.js only.
// Admin access to the applications API uses JWT role='admin' instead.
const BASE_URL  = process.env.BASE_URL || 'http://localhost:3000';

// ── Rate limiter for anonymous application creation (Item 11) ────────────
// 5 new applications per IP per hour — stops spam/flooding without
// impacting legitimate use (real clients submit once per listing).
const appCreateLimiter = rateLimit({
  windowMs:        60 * 60 * 1000, // 1 hour
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Demasiadas solicitudes. Por favor espera antes de enviar otra aplicación.' },
  handler: (req, res, next, options) => {
    logSec('app_spam_blocked', req, { listing_id: req.body?.listing_id });
    res.status(429).json(options.message);
  },
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// ── Constants ─────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();

const DOCUMENT_TYPES = {
  cedula:            'Cédula de Identidad',
  passport:          'Pasaporte',
  income_proof:      'Comprobante de Ingresos',
  bank_statement:    'Estado de Cuenta Bancario',
  employment_letter: 'Carta de Trabajo',
  tax_return:        'Declaración de Impuestos',
  pre_approval:      'Carta de Pre-Aprobación Bancaria',
  proof_of_funds:    'Prueba de Fondos',
  other:             'Otro Documento',
};

const STATUS_LABELS = {
  aplicado:                'Aplicado',
  en_revision:             'En Revisión',
  documentos_requeridos:   'Documentos Requeridos',
  documentos_enviados:     'Documentos Enviados',
  documentos_insuficientes:'Documentos Insuficientes',
  en_aprobacion:           'En Aprobación',
  reservado:               'Reservado',
  aprobado:                'Aprobado',
  pendiente_pago:          'Pendiente de Pago',
  pago_enviado:            'Pago Enviado',
  pago_aprobado:           'Pago Aprobado',
  completado:              'Completado',
  rechazado:               'Rechazado',
};

const STATUS_FLOW = {
  aplicado:                ['en_revision', 'rechazado'],
  en_revision:             ['documentos_requeridos', 'en_aprobacion', 'rechazado'],
  documentos_requeridos:   ['documentos_enviados', 'rechazado'],
  documentos_enviados:     ['en_aprobacion', 'documentos_insuficientes', 'rechazado'],
  documentos_insuficientes:['documentos_requeridos', 'rechazado'],
  en_aprobacion:           ['reservado', 'aprobado', 'rechazado'],
  reservado:               ['aprobado', 'rechazado'],
  aprobado:                ['pendiente_pago', 'rechazado'],
  pendiente_pago:          ['pago_enviado', 'rechazado'],
  pago_enviado:            ['pago_aprobado', 'pendiente_pago', 'rechazado'],
  pago_aprobado:           ['completado'],
  completado:              [],
  rechazado:               ['aplicado'],
};

// ── File upload (documents & receipts) ────────────────────────────
const DOCS_DIR = path.join(__dirname, '..', 'data', 'documents');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

// Allowed MIME types for uploaded documents / receipts / proofs
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf',
]);

// Validate a file's actual MIME type (magic bytes) after multer saves it.
// Deletes the file and returns false if the type is not allowed.
async function validateMime(filePath) {
  try {
    const result = await fileTypeFromFile(filePath);
    // result is undefined for plain-text or unknown formats — block them
    if (!result || !ALLOWED_MIME_TYPES.has(result.mime)) {
      fs.unlink(filePath, () => {}); // async delete, ignore errors
      return false;
    }
    return true;
  } catch {
    fs.unlink(filePath, () => {});
    return false;
  }
}

// Guard a file path against path-traversal attacks.
// Returns the resolved absolute path if it is within DOCS_DIR, otherwise null.
function guardDocPath(rawPath) {
  const resolved = path.resolve(rawPath);
  const base     = path.resolve(DOCS_DIR) + path.sep;
  return resolved.startsWith(base) ? resolved : null;
}

const docStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOCS_DIR),
  filename:    (req, file, cb) => cb(null, `${uuid()}_${file.originalname.replace(/\s/g, '_')}`),
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|pdf|gif|webp|heic)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// ── Helpers ───────────────────────────────────────────────────────
// Sprint 4: admin access requires a JWT with role='admin', not a shared API key.
// The x-admin-key is now scoped exclusively to the /admin/* panel routes in server.js.
function isAdmin(req) {
  return req.user?.role === 'admin';
}

function addEvent(app, type, description, actor, actorName, data = {}) {
  app.timeline_events.push({
    id: uuid(), type, description, actor, actor_name: actorName, data,
    created_at: new Date().toISOString(),
  });
  app.updated_at = new Date().toISOString();
}

function sendNotification(to, subject, html) {
  if (!process.env.EMAIL_USER) return;
  transporter.sendMail({
    from: `"HogaresRD" <${process.env.EMAIL_USER}>`,
    to, subject, html,
  }).catch(() => {});
}

function statusEmail(app, oldStatus, newStatus, reason) {
  const label = STATUS_LABELS[newStatus] || newStatus;
  return {
    subject: `HogaresRD — Tu aplicación: ${label}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#002D62;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
          <h2 style="margin:0;">HogaresRD</h2>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;">
          <p>Hola <strong>${app.client.name}</strong>,</p>
          <p>Tu aplicación para <strong>${app.listing_title}</strong> ha sido actualizada:</p>
          <div style="background:#f0f4f9;padding:1rem;border-radius:8px;text-align:center;margin:1rem 0;">
            <div style="font-size:0.8rem;color:#4d6a8a;">Estado actual</div>
            <div style="font-size:1.3rem;font-weight:800;color:#0038A8;">${label}</div>
          </div>
          ${reason ? `<p><strong>Nota:</strong> ${reason}</p>` : ''}
          <a href="${BASE_URL}/my-applications" style="display:inline-block;background:#0038A8;color:#fff;padding:0.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;margin-top:0.5rem;">Ver mi aplicación</a>
        </div>
        <div style="padding:1rem;text-align:center;font-size:0.75rem;color:#999;">
          &copy; 2026 HogaresRD
        </div>
      </div>`,
  };
}

function fmtAmt(n, cur) {
  return `${cur || 'DOP'} ${Number(n || 0).toLocaleString('es-DO')}`;
}

function buildPaymentPlanEmail(app) {
  const plan = app.payment_plan;
  const rows = plan.installments.map(i =>
    `<tr>
       <td style="padding:.5rem .75rem;border-bottom:1px solid #eee;">#${i.number} — ${i.label}</td>
       <td style="padding:.5rem .75rem;border-bottom:1px solid #eee;font-weight:600;">${fmtAmt(i.amount, plan.currency)}</td>
       <td style="padding:.5rem .75rem;border-bottom:1px solid #eee;color:#555;">${i.due_date || '—'}</td>
     </tr>`
  ).join('');
  return `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;">
    <div style="background:#1C2B3A;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
      <h2 style="margin:0;font-size:1.2rem;">HogaresRD — Plan de Pagos</h2>
    </div>
    <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;">
      <p>Hola <strong>${app.client.name}</strong>,</p>
      <p>Tu broker ha creado un plan de pagos para tu solicitud de <strong>${app.listing_title}</strong>.</p>
      <p><strong>Método de pago:</strong> ${plan.payment_method || '—'}</p>
      ${plan.method_details ? `<div style="background:#f5f7fa;padding:.75rem;border-radius:6px;font-size:.9rem;margin:.5rem 0;">${plan.method_details}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;margin:1rem 0;font-size:.9rem;">
        <thead><tr style="background:#f5f7fa;"><th style="padding:.5rem .75rem;text-align:left;">Cuota</th><th style="padding:.5rem .75rem;text-align:left;">Monto</th><th style="padding:.5rem .75rem;text-align:left;">Vence</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${plan.notes ? `<p style="font-size:.9rem;color:#555;"><strong>Notas:</strong> ${plan.notes}</p>` : ''}
      <a href="${BASE_URL}/my-applications" style="display:inline-block;background:#2563EB;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;margin-top:.5rem;">Ver mi Plan de Pagos</a>
    </div>
  </div>`;
}

function buildPaymentReminderEmail(app, inst) {
  const plan = app.payment_plan;
  const dueLabel = inst.due_date
    ? new Date(inst.due_date + 'T12:00:00').toLocaleDateString('es-DO', { year:'numeric', month:'long', day:'numeric' })
    : 'próximamente';
  return `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;">
    <div style="background:#1C2B3A;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
      <h2 style="margin:0;font-size:1.2rem;">HogaresRD — Recordatorio de Pago</h2>
    </div>
    <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;">
      <p>Hola <strong>${app.client.name}</strong>,</p>
      <p>Tienes un pago pendiente para tu solicitud de <strong>${app.listing_title}</strong>:</p>
      <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:1rem;margin:1rem 0;">
        <div style="font-size:.75rem;font-weight:700;color:#92400E;text-transform:uppercase;letter-spacing:.05em;">Cuota #${inst.number}</div>
        <div style="font-size:1.15rem;font-weight:700;margin:.3rem 0;">${inst.label}</div>
        <div style="font-size:1.05rem;color:#1C2B3A;font-weight:600;">${fmtAmt(inst.amount, plan.currency)}</div>
        <div style="font-size:.85rem;color:#B45309;margin-top:.3rem;">📅 Vence: ${dueLabel}</div>
      </div>
      <p><strong>Método de pago:</strong> ${plan.payment_method || '—'}</p>
      ${plan.method_details ? `<div style="background:#f5f7fa;padding:.75rem;border-radius:6px;font-size:.9rem;">${plan.method_details}</div>` : ''}
      <p style="margin-top:1rem;">Una vez realizado el pago, sube tu comprobante en el portal:</p>
      <a href="${BASE_URL}/my-applications" style="display:inline-block;background:#2563EB;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Subir Comprobante</a>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// ── POST /  — Create application ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.post('/', appCreateLimiter, (req, res) => {
  const {
    listing_id, listing_title, listing_price, listing_type,
    name, phone, email, user_id,
    financing, pre_approved, contact_method, budget, timeline, intent, notes,
    _hp, // honeypot — must be absent or empty (bots fill all fields)
  } = req.body;

  // ── Honeypot: bots fill hidden fields; real users never see them ──
  if (_hp) {
    // Return 200 to the bot so it thinks it succeeded (don't reveal the block)
    return res.status(200).json({ success: true, id: `fake_${Date.now()}` });
  }

  if (!name || !phone || !listing_id)
    return res.status(400).json({ error: 'name, phone y listing_id son requeridos' });

  // ── Input validation (Sprint 3, Item 11) ─────────────────────────
  const nameTrimmed  = name.trim();
  const phoneTrimmed = phone.trim();
  const emailTrimmed = (email || '').trim();

  if (nameTrimmed.length < 2 || nameTrimmed.length > 120)
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 120 caracteres' });

  // Phone: allow digits, spaces, dashes, parentheses, leading +
  if (!/^\+?[\d\s\-().]{7,20}$/.test(phoneTrimmed))
    return res.status(400).json({ error: 'Número de teléfono inválido' });

  if (emailTrimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailTrimmed))
    return res.status(400).json({ error: 'Correo electrónico inválido' });

  // Find listing to get affiliated broker
  const listing = store.getListingById(listing_id);
  const agencies = listing?.agencies || [];

  // Auto-assign first agency broker (or leave unassigned)
  let broker = { user_id: null, name: '', agency_name: '', email: '', phone: '' };
  if (agencies.length) {
    const agency = agencies[0];
    broker = {
      user_id: agency.user_id || null,
      name:    agency.contact || agency.name || '',
      agency_name: agency.name || '',
      email:   agency.email || '',
      phone:   agency.phone || '',
    };
  }

  // Snapshot inmobiliaria affiliation at application creation time
  const brokerUser = broker.user_id ? store.getUserById(broker.user_id) : null;
  const inmobiliaria_id   = brokerUser?.inmobiliaria_id   || null;
  const inmobiliaria_name = brokerUser?.inmobiliaria_name || null;

  const app = {
    id:             uuid(),
    listing_id:     listing_id || '',
    listing_title:  listing_title || listing?.title || '',
    listing_price:  listing_price || listing?.price || '',
    listing_type:   listing_type  || listing?.type  || '',
    client: {
      name:    nameTrimmed,
      phone:   phoneTrimmed,
      email:   emailTrimmed,
      user_id: user_id || null,
    },
    broker,
    status:         'aplicado',
    status_reason:  '',
    financing:      financing || '',
    pre_approved:   pre_approved === true || pre_approved === 'true',
    budget:         (budget || '').toString().trim(),
    timeline:       (timeline || '').trim(),
    intent:         intent || 'comprar',
    contact_method: contact_method || 'whatsapp',
    notes:          (notes || '').trim(),
    documents_requested: [],
    documents_uploaded:  [],
    tours:               [],
    payment: {
      amount: null, currency: 'USD', receipt_path: null,
      receipt_uploaded_at: null, verification_status: 'none',
      verified_at: null, verified_by: null, notes: '',
    },
    payment_plan: null,
    inmobiliaria_id,
    inmobiliaria_name,
    timeline_events: [],
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
  };

  addEvent(app, 'status_change', 'Aplicación recibida', 'system', 'Sistema',
    { from: null, to: 'aplicado' });

  store.saveApplication(app);

  // Meta CAPI — Lead (fire-and-forget)
  setImmediate(async () => {
    try {
      const meta = require('../utils/meta');
      await meta.trackLead({
        email: app.client.email, phone: app.client.phone, name: app.client.name,
        ip: req.ip, userAgent: req.headers['user-agent'],
        fbc: req.cookies?._fbc, fbp: req.cookies?._fbp,
        eventId: `lead_${app.id}`,
        listingTitle: app.listing_title, listingId: app.listing_id,
      });
    } catch (_) {}
  });

  // Build application notification HTML
  function newAppHtml(recipientLabel) {
    return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
      <div style="background:#002D62;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;">Nueva Aplicación</h2>
        ${recipientLabel ? `<p style="margin:.3rem 0 0;opacity:.75;font-size:.85rem;">${recipientLabel}</p>` : ''}
      </div>
      <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;">
        <p><strong>${app.client.name}</strong> ha aplicado para:</p>
        <p style="font-size:1.1rem;font-weight:700;">${app.listing_title} — $${Number(app.listing_price).toLocaleString()}</p>
        <p>📞 ${app.client.phone} · ✉️ ${app.client.email || 'N/A'}</p>
        <p>Agente: ${broker.name || 'Sin asignar'} · Intención: ${app.intent}</p>
        <a href="${BASE_URL}/broker" style="display:inline-block;background:#0038A8;color:#fff;padding:0.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver en Dashboard</a>
      </div>
    </div>`;
  }

  // Notify broker
  if (broker.email) {
    sendNotification(broker.email, `Nueva aplicación — ${app.listing_title}`, newAppHtml(''));
  }

  // Notify inmobiliaria (if broker is affiliated)
  if (inmobiliaria_id) {
    const inmUser = store.getUserById(inmobiliaria_id);
    if (inmUser?.email) {
      sendNotification(
        inmUser.email,
        `Nueva aplicación (${broker.name || 'agente'}) — ${app.listing_title}`,
        newAppHtml(`Agente: ${broker.name}`)
      );
    }
  }

  res.status(201).json({ ok: true, id: app.id });

  // WhatsApp broker notification (fire-and-forget)
  setImmediate(async () => {
    try {
      const brokerUser = broker.user_id ? store.getUserById(broker.user_id) : null;
      if (brokerUser?.phone) {
        await notify.notifyBrokerNewApplication({
          brokerPhone:   brokerUser.phone,
          clientName:    app.client.name,
          propertyTitle: app.listing_title,
          appId:         app.id,
        });
      }
    } catch (e) { console.error('[notify-app]', e.message); }
  });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /  — List applications (broker/admin) ────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  let apps;
  if (user.role === 'admin') {
    apps = store.getApplications();
  } else if (user.role === 'inmobiliaria') {
    apps = store.getApplicationsByInmobiliaria(user.id);
  } else if (['agency', 'broker'].includes(user.role)) {
    apps = store.getApplicationsByBroker(user.id);
  } else {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const { status } = req.query;
  if (status) apps = apps.filter(a => a.status === status);

  res.json(apps);
});

// ── GET /my  — Client's own applications ─────────────────────────
router.get('/my', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  const apps = store.getApplicationsByClient(user.id).length
    ? store.getApplicationsByClient(user.id)
    : store.getApplicationsByClient(user.email);
  res.json(apps);
});

// ── GET /statuses  — Available statuses ──────────────────────────
router.get('/statuses', (req, res) => {
  res.json({ statuses: STATUS_LABELS, flow: STATUS_FLOW, documentTypes: DOCUMENT_TYPES });
});

// ── GET /:id  — Single application detail ────────────────────────
router.get('/:id', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = user?.role === 'inmobiliaria' && app.inmobiliaria_id === user.id;
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';

  if (!isBroker && !isInmobiliaria && !isClient && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  res.json(app);
});

// ══════════════════════════════════════════════════════════════════
// ── PUT /:id/status  — Change status ─────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.put('/:id/status', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = user?.role === 'inmobiliaria' && app.inmobiliaria_id === user.id;
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  const { status, reason } = req.body;
  if (!status) return res.status(400).json({ error: 'status es requerido' });

  const allowed = STATUS_FLOW[app.status] || [];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `Transición no válida: ${app.status} → ${status}` });

  if (status === 'rechazado' && !reason)
    return res.status(400).json({ error: 'Se requiere una razón para rechazar' });

  const oldStatus = app.status;
  app.status = status;
  app.status_reason = reason || '';

  addEvent(app, 'status_change',
    `Estado cambiado a ${STATUS_LABELS[status]}${reason ? ': ' + reason : ''}`,
    req.user.sub, user?.name || 'Broker',
    { from: oldStatus, to: status, reason });

  store.saveApplication(app);

  // Notify client via email
  if (app.client.email) {
    const email = statusEmail(app, oldStatus, status, reason);
    sendNotification(app.client.email, email.subject, email.html);
  }

  res.json(app);
});

// ══════════════════════════════════════════════════════════════════
// ── DOCUMENTS ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/documents/request  — Broker requests documents ────
router.post('/:id/documents/request', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { documents } = req.body; // [{ type, label, required }]
  if (!Array.isArray(documents) || !documents.length)
    return res.status(400).json({ error: 'Lista de documentos requerida' });

  const newDocs = documents.map(d => ({
    id:           uuid(),
    type:         d.type || 'other',
    label:        d.label || DOCUMENT_TYPES[d.type] || 'Documento',
    required:     d.required !== false,
    requested_at: new Date().toISOString(),
    status:       'pending',
  }));

  app.documents_requested.push(...newDocs);

  // Update status if applicable
  const canTransition = STATUS_FLOW[app.status]?.includes('documentos_requeridos');
  if (canTransition) {
    const old = app.status;
    app.status = 'documentos_requeridos';
    addEvent(app, 'status_change', 'Documentos solicitados al cliente', req.user.sub, user?.name || 'Broker',
      { from: old, to: 'documentos_requeridos' });
  }

  addEvent(app, 'documents_requested',
    `Se solicitaron ${newDocs.length} documento(s): ${newDocs.map(d => d.label).join(', ')}`,
    req.user.sub, user?.name || 'Broker',
    { documents: newDocs.map(d => d.label) });

  store.saveApplication(app);

  // Notify client
  if (app.client.email) {
    const docList = newDocs.map(d => `• ${d.label}${d.required ? ' (requerido)' : ''}`).join('<br>');
    sendNotification(app.client.email,
      `HogaresRD — Documentos requeridos para ${app.listing_title}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#002D62;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
          <h2 style="margin:0;">Documentos Requeridos</h2>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;">
          <p>Hola <strong>${app.client.name}</strong>,</p>
          <p>Para continuar con tu aplicación de <strong>${app.listing_title}</strong>, necesitamos los siguientes documentos:</p>
          <div style="background:#f0f4f9;padding:1rem;border-radius:8px;margin:1rem 0;">${docList}</div>
          <a href="${BASE_URL}/my-applications" style="display:inline-block;background:#0038A8;color:#fff;padding:0.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Subir documentos</a>
        </div>
      </div>`
    );
  }

  res.json(app);
});

// ── POST /:id/documents/upload  — Client uploads documents ──────
router.post('/:id/documents/upload', userAuth, docUpload.array('files', 10), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isClient && !isAdmin(req))
    return res.status(403).json({ error: 'Solo el cliente puede subir documentos' });

  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No se recibieron archivos' });

  // Validate MIME types — reject any file whose magic bytes don't match allowed types
  for (const f of req.files) {
    const ok = await validateMime(f.path);
    if (!ok) {
      // Delete the rest of the batch files too
      req.files.forEach(x => { if (x.path !== f.path) fs.unlink(x.path, () => {}); });
      return res.status(400).json({ error: `Tipo de archivo no permitido: ${f.originalname}. Solo se aceptan imágenes (JPG, PNG, WEBP, GIF) y PDF.` });
    }
  }

  const requestId = req.body.request_id || null;
  const docType   = req.body.type || 'other';

  const uploaded = req.files.map(f => ({
    id:            uuid(),
    request_id:    requestId,
    type:          docType,
    filename:      f.filename,
    path:          f.path,
    original_name: f.originalname,
    size:          f.size,
    uploaded_at:   new Date().toISOString(),
    review_status: 'pending',
    review_note:   '',
    reviewed_at:   null,
    reviewed_by:   null,
  }));

  app.documents_uploaded.push(...uploaded);

  // Mark the request as fulfilled if linked
  if (requestId) {
    const docReq = app.documents_requested.find(d => d.id === requestId);
    if (docReq) docReq.status = 'uploaded';
  }

  // Auto-transition to documentos_enviados if all required docs have uploads
  const allRequired = app.documents_requested.filter(d => d.required);
  const allFulfilled = allRequired.length > 0 && allRequired.every(d => d.status === 'uploaded');
  if (allFulfilled && STATUS_FLOW[app.status]?.includes('documentos_enviados')) {
    const old = app.status;
    app.status = 'documentos_enviados';
    addEvent(app, 'status_change', 'Todos los documentos requeridos han sido enviados',
      'system', 'Sistema', { from: old, to: 'documentos_enviados' });
  }

  addEvent(app, 'document_uploaded',
    `${uploaded.length} documento(s) subido(s): ${uploaded.map(d => d.original_name).join(', ')}`,
    req.user.sub, user?.name || app.client.name, { files: uploaded.map(d => d.original_name) });

  store.saveApplication(app);

  // Notify broker
  if (app.broker.email) {
    sendNotification(app.broker.email,
      `Documentos recibidos — ${app.client.name} · ${app.listing_title}`,
      `<p>${app.client.name} ha subido ${uploaded.length} documento(s) para ${app.listing_title}.</p>
       <a href="${BASE_URL}/broker">Ver en Dashboard</a>`
    );
  }

  res.json({ ok: true, uploaded: uploaded.length });
});

// ── PUT /:id/documents/:docId/review  — Broker reviews document ─
router.put('/:id/documents/:docId/review', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const doc = app.documents_uploaded.find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

  const { status, note } = req.body; // 'approved' or 'rejected'
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status debe ser approved o rejected' });

  const user = store.getUserById(req.user.sub);
  doc.review_status = status;
  doc.review_note   = note || '';
  doc.reviewed_at   = new Date().toISOString();
  doc.reviewed_by   = req.user.sub;

  addEvent(app, 'document_reviewed',
    `Documento "${doc.original_name}" ${status === 'approved' ? 'aprobado' : 'rechazado'}${note ? ': ' + note : ''}`,
    req.user.sub, user?.name || 'Broker',
    { doc_id: doc.id, status, note });

  // If any required doc rejected → documentos_insuficientes
  const hasRejected = app.documents_uploaded.some(d => d.review_status === 'rejected');
  if (hasRejected && STATUS_FLOW[app.status]?.includes('documentos_insuficientes')) {
    const old = app.status;
    app.status = 'documentos_insuficientes';
    addEvent(app, 'status_change', 'Documentos insuficientes — se requieren correcciones',
      req.user.sub, user?.name || 'Broker', { from: old, to: 'documentos_insuficientes' });
  }

  store.saveApplication(app);
  res.json(app);
});

// ── GET /:id/documents/:docId/file  — Serve uploaded document ───
router.get('/:id/documents/:docId/file', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isBroker && !isClient && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const doc = app.documents_uploaded.find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

  if (!fs.existsSync(doc.path)) return res.status(404).json({ error: 'Archivo no encontrado' });

  const safePath = guardDocPath(doc.path);
  if (!safePath) return res.status(400).json({ error: 'Ruta de archivo inválida' });
  res.sendFile(safePath);
});

// ══════════════════════════════════════════════════════════════════
// ── TOURS ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/tours  — Schedule tour ─────────────────────────────
router.post('/:id/tours', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { scheduled_date, scheduled_time, location, notes } = req.body;
  if (!scheduled_date || !scheduled_time)
    return res.status(400).json({ error: 'Fecha y hora son requeridos' });

  const user = store.getUserById(req.user.sub);
  const tour = {
    id:             uuid(),
    scheduled_date, scheduled_time,
    location:       location || app.listing_title,
    notes:          notes || '',
    status:         'scheduled',
    created_at:     new Date().toISOString(),
    completed_at:   null,
  };

  app.tours.push(tour);
  addEvent(app, 'tour_scheduled',
    `Tour programado para ${scheduled_date} a las ${scheduled_time}`,
    req.user.sub, user?.name || 'Broker',
    { tour_id: tour.id, date: scheduled_date, time: scheduled_time });

  store.saveApplication(app);

  // Notify client
  if (app.client.email) {
    sendNotification(app.client.email,
      `HogaresRD — Tour programado: ${app.listing_title}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#002D62;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
          <h2 style="margin:0;">Tour Programado</h2>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;">
          <p>Hola <strong>${app.client.name}</strong>,</p>
          <p>Tu tour de la propiedad <strong>${app.listing_title}</strong> ha sido programado:</p>
          <div style="background:#f0f4f9;padding:1rem;border-radius:8px;margin:1rem 0;text-align:center;">
            <div style="font-size:1.3rem;font-weight:800;color:#0038A8;">${scheduled_date}</div>
            <div style="font-size:1rem;color:#4d6a8a;">${scheduled_time}</div>
            <div style="font-size:0.85rem;color:#4d6a8a;margin-top:0.5rem;">${tour.location}</div>
          </div>
          ${tour.notes ? `<p><strong>Notas:</strong> ${tour.notes}</p>` : ''}
        </div>
      </div>`
    );
  }

  res.json(app);
});

// ── PUT /:id/tours/:tourId  — Update tour ────────────────────────
router.put('/:id/tours/:tourId', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const tour = app.tours.find(t => t.id === req.params.tourId);
  if (!tour) return res.status(404).json({ error: 'Tour no encontrado' });

  const user = store.getUserById(req.user.sub);
  const { status, scheduled_date, scheduled_time, notes } = req.body;

  if (scheduled_date) tour.scheduled_date = scheduled_date;
  if (scheduled_time) tour.scheduled_time = scheduled_time;
  if (notes !== undefined) tour.notes = notes;
  if (status === 'completed') {
    tour.status = 'completed';
    tour.completed_at = new Date().toISOString();
    addEvent(app, 'tour_completed', 'Tour completado', req.user.sub, user?.name || 'Broker',
      { tour_id: tour.id });
  } else if (status === 'cancelled') {
    tour.status = 'cancelled';
    addEvent(app, 'tour_cancelled', 'Tour cancelado', req.user.sub, user?.name || 'Broker',
      { tour_id: tour.id });
  }

  store.saveApplication(app);
  res.json(app);
});

// ══════════════════════════════════════════════════════════════════
// ── PAYMENT ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/payment/upload  — Client uploads receipt ──────────
router.post('/:id/payment/upload', userAuth, docUpload.single('receipt'), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isClient) return res.status(403).json({ error: 'Solo el cliente puede subir recibo' });

  if (!req.file) return res.status(400).json({ error: 'Recibo es requerido' });

  // Validate MIME type via magic bytes
  if (!(await validateMime(req.file.path)))
    return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo se aceptan imágenes y PDF.' });

  app.payment.receipt_path = req.file.path;
  app.payment.receipt_filename = req.file.filename;
  app.payment.receipt_original = req.file.originalname;
  app.payment.receipt_uploaded_at = new Date().toISOString();
  app.payment.amount = req.body.amount || app.listing_price;
  app.payment.verification_status = 'pending';
  app.payment.notes = req.body.notes || '';

  // Transition status
  if (STATUS_FLOW[app.status]?.includes('pago_enviado')) {
    const old = app.status;
    app.status = 'pago_enviado';
    addEvent(app, 'status_change', 'Recibo de pago enviado', 'system', 'Sistema',
      { from: old, to: 'pago_enviado' });
  }

  addEvent(app, 'payment_uploaded', `Recibo de pago subido: ${req.file.originalname}`,
    req.user.sub, user?.name || app.client.name, { filename: req.file.originalname });

  store.saveApplication(app);

  // Notify broker
  if (app.broker.email) {
    sendNotification(app.broker.email,
      `Recibo de pago recibido — ${app.client.name}`,
      `<p>${app.client.name} ha subido un recibo de pago para ${app.listing_title}.</p>
       <a href="${BASE_URL}/broker">Verificar en Dashboard</a>`
    );
  }

  res.json({ ok: true });
});

// ── PUT /:id/payment/verify  — Broker verifies payment ──────────
router.put('/:id/payment/verify', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { approved, notes } = req.body;
  const user = store.getUserById(req.user.sub);

  app.payment.verification_status = approved ? 'approved' : 'rejected';
  app.payment.verified_at = new Date().toISOString();
  app.payment.verified_by = req.user.sub;
  if (notes) app.payment.notes = notes;

  if (approved && STATUS_FLOW[app.status]?.includes('pago_aprobado')) {
    const old = app.status;
    app.status = 'pago_aprobado';
    addEvent(app, 'status_change', 'Pago verificado y aprobado',
      req.user.sub, user?.name || 'Broker', { from: old, to: 'pago_aprobado' });
  } else if (!approved && STATUS_FLOW[app.status]?.includes('pendiente_pago')) {
    const old = app.status;
    app.status = 'pendiente_pago';
    addEvent(app, 'status_change', `Pago rechazado${notes ? ': ' + notes : ''}`,
      req.user.sub, user?.name || 'Broker', { from: old, to: 'pendiente_pago' });
  }

  addEvent(app, 'payment_reviewed',
    `Pago ${approved ? 'aprobado' : 'rechazado'}${notes ? ': ' + notes : ''}`,
    req.user.sub, user?.name || 'Broker', { approved, notes });

  store.saveApplication(app);

  // Notify client
  if (app.client.email) {
    const email = statusEmail(app, null, app.status, notes);
    sendNotification(app.client.email, email.subject, email.html);
  }

  res.json(app);
});

// ── GET /:id/payment/receipt  — Serve payment receipt ────────────
router.get('/:id/payment/receipt', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isBroker && !isClient && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  if (!app.payment.receipt_path || !fs.existsSync(app.payment.receipt_path))
    return res.status(404).json({ error: 'Recibo no encontrado' });

  const safeReceipt = guardDocPath(app.payment.receipt_path);
  if (!safeReceipt) return res.status(400).json({ error: 'Ruta de archivo inválida' });
  res.sendFile(safeReceipt);
});

// ══════════════════════════════════════════════════════════════════
// ── BROKER MESSAGING ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/message  — Add message/note to timeline ────────────
router.post('/:id/message', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isBroker && !isClient && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje es requerido' });

  addEvent(app, 'message', message,
    req.user.sub, user?.name || (isBroker ? 'Broker' : app.client.name),
    { role: isBroker ? 'broker' : 'client' });

  store.saveApplication(app);

  // Notify the other party
  const notifyEmail = isBroker ? app.client.email : app.broker.email;
  const notifyName = isBroker ? app.client.name : (app.broker.name || 'Broker');
  if (notifyEmail) {
    sendNotification(notifyEmail,
      `HogaresRD — Nuevo mensaje sobre ${app.listing_title}`,
      `<p><strong>${user?.name || 'Usuario'}</strong> te ha enviado un mensaje:</p>
       <blockquote style="border-left:3px solid #0038A8;padding:0.5rem 1rem;color:#333;">${message}</blockquote>
       <a href="${BASE_URL}/${isBroker ? 'my-applications' : 'broker'}">Ver conversación</a>`
    );
  }

  res.json(app);
});

// ── POST /:id/checklist-event  — Log checklist audit entry ──────
router.post('/:id/checklist-event', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { item_id, item_label, stage, stage_complete } = req.body;
  if (!stage) return res.status(400).json({ error: 'stage es requerido' });

  const stageName  = STATUS_LABELS[stage] || stage;
  const actorName  = user?.name || 'Broker';

  if (stage_complete) {
    addEvent(app, 'checklist_complete',
      `Checklist de etapa "${stageName}" completado — listo para avanzar`,
      req.user.sub, actorName,
      { stage });
  } else {
    if (!item_id || !item_label) return res.status(400).json({ error: 'item_id e item_label requeridos' });
    addEvent(app, 'checklist_check',
      `✓ ${item_label}`,
      req.user.sub, actorName,
      { item_id, item_label, stage });
  }

  store.saveApplication(app);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ── PAYMENT PLAN ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/payment-plan  — Broker creates / replaces plan ─────
router.post('/:id/payment-plan', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });
  const user = store.getUserById(req.user.sub);
  const isInmobiliaria = user?.role === 'inmobiliaria' && app.inmobiliaria_id === user.id;
  const isBrokerOwner  = app.broker.user_id === req.user.sub;
  const admin          = isAdmin(req) || user?.role === 'admin';

  if (!isBrokerOwner && !isInmobiliaria && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Broker can only create the plan (first time). Once it exists, only inmobiliaria can edit.
  const planExists = !!(app.payment_plan?.installments?.length);
  if (planExists && isBrokerOwner && !isInmobiliaria && !admin)
    return res.status(403).json({
      error: 'El plan de pagos ya fue creado. Solo la inmobiliaria puede modificarlo.',
    });

  const { payment_method, method_details, currency, total_amount, notes, installments } = req.body;
  if (!Array.isArray(installments) || !installments.length)
    return res.status(400).json({ error: 'Se requiere al menos una cuota' });
  const existing = app.payment_plan?.installments || [];
  const isEdit   = existing.length > 0;
  app.payment_plan = {
    id:             app.payment_plan?.id || uuid(),
    payment_method: payment_method || '',
    method_details: method_details || '',
    currency:       currency || 'DOP',
    total_amount:   total_amount || null,
    notes:          notes || '',
    created_at:     app.payment_plan?.created_at || new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    created_by:     app.payment_plan?.created_by || req.user.sub,
    installments:   installments.map((inst, i) => {
      const prev = existing.find(e => e.id === inst.id);
      return {
        id:                   prev?.id || uuid(),
        number:               i + 1,
        label:                inst.label || `Pago ${i + 1}`,
        amount:               Number(inst.amount) || 0,
        due_date:             inst.due_date || null,
        status:               prev?.status || 'pending',
        proof_path:           prev?.proof_path           || null,
        proof_filename:       prev?.proof_filename       || null,
        proof_original:       prev?.proof_original       || null,
        proof_uploaded_at:    prev?.proof_uploaded_at    || null,
        proof_notes:          prev?.proof_notes          || '',
        reviewed_at:          prev?.reviewed_at          || null,
        reviewed_by:          prev?.reviewed_by          || null,
        review_notes:         prev?.review_notes         || '',
        notification_sent:    prev?.notification_sent    || false,
        notification_sent_at: prev?.notification_sent_at || null,
      };
    }),
  };
  addEvent(app, 'payment',
    isEdit
      ? `Plan de pagos actualizado: ${installments.length} cuota(s)`
      : `Plan de pagos creado: ${installments.length} cuota(s) · ${fmtAmt(total_amount, currency||'DOP')}`,
    req.user.sub, user?.name || 'Broker',
    { type: 'plan_created', installments: installments.length });
  store.saveApplication(app);
  if (!isEdit && app.client.email)
    sendNotification(app.client.email, 'HogaresRD — Plan de Pagos Creado', buildPaymentPlanEmail(app));
  res.json(app);
});

// ── POST /:id/payment-plan/:iid/upload  — Client uploads proof ───
router.post('/:id/payment-plan/:iid/upload', userAuth, docUpload.single('proof'), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app || !app.payment_plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const user     = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
    (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isClient && !isAdmin(req)) return res.status(403).json({ error: 'No autorizado' });
  const inst = app.payment_plan.installments.find(i => i.id === req.params.iid);
  if (!inst)       return res.status(404).json({ error: 'Cuota no encontrada' });
  if (!req.file)   return res.status(400).json({ error: 'Archivo requerido' });
  if (inst.status === 'approved') return res.status(400).json({ error: 'Este pago ya fue aprobado' });

  // Validate MIME type via magic bytes
  if (!(await validateMime(req.file.path)))
    return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo se aceptan imágenes y PDF.' });
  inst.proof_path        = req.file.path;
  inst.proof_filename    = req.file.filename;
  inst.proof_original    = req.file.originalname;
  inst.proof_uploaded_at = new Date().toISOString();
  inst.proof_notes       = (req.body.notes || '').trim();
  inst.status            = 'proof_uploaded';
  addEvent(app, 'payment',
    `Comprobante subido — Cuota #${inst.number}: ${inst.label}`,
    req.user.sub, user?.name || app.client.name || 'Cliente',
    { type: 'proof_uploaded', installment_id: inst.id, installment_number: inst.number });
  store.saveApplication(app);
  const proofNotifHtml = `<div style="font-family:sans-serif;max-width:520px;">
    <p>Hola,</p>
    <p><strong>${app.client.name}</strong> subió el comprobante de la <strong>Cuota #${inst.number} (${inst.label})</strong> para <em>${app.listing_title}</em>.</p>
    ${inst.proof_notes ? `<p><em>Nota del cliente:</em> ${inst.proof_notes}</p>` : ''}
    <a href="${BASE_URL}/broker" style="background:#2563EB;color:#fff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:700;">Revisar en el panel</a>
  </div>`;
  // Notify broker
  if (app.broker.email)
    sendNotification(app.broker.email, `HogaresRD — Comprobante subido: Cuota #${inst.number}`, proofNotifHtml);
  // Notify inmobiliaria
  if (app.inmobiliaria_id) {
    const inmUser = store.getUserById(app.inmobiliaria_id);
    if (inmUser?.email)
      sendNotification(inmUser.email, `HogaresRD — Comprobante subido: Cuota #${inst.number}`, proofNotifHtml);
  }
  res.json({ ok: true, installment: inst });
});

// ── PUT /:id/payment-plan/:iid/review  — Inmobiliaria reviews proof ─
router.put('/:id/payment-plan/:iid/review', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app || !app.payment_plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const user = store.getUserById(req.user.sub);
  const isInmobiliaria = user?.role === 'inmobiliaria' && app.inmobiliaria_id === user.id;
  const isBrokerOwner  = app.broker.user_id === req.user.sub;
  const admin          = isAdmin(req) || user?.role === 'admin';
  if (!isInmobiliaria && !isBrokerOwner && !admin)
    return res.status(403).json({ error: 'No autorizado' });
  const inst = app.payment_plan.installments.find(i => i.id === req.params.iid);
  if (!inst) return res.status(404).json({ error: 'Cuota no encontrada' });
  if (inst.status !== 'proof_uploaded')
    return res.status(400).json({ error: 'Sin comprobante pendiente de revision' });
  const { approved, review_notes } = req.body;
  inst.status       = approved ? 'approved' : 'rejected';
  inst.reviewed_at  = new Date().toISOString();
  inst.reviewed_by  = req.user.sub;
  inst.review_notes = (review_notes || '').trim();
  addEvent(app, 'payment',
    approved
      ? `Pago aprobado — Cuota #${inst.number}: ${inst.label} (${fmtAmt(inst.amount, app.payment_plan.currency)})`
      : `Pago rechazado — Cuota #${inst.number}: ${inst.label}${review_notes ? ' · ' + review_notes : ''}`,
    req.user.sub, user?.name || 'Broker',
    { type: approved ? 'proof_approved' : 'proof_rejected', installment_id: inst.id, approved });
  // Auto-advance application when ALL installments approved
  const allApproved = app.payment_plan.installments.every(i => i.status === 'approved');
  if (allApproved && (STATUS_FLOW[app.status] || []).includes('pago_aprobado')) {
    const from = app.status;
    app.status = 'pago_aprobado';
    addEvent(app, 'status_change',
      `Estado actualizado a ${STATUS_LABELS['pago_aprobado']} (todos los pagos verificados)`,
      req.user.sub, user?.name || 'Broker', { from, to: 'pago_aprobado' });
  }
  store.saveApplication(app);
  if (app.client.email)
    sendNotification(app.client.email,
      approved ? `HogaresRD — Pago #${inst.number} Aprobado ✓`
               : `HogaresRD — Pago #${inst.number} Rechazado — Acción Requerida`,
      approved
        ? `<div style="font-family:sans-serif;max-width:520px;">
            <p>Hola <strong>${app.client.name}</strong>,</p>
            <p>Tu pago <strong>#${inst.number} (${inst.label})</strong> fue aprobado.</p>
            ${allApproved ? '<p>🎉 ¡Todos los pagos han sido verificados!</p>' : ''}
            <a href="${BASE_URL}/my-applications" style="background:#16A34A;color:#fff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver mi solicitud</a>
           </div>`
        : `<div style="font-family:sans-serif;max-width:520px;">
            <p>Hola <strong>${app.client.name}</strong>,</p>
            <p>El comprobante de la <strong>Cuota #${inst.number} (${inst.label})</strong> fue rechazado.</p>
            ${review_notes ? `<p><strong>Motivo:</strong> ${review_notes}</p>` : ''}
            <p>Por favor sube un nuevo comprobante.</p>
            <a href="${BASE_URL}/my-applications" style="background:#DC2626;color:#fff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:700;">Subir nuevo comprobante</a>
           </div>`);
  res.json(app);
});

// ── POST /:id/payment-plan/:iid/notify  — Send payment reminder ──
router.post('/:id/payment-plan/:iid/notify', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app || !app.payment_plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const user = store.getUserById(req.user.sub);
  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });
  const inst = app.payment_plan.installments.find(i => i.id === req.params.iid);
  if (!inst) return res.status(404).json({ error: 'Cuota no encontrada' });
  inst.notification_sent    = true;
  inst.notification_sent_at = new Date().toISOString();
  addEvent(app, 'payment',
    `Recordatorio enviado — Cuota #${inst.number}: ${inst.label} (vence ${inst.due_date || '—'})`,
    req.user.sub, user?.name || 'Broker',
    { type: 'reminder_sent', installment_id: inst.id, installment_number: inst.number });
  store.saveApplication(app);
  if (app.client.email)
    sendNotification(app.client.email,
      `HogaresRD — Recordatorio: Cuota #${inst.number} — ${inst.label}`,
      buildPaymentReminderEmail(app, inst));
  res.json({ ok: true });
});

// ── GET /:id/payment-plan/:iid/proof  — Serve proof file ─────────
router.get('/:id/payment-plan/:iid/proof', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app || !app.payment_plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const user     = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
    (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isBroker && !isClient && !isAdmin(req)) return res.status(403).json({ error: 'No autorizado' });
  const inst = app.payment_plan.installments.find(i => i.id === req.params.iid);
  if (!inst?.proof_path)               return res.status(404).json({ error: 'Comprobante no encontrado' });
  if (!fs.existsSync(inst.proof_path)) return res.status(404).json({ error: 'Archivo no encontrado' });
  const safeProof = guardDocPath(inst.proof_path);
  if (!safeProof) return res.status(400).json({ error: 'Ruta de archivo inválida' });
  res.sendFile(safeProof);
});

// ── PUT /:id/assign  — Admin reassigns broker ────────────────────
router.put('/:id/assign', userAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin' });

  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const { broker_user_id, broker_name, broker_email, broker_phone, agency_name } = req.body;

  app.broker = {
    user_id:     broker_user_id || null,
    name:        broker_name || '',
    agency_name: agency_name || '',
    email:       broker_email || '',
    phone:       broker_phone || '',
  };

  addEvent(app, 'broker_assigned', `Broker asignado: ${app.broker.name} (${app.broker.agency_name})`,
    'admin', 'Admin', { broker: app.broker });

  store.saveApplication(app);
  res.json(app);
});

module.exports = router;
