const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const rateLimit  = require('express-rate-limit');
const store      = require('./store');
const { userAuth, optionalAuth } = require('./auth');
const { logSec } = require('./security-log');
const { createAutoTask, autoCompleteTasksByEvent } = require('./tasks');
const notify     = require('../utils/twilio');
const { notify: pushNotify } = require('./push');
const appEvents  = require('./app-events');
const { encrypt, decrypt } = require('../utils/encryption');
const { isSubscriptionActive } = require('../utils/subscription-gate');
const et         = require('../utils/email-templates');
// file-type v16 is the last CJS-compatible release (v17+ is ESM-only)
const { fileTypeFromFile } = require('file-type');

// Sanitize filenames for Content-Disposition headers to prevent header injection
function safeFilename(name) {
  return (name || 'file').replace(/["\r\n\\]/g, '_').slice(0, 200);
}

const router    = express.Router();
// ADMIN_KEY removed from applications.js — Sprint 4 scopes it to /admin/* in server.js only.
// Admin access to the applications API uses JWT role='admin' instead.
const BASE_URL  = process.env.BASE_URL || 'http://localhost:3000';

// ── Rate limiter for anonymous application creation (Item 11) ────────────
// 5 new applications per IP per hour — stops spam/flooding without
// impacting legitimate use (real clients submit once per listing).
//
// `skipFailedRequests: true` so 4xx responses don't burn the budget —
// a user filling the form wrong shouldn't get locked out for an hour.
// Successful 2xx submissions are what we actually care about throttling.
const appCreateLimiter = rateLimit({
  windowMs:           60 * 60 * 1000, // 1 hour
  max:                5,
  skipFailedRequests: true,           // don't count 4xx/5xx towards the cap
  standardHeaders:    true,
  legacyHeaders:      false,
  message:            { error: 'Demasiadas solicitudes. Por favor espera antes de enviar otra aplicación.' },
  handler: (req, res, next, options) => {
    logSec('app_spam_blocked', req, { listing_id: req.body?.listing_id });
    res.status(429).json(options.message);
  },
});

const { createTransport } = require('./mailer');
const transporter = createTransport();

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
  documentos_insuficientes:['documentos_requeridos', 'documentos_enviados', 'rechazado'],
  en_aprobacion:           ['reservado', 'aprobado', 'rechazado'],
  reservado:               ['aprobado', 'rechazado'],
  aprobado:                ['pendiente_pago', 'rechazado'],
  pendiente_pago:          ['pago_enviado', 'rechazado'],
  pago_enviado:            ['pago_aprobado', 'pendiente_pago', 'rechazado'],
  pago_aprobado:           ['completado'],
  completado:              [],
  rechazado:               ['aplicado'],
};

// ── Status ownership ──────────────────────────────────────────────
// Classifies each status by who legitimately sets it. The generic
// PUT /:id/status endpoint is for BROKER-driven transitions only.
// Everything else is set as a side effect of a domain-specific
// endpoint (document upload, receipt upload, payment verification,
// document review) and MUST NOT be settable from the manual API —
// otherwise the broker races the client's automation and you end up
// with "pago_enviado → pago_enviado" transition errors when the UI
// is one tick behind.
//   - broker:      broker can set manually via PUT /:id/status
//   - client_auto: set automatically when the CLIENT uploads something
//   - review_auto: set as a side effect of a broker REVIEW action
//                  (doc review, payment verify)
const STATUS_OWNERSHIP = {
  aplicado:                 'broker',       // reset from rechazado, or initial create
  en_revision:              'broker',
  documentos_requeridos:    'broker',
  documentos_enviados:      'client_auto',  // auto on /documents/upload
  documentos_insuficientes: 'review_auto',  // auto on /documents/:docId/review reject
  en_aprobacion:            'broker',
  reservado:                'broker',
  aprobado:                 'broker',
  pendiente_pago:           'broker',
  pago_enviado:             'client_auto',  // auto on /payment/upload
  pago_aprobado:            'review_auto',  // auto on /payment/verify approve
  completado:               'broker',
  rechazado:                'broker',
};

// Statuses the broker can legitimately set through PUT /:id/status.
// Anything else is blocked with a clear error.
function isBrokerSettable(status) {
  return STATUS_OWNERSHIP[status] === 'broker';
}

// ── File upload (documents & receipts) ────────────────────────────
const DOCS_DIR = path.join(__dirname, '..', 'data', 'documents');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

// Allowed MIME types for uploaded documents / receipts / proofs.
// Expanded to cover real-world task uploads — the original allowlist
// was rejecting things clients commonly send (Word docs, Excel
// financial statements, HEIF/HEIC from iPhone, TIFF scans, BMP,
// plain text, CSV, RTF). Every entry here is also matched by an
// extension in the `docUpload.fileFilter` below so uploads are
// double-gated (extension + magic-byte MIME sniff).
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/pjpeg',
  'image/png', 'image/gif', 'image/webp',
  'image/heic', 'image/heif',
  'image/tiff', 'image/bmp',
  // PDF
  'application/pdf',
  // Office — Word / Excel
  'application/msword',                                                       // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
  'application/vnd.ms-excel',                                                 // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
  // Office — LibreOffice / OpenDocument
  'application/vnd.oasis.opendocument.text',                                  // .odt
  'application/vnd.oasis.opendocument.spreadsheet',                           // .ods
  // Text
  'text/plain',
  'text/csv',
  'application/rtf', 'text/rtf',
  // Common compressed wrappers clients sometimes use
  'application/zip',
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

// Guard a file path against path-traversal attacks (including symlink escapes).
// Returns the real absolute path if it is within DOCS_DIR, otherwise null.
function guardDocPath(rawPath) {
  try {
    const resolved = path.resolve(rawPath);
    const base     = path.resolve(DOCS_DIR);
    // First-level check on the resolved path (before realpath) to catch obvious escapes
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    // Resolve symlinks on both sides and re-compare to prevent symlink escapes
    const realFile = fs.realpathSync(resolved);
    const realBase = fs.realpathSync(base);
    if (realFile === realBase) return null;
    if (!realFile.startsWith(realBase + path.sep)) return null;
    return realFile;
  } catch {
    return null;
  }
}

const docStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOCS_DIR),
  filename:    (req, file, cb) => cb(null, `${uuid()}_${file.originalname.replace(/\s/g, '_')}`),
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB (was 10 — accommodate photos of paper docs)
  fileFilter: (req, file, cb) => {
    // Extension allowlist matches ALLOWED_MIME_TYPES above. Anything that
    // passes here still has to pass the magic-byte sniff in validateMime().
    const ok = /\.(jpg|jpeg|png|gif|webp|heic|heif|tif|tiff|bmp|pdf|doc|docx|xls|xlsx|odt|ods|txt|csv|rtf|zip)$/i.test(file.originalname);
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
  if (!app.timeline_events) app.timeline_events = [];
  app.timeline_events.push({
    id: uuid(), type, description, actor, actor_name: actorName, data,
    created_at: new Date().toISOString(),
  });
  app.updated_at = new Date().toISOString();
}

function sendNotification(to, subject, html) {
  if (!to) return;
  transporter.sendMail({ to, subject, html, department: 'admin' })
    .catch(err => console.error('[applications] Email failed:', subject, '→', to, err.message));
}

function statusEmail(app, oldStatus, newStatus, reason) {
  const STATUS_NAMES = {
    aplicado: 'Aplicado', en_revision: 'En Revision', documentos_requeridos: 'Documentos Requeridos',
    documentos_enviados: 'Documentos Enviados', documentos_insuficientes: 'Documentos Insuficientes',
    en_aprobacion: 'En Aprobacion', reservado: 'Reservado', aprobado: 'Aprobado',
    pendiente_pago: 'Pendiente de Pago', pago_enviado: 'Pago Enviado',
    pago_aprobado: 'Pago Aprobado', completado: 'Completado', rechazado: 'Rechazado',
  };
  const statusName = STATUS_NAMES[newStatus] || newStatus;
  const isPositive = ['aprobado', 'pago_aprobado', 'completado', 'reservado'].includes(newStatus);
  const isNegative = ['rechazado', 'documentos_insuficientes'].includes(newStatus);
  const badgeColor = isPositive ? '#16a34a' : isNegative ? '#CE1126' : '#002D62';

  const body = et.p('Tu aplicacion para <strong>' + et.esc(app.listing_title) + '</strong> ha sido actualizada.')
    + '<div style="text-align:center;margin:20px 0;">' + et.statusBadge(statusName, badgeColor) + '</div>'
    + (reason ? et.alertBox('<strong>Motivo:</strong> ' + et.esc(reason), isNegative ? 'danger' : 'info') : '')
    + et.button('Ver mi aplicacion', (process.env.BASE_URL || 'https://hogaresrd.com') + '/my-applications?id=' + app.id)
    + et.divider()
    + et.small('Si tienes preguntas sobre este cambio, responde a este correo.');

  return {
    subject: 'Tu aplicacion: ' + statusName + ' — HogaresRD',
    html: et.layout({ title: 'Estado de tu aplicacion', subtitle: et.esc(app.listing_title), preheader: 'Tu aplicacion para ' + (app.listing_title || '') + ' ahora esta: ' + statusName, body }),
  };
}


function fmtAmt(n, cur) {
  return `${cur || 'DOP'} ${Number(n || 0).toLocaleString('es-DO')}`;
}

function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildPaymentPlanEmail(app) {
  const plan = app.payment_plan;
  if (!plan?.installments || !Array.isArray(plan.installments)) return '';
  const rows = plan.installments.map(i =>
    `<tr>
       <td style="padding:9px 12px;border-bottom:1px solid ${et.C.bg};font-size:0.88rem;color:${et.C.text};">#${i.number} — ${_esc(i.label)}</td>
       <td style="padding:9px 12px;border-bottom:1px solid ${et.C.bg};font-size:0.88rem;font-weight:700;color:${et.C.navy};">${fmtAmt(i.amount, plan.currency)}</td>
       <td style="padding:9px 12px;border-bottom:1px solid ${et.C.bg};font-size:0.88rem;color:${et.C.muted};">${_esc(i.due_date) || '—'}</td>
     </tr>`
  ).join('');
  const tableHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid ${et.C.border};border-radius:8px;overflow:hidden;">
    <thead><tr style="background:${et.C.bg};"><th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:${et.C.muted};font-weight:700;">Cuota</th><th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:${et.C.muted};font-weight:700;">Monto</th><th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:${et.C.muted};font-weight:700;">Vence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  return et.layout({
    title: 'Plan de pagos creado',
    subtitle: et.esc(app.listing_title),
    preheader: 'Se creo un plan de pagos para tu aplicacion en HogaresRD',
    body: `
      ${et.p('Tu agente ha creado un plan de pagos para tu solicitud de <strong>' + et.esc(app.listing_title) + '</strong>.')}
      ${et.infoTable(et.infoRow('Metodo de pago', _esc(plan.payment_method) || '—'))}
      ${plan.method_details ? et.alertBox(et.esc(plan.method_details), 'info') : ''}
      ${tableHtml}
      ${plan.notes ? et.small('<strong>Notas:</strong> ' + et.esc(plan.notes)) : ''}
      ${et.button('Ver mi plan de pagos', BASE_URL + '/my-applications')}
    `,
  });
}

function buildPaymentReminderEmail(app, inst) {
  const plan = app.payment_plan;
  const dueLabel = inst.due_date
    ? new Date(inst.due_date + 'T12:00:00').toLocaleDateString('es-DO', { year:'numeric', month:'long', day:'numeric' })
    : 'proximamente';
  return et.layout({
    title: 'Recordatorio de pago',
    subtitle: et.esc(app.listing_title),
    preheader: `Cuota #${inst.number} vence ${dueLabel} — ${fmtAmt(inst.amount, plan.currency)}`,
    headerColor: '#b45309',
    body: `
      ${et.p('Tienes un pago pendiente para tu solicitud de <strong>' + et.esc(app.listing_title) + '</strong>.')}
      ${et.alertBox(
        `<strong>Cuota #${inst.number}</strong> — ${et.esc(inst.label)}<br/>` +
        `<span style="font-size:1.1rem;font-weight:700;">${fmtAmt(inst.amount, plan.currency)}</span><br/>` +
        `Vence: ${dueLabel}`,
        'warning'
      )}
      ${et.infoTable(et.infoRow('Metodo de pago', plan.payment_method || '—'))}
      ${plan.method_details ? et.small(et.esc(plan.method_details)) : ''}
      ${et.p('Una vez realizado el pago, sube tu comprobante en el portal.')}
      ${et.button('Subir comprobante', BASE_URL + '/my-applications')}
    `,
  });
}

// ══════════════════════════════════════════════════════════════════
// ── POST /  — Create application ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// optionalAuth so the endpoint stays public (anonymous applies are a
// real product feature) but, when an authenticated session IS present,
// we can derive the client identity from req.user.sub. The previous
// behavior of trusting req.body.user_id let an anonymous attacker
// attribute an application to any victim's account; that attribution
// is now ignored in favor of the JWT-verified subject.
router.post('/', appCreateLimiter, optionalAuth, (req, res) => {
  const {
    listing_id, listing_title, listing_price, listing_type,
    name, phone, email,
    financing, pre_approved, contact_method, budget, timeline, intent, notes,
    // ── Extended fields (all optional) ───────────────────────────────
    id_type,             // 'cedula' | 'passport'
    id_number,           // digits/alphanum, validated loosely below
    nationality,         // e.g. 'Dominicano', 'Estadounidense'
    current_address,     // free text
    date_of_birth,       // YYYY-MM-DD
    employment_status,   // 'employed' | 'self_employed' | 'retired' | 'student' | 'unemployed'
    employer_name,       // company name
    job_title,           // position
    monthly_income,      // numeric string
    income_currency,     // 'USD' | 'DOP'
    // ── Co-applicant (optional) ──────────────────────────────────────
    co_applicant,        // { name, phone, email, id_number, monthly_income } or null
    // ── Deferred documents ───────────────────────────────────────────
    // Array of { type, label } for documents the applicant will upload
    // later from /my-applications. These are added as `pending` requests
    // on the application so the broker sees what's still outstanding.
    deferred_documents,
    _hp, // honeypot — must be absent or empty (bots fill all fields)
  } = req.body;

  // ── Honeypot: bots fill hidden fields; real users never see them ──
  if (_hp) {
    // Return 200 to the bot so it thinks it succeeded (don't reveal the block)
    return res.status(200).json({ success: true, id: `fake_${Date.now()}` });
  }

  if (!name || !phone || !listing_id)
    return res.status(400).json({ error: 'name, phone y listing_id son requeridos' });

  // Verify the listing actually exists, is approved, and is still on
  // the market. Without this guard, an attacker could spam the admin's
  // orphan-lead inbox with bogus listing_ids, and clients could apply
  // to drafts or already-sold properties.
  {
    const listingPreflight = store.getListingById(listing_id);
    if (!listingPreflight) {
      return res.status(404).json({ error: 'Propiedad no encontrada.' });
    }
    // Only `approved` listings should accept new applications. Drafts,
    // pending review, rejected, or sold listings should not. Treat the
    // legacy `submitted` value the same as approved for backward compat
    // (very old rows that pre-date the approval workflow).
    const lstStatus = listingPreflight.status || '';
    const acceptableStatuses = new Set(['approved', 'submitted']);
    if (!acceptableStatuses.has(lstStatus)) {
      return res.status(400).json({
        error: 'Esta propiedad no está disponible para nuevas aplicaciones.',
        code: 'listing_not_available',
        listing_status: lstStatus,
      });
    }
  }

  // ── Input validation (Sprint 3, Item 11 + incomplete-submission fix) ─────
  //
  // A "complete" application is the MINIMUM set of fields a broker needs
  // to actually work the lead. Before this was tightened, users could
  // submit with just name+phone and the agent would get a useless entry.
  // Every additional field below is rejected with a clear message pointing
  // at which step of the form is missing data.
  const nameTrimmed  = name.trim();
  const phoneTrimmed = phone.trim();
  const emailTrimmed = (email || '').trim();

  if (nameTrimmed.length < 2 || nameTrimmed.length > 120)
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 120 caracteres' });

  // Phone: allow digits, spaces, dashes, parentheses, leading +
  if (!/^\+?[\d\s\-().]{7,20}$/.test(phoneTrimmed))
    return res.status(400).json({ error: 'Número de teléfono inválido' });

  // Cap free-text notes at 2000 chars so an attacker can't post huge
  // payloads through this endpoint. Real users typing one or two
  // paragraphs stay well under this.
  if (typeof notes === 'string' && notes.length > 2000)
    return res.status(400).json({ error: 'Las notas son demasiado largas (máximo 2000 caracteres).' });

  // ── Step 1 required fields ──────────────────────────────────────
  if (!emailTrimmed)
    return res.status(400).json({ error: 'El correo electrónico es obligatorio (paso 1).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailTrimmed))
    return res.status(400).json({ error: 'Correo electrónico inválido (paso 1).' });

  const VALID_INTENTS   = ['comprar', 'alquilar', 'invertir'];
  const VALID_TIMELINES = ['Inmediato', '1-3 meses', '3-6 meses', '6-12 meses', '+1 año'];
  const VALID_CONTACT   = ['whatsapp', 'llamada', 'email'];

  if (!intent || !VALID_INTENTS.includes(intent))
    return res.status(400).json({ error: 'Selecciona una intención válida (paso 1).' });
  if (!timeline || !VALID_TIMELINES.includes(timeline))
    return res.status(400).json({ error: 'Selecciona un plazo estimado (paso 1).' });
  if (!contact_method || !VALID_CONTACT.includes(contact_method))
    return res.status(400).json({ error: 'Selecciona un método de contacto preferido (paso 1).' });

  const budgetTrimmed = String(budget || '').trim();
  if (!budgetTrimmed)
    return res.status(400).json({ error: 'El presupuesto es obligatorio (paso 1).' });
  const budgetDigits = Number(budgetTrimmed.replace(/[^\d.]/g, ''));
  if (!isFinite(budgetDigits) || budgetDigits <= 0)
    return res.status(400).json({ error: 'El presupuesto debe ser un número válido mayor a 0 (paso 1).' });

  // ── Step 2 required fields ──────────────────────────────────────
  const VALID_ID_TYPES    = ['cedula', 'passport'];
  const VALID_EMP_STATUS  = ['employed', 'self_employed', 'retired', 'student', 'unemployed'];
  const VALID_FINANCING   = ['efectivo', 'banco', 'desarrollador', 'vendedor'];

  const idTypeRaw    = String(id_type || '').trim();
  const idNumberRaw  = String(id_number || '').trim();
  const dobRaw       = String(date_of_birth || '').trim();
  const addressRaw   = String(current_address || '').trim();
  const empStatusRaw = String(employment_status || '').trim();
  const incomeRaw    = String(monthly_income || '').trim();
  const financingRaw = String(financing || '').trim();

  if (!VALID_ID_TYPES.includes(idTypeRaw))
    return res.status(400).json({ error: 'Selecciona un tipo de identificación (paso 2).' });
  if (!idNumberRaw || idNumberRaw.length < 5)
    return res.status(400).json({ error: 'Número de identificación inválido (paso 2).' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobRaw))
    return res.status(400).json({ error: 'Fecha de nacimiento es obligatoria y debe tener formato YYYY-MM-DD (paso 2).' });
  // Basic age sanity (must be 18+ and not in the future)
  const dob = new Date(dobRaw);
  const today = new Date();
  if (isNaN(dob.getTime()) || dob > today)
    return res.status(400).json({ error: 'Fecha de nacimiento inválida (paso 2).' });
  const ageYears = (today - dob) / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 18)
    return res.status(400).json({ error: 'Debes ser mayor de edad para aplicar (paso 2).' });

  if (!addressRaw || addressRaw.length < 5)
    return res.status(400).json({ error: 'La dirección actual es obligatoria (paso 2).' });
  if (!VALID_EMP_STATUS.includes(empStatusRaw))
    return res.status(400).json({ error: 'Selecciona una situación laboral (paso 2).' });

  // Employer & job title required only when the user reports being employed
  if (['employed', 'self_employed'].includes(empStatusRaw)) {
    const employerRaw = String(employer_name || '').trim();
    const jobTitleRaw = String(job_title || '').trim();
    if (!employerRaw)
      return res.status(400).json({ error: 'Indica el nombre de tu empleador o empresa (paso 2).' });
    if (!jobTitleRaw)
      return res.status(400).json({ error: 'Indica tu puesto o cargo (paso 2).' });
  }

  const incomeDigits = Number(incomeRaw.replace(/[^\d.]/g, ''));
  if (!incomeRaw || !isFinite(incomeDigits) || incomeDigits <= 0)
    return res.status(400).json({ error: 'Ingreso mensual es obligatorio y debe ser mayor a 0 (paso 2).' });

  if (!VALID_FINANCING.includes(financingRaw))
    return res.status(400).json({ error: 'Selecciona un método de financiamiento (paso 2).' });

  // ── Co-applicant validation (if the applicant opted in) ─────────
  if (co_applicant && typeof co_applicant === 'object') {
    const coName  = String(co_applicant.name  || '').trim();
    const coPhone = String(co_applicant.phone || '').trim();
    const coId    = String(co_applicant.id_number || '').trim();
    const coIncome = String(co_applicant.monthly_income || '').trim();
    // Only enforce when the object has ANY content — an empty object = no
    // co-applicant (UI sometimes sends the key even when unchecked).
    const hasAny = coName || coPhone || coId || coIncome;
    if (hasAny) {
      if (!coName || coName.length < 2)
        return res.status(400).json({ error: 'Nombre del co-aplicante es obligatorio (paso 2).' });
      if (!/^\+?[\d\s\-().]{7,20}$/.test(coPhone))
        return res.status(400).json({ error: 'Teléfono del co-aplicante inválido (paso 2).' });
      if (!coId || coId.length < 5)
        return res.status(400).json({ error: 'Cédula/Pasaporte del co-aplicante es obligatorio (paso 2).' });
      const coIncomeNum = Number(coIncome.replace(/[^\d.]/g, ''));
      if (!coIncome || !isFinite(coIncomeNum) || coIncomeNum <= 0)
        return res.status(400).json({ error: 'Ingreso mensual del co-aplicante es obligatorio (paso 2).' });
    }
  }

  // ── Step 3 documents ────────────────────────────────────────────
  // The two "core" documents must either be attached in this request
  // (tracked separately via /initial-upload after create) OR deferred
  // via the deferred_documents list. An applicant may not submit with
  // both skipped. The frontend should enforce this too but we guard
  // server-side so API clients can't bypass it.
  {
    const deferredTypes = new Set(
      Array.isArray(deferred_documents)
        ? deferred_documents.map(d => String(d?.type || '')).filter(Boolean)
        : []
    );
    const attachedTypes = new Set(
      Array.isArray(req.body.attached_document_types)
        ? req.body.attached_document_types.map(t => String(t || '')).filter(Boolean)
        : []
    );
    const requiredDocs = ['cedula', 'income_proof'];
    const missingDocs = requiredDocs.filter(t => !deferredTypes.has(t) && !attachedTypes.has(t));
    if (missingDocs.length) {
      const labels = { cedula: 'Cédula/Pasaporte', income_proof: 'Comprobante de Ingresos' };
      return res.status(400).json({
        error: 'Debes adjuntar o marcar para subir después los siguientes documentos: ' +
               missingDocs.map(t => labels[t] || t).join(', ') + ' (paso 3).',
      });
    }
  }

  // Find listing to get affiliated broker
  const listing = store.getListingById(listing_id);
  const agencies = listing?.agencies || [];

  // Resolve affiliate ref_token early — determines how the lead is routed
  const earlyRefToken = req.body.ref_token || req.cookies?.hrd_ref || null;
  let referredByAgent = null;
  let referredByInmobiliaria = null; // set when ref comes from an org (cascade within team)
  if (earlyRefToken) {
    const refUser = store.getUserByRefToken(earlyRefToken);
    if (refUser) {
      if (['agency', 'broker'].includes(refUser.role)) {
        // Individual agent link → lead goes DIRECTLY to this agent, no cascade
        referredByAgent = refUser;
      } else if (['inmobiliaria', 'constructora'].includes(refUser.role)) {
        // Org link → cascade within this inmobiliaria's team only
        referredByInmobiliaria = refUser;
      }
    }
  }

  // Cascade decision:
  // - Broker ref → no cascade (direct assign)
  // - Inmobiliaria ref → cascade scoped to that org's team
  // - No ref → normal cascade among listing agencies
  const cascadeEngine = require('./cascade-engine');
  const useCascade = cascadeEngine.isEnabled() && (agencies.length > 0 || referredByInmobiliaria) && !referredByAgent;

  // Helper: try to resolve an agency contact to a registered user
  // so we can populate broker.user_id. Listings with agency cards
  // that were submitted BEFORE the agent registered (or without
  // linking them to a user account) end up with agency.user_id = null.
  // We recover by looking up the registered user by email, then by
  // phone — whichever matches first. This makes the application
  // visible in that agent's dashboard instead of orphaning it.
  function resolveAgencyToUser(agency) {
    if (!agency) return null;
    if (agency.user_id) {
      const u = store.getUserById(agency.user_id);
      if (u) return u;
    }
    if (agency.email) {
      const u = store.getUserByEmail(agency.email);
      if (u) return u;
    }
    // Best-effort phone lookup. Match on the last 8 digits (covers DR
    // local-form 8095551234 vs international +1-809-555-1234) AND
    // require both numbers to be at least 8 digits long, so accidental
    // collisions on short numbers don't route the lead to the wrong
    // person. If multiple users match, log it and fall through — we'd
    // rather orphan the lead than mis-route it.
    if (agency.phone) {
      const cleanPhone = String(agency.phone).replace(/\D/g, '');
      if (cleanPhone.length >= 8) {
        const tail = cleanPhone.slice(-8);
        const matches = (store.getUsers() || []).filter(u => {
          const up = String(u.phone || '').replace(/\D/g, '');
          return up.length >= 8 && up.endsWith(tail);
        });
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
          console.warn(`[applications] resolveAgencyToUser: ambiguous phone match for ${tail} — ${matches.length} users — declining to route`);
        }
      }
    }
    return null;
  }

  let broker = { user_id: null, name: '', agency_name: '', email: '', phone: '' };
  if (referredByAgent) {
    // Individual broker affiliate link → assign directly ONLY if subscription active
    if (isSubscriptionActive(referredByAgent)) {
      broker = {
        user_id:     referredByAgent.id,
        name:        referredByAgent.name || '',
        agency_name: referredByAgent.inmobiliaria_name || '',
        email:       referredByAgent.email || '',
        phone:       referredByAgent.phone || '',
      };
    } else {
      // Agent's subscription is inactive — treat as unassigned, let cascade or fallback handle it
      console.warn(`[applications] Referred agent ${referredByAgent.id} has inactive subscription — skipping direct assignment`);
      referredByAgent = null; // clear so cascade/fallback activates
    }
  } else if (referredByInmobiliaria) {
    // Inmobiliaria affiliate link → leave broker unassigned, cascade within team
    broker = { user_id: null, name: 'Pendiente de asignación', agency_name: referredByInmobiliaria.name || '', email: '', phone: '' };
  } else if (!useCascade && agencies.length) {
    const agency = agencies[0];
    const resolved = resolveAgencyToUser(agency);
    const candidateUser = resolved || (agency.user_id ? store.getUserById(agency.user_id) : null);
    // Only assign if the agent has an active subscription
    if (candidateUser && isSubscriptionActive(candidateUser)) {
      broker = {
        user_id: candidateUser.id,
        name:    agency.contact || agency.name || candidateUser.name || '',
        agency_name: agency.name || '',
        email:   candidateUser.email || agency.email || '',
        phone:   candidateUser.phone || agency.phone || '',
      };
    } else {
      console.warn(`[applications] First agency agent has inactive subscription — leaving unassigned`);
    }
  } else if (useCascade) {
    // Even when cascade is used, pre-resolve the first agency's user
    // so we can fall back to them if cascade returns null later.
    // broker.user_id stays null for now but will be populated in the
    // fallback branch if needed.
    broker = { user_id: null, name: 'Pendiente de asignación', agency_name: '', email: '', phone: '' };
  }

  // Snapshot inmobiliaria affiliation at application creation time
  const brokerUser = broker.user_id ? store.getUserById(broker.user_id) : null;
  const inmobiliaria_id   = brokerUser?.inmobiliaria_id   || null;
  const inmobiliaria_name = brokerUser?.inmobiliaria_name || null;

  // ── Idempotency: dedup identical submissions within 60s (network retry / race) ──
  if (emailTrimmed) {
    const sixtySecondsAgo = Date.now() - 60 * 1000;
    const existing = (store.getApplications() || []).find(a =>
      a.listing_id === listing_id
      && a.client && a.client.email && a.client.email.toLowerCase() === emailTrimmed.toLowerCase()
      && a.created_at && new Date(a.created_at).getTime() >= sixtySecondsAgo
    );
    if (existing) {
      return res.status(200).json({ id: existing.id, duplicate: true });
    }
  }

  // ── Sanitize extended fields ─────────────────────────────────────
  const safeStr  = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const safeEnum = (v, allowed, fallback = '') => (allowed.includes(v) ? v : fallback);

  const clientExtended = {
    id_type:           safeEnum(id_type, ['cedula', 'passport', '']),
    id_number:         encrypt(safeStr(id_number, 30)) || '',       // ENCRYPTED: government ID
    nationality:       safeStr(nationality, 60),
    current_address:   safeStr(current_address, 250),
    date_of_birth:     /^\d{4}-\d{2}-\d{2}$/.test(date_of_birth || '') ? date_of_birth : '',
    employment_status: safeEnum(employment_status, ['employed','self_employed','retired','student','unemployed',''], ''),
    employer_name:     encrypt(safeStr(employer_name, 120)) || '',  // ENCRYPTED: employer
    job_title:         safeStr(job_title, 80),
    monthly_income:    encrypt(safeStr(String(monthly_income || ''), 20)) || '', // ENCRYPTED: income
    income_currency:   safeEnum(income_currency, ['USD','DOP',''], 'DOP'),
  };

  // Co-applicant (if provided as object)
  let coApplicant = null;
  if (co_applicant && typeof co_applicant === 'object') {
    const coName  = safeStr(co_applicant.name, 120);
    const coPhone = safeStr(co_applicant.phone, 20);
    if (coName || coPhone) {
      coApplicant = {
        name:           coName,
        phone:          coPhone,
        email:          safeStr(co_applicant.email, 120),
        id_number:      encrypt(safeStr(co_applicant.id_number, 30)) || '',       // ENCRYPTED
        monthly_income: encrypt(safeStr(String(co_applicant.monthly_income || ''), 20)) || '', // ENCRYPTED
      };
    }
  }

  // Deferred documents — add as `pending` requests so broker can track them
  const deferredDocs = [];
  if (Array.isArray(deferred_documents)) {
    for (const d of deferred_documents.slice(0, 15)) {
      if (!d || typeof d !== 'object') continue;
      const type = safeStr(d.type, 50);
      if (!type) continue;
      deferredDocs.push({
        id:           uuid(),
        type,
        label:        safeStr(d.label, 120) || DOCUMENT_TYPES[type] || 'Documento',
        required:     d.required !== false,
        requested_at: new Date().toISOString(),
        status:       'pending',
        deferred:     true, // flag so UI can show "Cliente subirá después"
      });
    }
  }

  const app = {
    id:             uuid(),
    listing_id:     listing_id || '',
    listing_title:  listing_title || listing?.title || '',
    listing_price:  Number(listing_price) || Number(listing?.price) || 0,
    listing_type:   listing_type  || listing?.type  || '',
    client: {
      name:    nameTrimmed,
      phone:   phoneTrimmed,
      email:   emailTrimmed,
      // Authenticated session takes precedence; body's user_id is
      // ignored entirely. Anonymous submissions land with user_id=null
      // and can be auto-claimed later when the email matches a
      // registered user (see the email-based fallback in /my).
      user_id: req.user?.sub || null,
      ...clientExtended,
    },
    co_applicant:   coApplicant,
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
    documents_requested: deferredDocs,
    documents_uploaded:  [],
    tours:               [],
    payment: {
      amount: null, currency: 'DOP', receipt_path: null,
      receipt_filename: null, receipt_original: null,
      receipt_uploaded_at: null, verification_status: 'none',
      verified_at: null, verified_by: null, notes: '',
    },
    payment_plan: null,
    inmobiliaria_id,
    inmobiliaria_name,
    ref_token:       req.body.ref_token || req.cookies?.hrd_ref || null,
    referred_by:     null, // resolved below
    timeline_events: [],
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
  };

  // Resolve referring agent/org (already looked up above for cascade bypass)
  if (referredByAgent) {
    app.referred_by = referredByAgent.id;
  } else if (referredByInmobiliaria) {
    app.referred_by = referredByInmobiliaria.id;
    // Set inmobiliaria context so the org's team can see this application
    app.inmobiliaria_id   = referredByInmobiliaria.id;
    app.inmobiliaria_name = referredByInmobiliaria.name || '';
  }

  addEvent(app, 'status_change', 'Aplicación recibida', 'system', 'Sistema',
    { from: null, to: 'aplicado' });

  // If the applicant deferred documents, log it and create an auto-task
  if (deferredDocs.length > 0) {
    addEvent(app, 'documents_requested',
      `El cliente indicó que subirá ${deferredDocs.length} documento(s) más tarde: ${deferredDocs.map(d => d.label).join(', ')}`,
      'system', 'Sistema',
      { documents: deferredDocs.map(d => d.label), deferred: true });

    if (app.client.user_id) {
      createAutoTask({
        title:          `Sube los documentos pendientes para ${app.listing_title || 'tu aplicación'}`,
        description:    deferredDocs.map(d => d.label).join(', '),
        assigned_to:    app.client.user_id,
        assigned_by:    'system',
        application_id: app.id,
        listing_id:     app.listing_id,
        source_event:   'documents_requested',
      });
    }
  }

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

  if (useCascade) {
    // Cascade path. We do the synchronous broker-assignment work BEFORE
    // sending the response so a client polling /api/applications/:id
    // immediately after creation sees the resolved broker (or null only
    // when the lead is truly orphaned). Notification fan-out below the
    // res.json runs as fire-and-forget so the response doesn't wait on
    // it.
    const buyerInfo = { name: app.client.name, phone: app.client.phone, email: app.client.email };
    // If this came from an inmobiliaria affiliate link, scope cascade to their team only
    const cascadeScope = referredByInmobiliaria ? referredByInmobiliaria.id : null;
    const cascadeResult = cascadeEngine.startCascade('application', app.id, listing_id, buyerInfo, cascadeScope);

    // Synchronous fallback: if the cascade engine returns null because
    // NO agents on the listing are linked to registered users (e.g. the
    // agencies array only has email/phone contact info), assign the
    // first resolvable subscribed agent BEFORE we respond.
    let assignedUser = null;
    if (!cascadeResult) {
      console.warn('[applications] Cascade returned null — falling back to direct agency notifications for app', app.id);
      for (const agency of agencies) {
        const resolved = resolveAgencyToUser(agency);
        if (resolved && isSubscriptionActive(resolved)) { assignedUser = resolved; break; }
      }

      if (assignedUser) {
        app.broker = {
          user_id:     assignedUser.id,
          name:        assignedUser.name || (agencies[0]?.contact || agencies[0]?.name || ''),
          agency_name: agencies[0]?.name || '',
          email:       assignedUser.email || agencies[0]?.email || '',
          phone:       assignedUser.phone || agencies[0]?.phone || '',
        };
        // Pick up any inmobiliaria affiliation the resolved user has
        if (assignedUser.inmobiliaria_id) {
          app.inmobiliaria_id   = assignedUser.inmobiliaria_id;
          app.inmobiliaria_name = assignedUser.inmobiliaria_name || null;
        } else if (['inmobiliaria','constructora'].includes(assignedUser.role)) {
          app.inmobiliaria_id   = assignedUser.id;
          app.inmobiliaria_name = assignedUser.companyName || assignedUser.name || null;
        }
        app.updated_at = new Date().toISOString();
        addEvent(app, 'status_change',
          `Agente auto-asignado: ${assignedUser.name || assignedUser.email}`,
          'system', 'Sistema',
          { from: null, to: assignedUser.id, via: 'cascade-fallback' });
        store.saveApplication(app);
      }
    }

    // Broker assignment is now final — respond.
    res.status(201).json({ ok: true, id: app.id });

    if (!cascadeResult) {
      // Notifications — email every agency card + push/WhatsApp to
      // any resolvable user (not just the first one, so multi-agency
      // listings still broadcast).
      for (const agency of agencies) {
        if (agency.email) {
          sendNotification(agency.email,
            `Nueva aplicación — ${app.listing_title}`,
            newAppHtml(agency.name ? `Para ${agency.name}` : ''));
        }

        const contactUser = resolveAgencyToUser(agency);
        if (contactUser) {
          pushNotify(contactUser.id, {
            type:  'new_application',
            title: 'Nueva Aplicación',
            body:  `${app.client.name} aplicó para ${app.listing_title}`,
            url:   '/broker.html',
          });
          if (contactUser.phone || agency.phone) {
            setImmediate(async () => {
              try {
                await notify.notifyBrokerNewApplication({
                  brokerPhone:   contactUser.phone || agency.phone,
                  clientName:    app.client.name,
                  propertyTitle: app.listing_title,
                  appId:         app.id,
                });
              } catch (e) { console.error('[notify-app fallback]', e.message); }
            });
          }
        }
      }

      // Also notify the inmobiliaria if we can resolve one from the app
      if (app.inmobiliaria_id) {
        const inmUser = store.getUserById(app.inmobiliaria_id);
        if (inmUser?.email) {
          sendNotification(
            inmUser.email,
            assignedUser
              ? `Nueva aplicación asignada a ${assignedUser.name} — ${app.listing_title}`
              : `Nueva aplicación pendiente — ${app.listing_title}`,
            newAppHtml(assignedUser ? `Agente: ${assignedUser.name}` : 'Sin agente asignado — por favor reasignar')
          );
        }
      }

      // ── ADMIN FALLBACK: if no agent was assigned, alert admin ─────
      if (!assignedUser) {
        const adminEmail = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';
        console.warn(`[applications] ORPHANED LEAD: app ${app.id} — no active agents available for ${app.listing_title}`);
        sendNotification(adminEmail,
          `⚠️ Lead sin agente — ${app.client.name} → ${app.listing_title}`,
          et.layout({
            title: 'Lead sin agente asignado',
            headerColor: '#b45309',
            body: et.alertBox('Este lead no tiene un agente activo asignado. Todos los agentes afiliados tienen suscripción inactiva o no pudieron ser contactados.', 'warning')
              + et.infoTable(
                  et.infoRow('Cliente', et.esc(app.client.name))
                + et.infoRow('Teléfono', et.esc(app.client.phone))
                + et.infoRow('Email', et.esc(app.client.email))
                + et.infoRow('Propiedad', et.esc(app.listing_title))
                + et.infoRow('ID Aplicación', app.id)
              )
              + et.button('Reasignar en Admin', `${BASE_URL}/${process.env.ADMIN_PATH || 'admin'}`)
          })
        );
        addEvent(app, 'orphaned_lead', 'Sin agente activo disponible — admin notificado',
          'system', 'Sistema', { reason: 'no_active_agents' });
        store.saveApplication(app);
      }
    }
  } else {
    // Standard path: notify broker directly
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

    // Push notification → broker (fire-and-forget)
    if (broker.user_id) {
      pushNotify(broker.user_id, {
        type: 'new_application',
        title: 'Nueva Aplicación',
        body: `${app.client.name} aplicó para ${app.listing_title}`,
        url: '/broker.html',
      });
    }
    if (inmobiliaria_id) {
      pushNotify(inmobiliaria_id, {
        type: 'new_application',
        title: 'Nueva Aplicación',
        body: `${app.client.name} aplicó para ${app.listing_title} (${broker.name || 'agente'})`,
        url: '/broker.html',
      });
    }

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
  }
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
  } else if (user.role === 'inmobiliaria' || user.role === 'constructora') {
    apps = store.getApplicationsByInmobiliaria(user.id);
    // Also include applications where this user applied as a client
    const asClient = store.getApplicationsByClient(user.id);
    for (const a of asClient) { if (!apps.some(x => x.id === a.id)) apps.push(a); }
  } else if (user.role === 'secretary') {
    apps = store.getApplicationsByInmobiliaria(user.inmobiliaria_id);
  } else if (['agency', 'broker'].includes(user.role)) {
    apps = store.getApplicationsByBroker(user.id);
    // Also include applications where this pro user applied as a client
    const asClient = store.getApplicationsByClient(user.id);
    for (const a of asClient) { if (!apps.some(x => x.id === a.id)) apps.push(a); }
  } else {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const { status } = req.query;
  if (status) apps = apps.filter(a => a.status === status);

  res.json(apps.map(decryptAppPII));
});

// ── GET /my  — Client's own applications ─────────────────────────
//
// Two-step lookup so applications submitted anonymously (before the
// user registered) get attached to the right account once they sign
// up with the matching email:
//   1. Anything currently attributed to user.id.
//   2. Anything submitted with no user_id but the same email — those
//      are auto-claimed (we set client.user_id = user.id and save) so
//      future calls don't need the email scan.
//
// Email auth is gated by verification, so by the time req.user.sub is
// set, the user has proven control of that email — claiming anon apps
// submitted with it is safe.
router.get('/my', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  let apps = store.getApplicationsByClient(user.id);

  // Auto-claim any anonymous apps that match this user's email.
  if (user.email) {
    const lowerEmail = user.email.toLowerCase();
    const claimable = (store.getApplications() || []).filter(a => {
      if (!a.client) return false;
      if (a.client.user_id) return false; // already attributed
      const ce = (a.client.email || '').toLowerCase();
      return ce && ce === lowerEmail;
    });
    if (claimable.length > 0) {
      const now = new Date().toISOString();
      for (const a of claimable) {
        a.client.user_id = user.id;
        a.updated_at = now;
        store.saveApplication(a);
      }
      // Re-pull so the response includes the freshly claimed ones.
      apps = store.getApplicationsByClient(user.id);
    }
  }

  // Enrich with listing cover image + city for the card UI.
  // decryptAppPII first so the spread doesn't propagate ciphertext.
  const enriched = apps.map(a => {
    const dec = decryptAppPII(a);
    const listing = a.listing_id ? store.getListingById(a.listing_id) : null;
    const images = Array.isArray(listing?.images) ? listing.images : [];
    return {
      ...dec,
      listing_image: images[0] || null,
      listing_city:  listing?.city || null,
    };
  });
  res.json(enriched);
});

// ── GET /statuses  — Available statuses ──────────────────────────
router.get('/statuses', (req, res) => {
  res.json({
    statuses: STATUS_LABELS,
    flow: STATUS_FLOW,
    ownership: STATUS_OWNERSHIP,
    documentTypes: DOCUMENT_TYPES,
  });
});

// ── GET /:id  — Single application detail ────────────────────────
router.get('/:id', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';

  if (!isBroker && !isInmobiliaria && !isSecretary && !isClient && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  res.json(decryptAppPII(app));
});

// Helper: decrypt sensitive PII + financial fields before sending to authorized users
function decryptAppPII(app) {
  const copy = JSON.parse(JSON.stringify(app)); // deep clone
  // PII fields
  if (copy.client) {
    if (copy.client.id_number)      copy.client.id_number      = decrypt(copy.client.id_number);
    if (copy.client.monthly_income) copy.client.monthly_income = decrypt(copy.client.monthly_income);
    if (copy.client.employer_name)  copy.client.employer_name  = decrypt(copy.client.employer_name);
  }
  if (copy.co_applicant) {
    if (copy.co_applicant.id_number)      copy.co_applicant.id_number      = decrypt(copy.co_applicant.id_number);
    if (copy.co_applicant.monthly_income) copy.co_applicant.monthly_income = decrypt(copy.co_applicant.monthly_income);
  }
  // Financial fields — decrypt commission amounts
  if (copy.commission) {
    for (const key of ['sale_amount', 'agent_amount', 'inmobiliaria_amount', 'agent_net']) {
      if (copy.commission[key] && typeof copy.commission[key] === 'string') {
        const dec = decrypt(copy.commission[key]);
        copy.commission[key] = dec ? (isNaN(Number(dec)) ? dec : Number(dec)) : copy.commission[key];
      }
    }
  }
  // Payment plan amounts
  if (copy.payment_plan?.total_amount && typeof copy.payment_plan.total_amount === 'string') {
    const dec = decrypt(copy.payment_plan.total_amount);
    copy.payment_plan.total_amount = dec ? (isNaN(Number(dec)) ? dec : Number(dec)) : copy.payment_plan.total_amount;
  }
  if (copy.payment_plan?.installments) {
    for (const inst of copy.payment_plan.installments) {
      if (inst.amount && typeof inst.amount === 'string') {
        const dec = decrypt(inst.amount);
        inst.amount = dec ? (isNaN(Number(dec)) ? dec : Number(dec)) : inst.amount;
      }
    }
  }
  return copy;
}

// Save the application with financial fields encrypted at rest. Use
// this anywhere commission or payment_plan amounts were just assigned
// numerically — the cache + DB row store ciphertext while the local
// `app` reference keeps plaintext numbers so post-save code (event
// payloads, email builders, push notifications) can format amounts
// without re-decrypting. decryptAppPII on every read path normalizes
// the rest of the system.
function saveApplicationEncryptingFinancials(app) {
  const clone = JSON.parse(JSON.stringify(app));
  encryptFinancials(clone);
  store.saveApplication(clone);
}

// Helper: encrypt financial fields before saving
function encryptFinancials(app) {
  // Commission amounts
  if (app.commission) {
    for (const key of ['sale_amount', 'agent_amount', 'inmobiliaria_amount', 'agent_net']) {
      if (app.commission[key] != null && typeof app.commission[key] === 'number') {
        app.commission[key] = encrypt(String(app.commission[key]));
      }
    }
  }
  // Payment plan amounts
  if (app.payment_plan?.total_amount != null && typeof app.payment_plan.total_amount === 'number') {
    app.payment_plan.total_amount = encrypt(String(app.payment_plan.total_amount));
  }
  if (app.payment_plan?.installments) {
    for (const inst of app.payment_plan.installments) {
      if (inst.amount != null && typeof inst.amount === 'number') {
        inst.amount = encrypt(String(inst.amount));
      }
    }
  }
}

// ── GET /:id/events — SSE stream of application state changes ────
// Long-lived Server-Sent Events stream that pushes a fresh state
// envelope every time the application is saved. Clients subscribe
// once and get near-zero-latency updates instead of polling.
//
// The client authenticates via the `?token=` fallback (same as the
// document/receipt file endpoints) because SFSafariViewController
// and EventSource can't set a custom Authorization header on GET.
//
// Headers:
//   Content-Type: text/event-stream
//   Cache-Control: no-cache
//   X-Accel-Buffering: no  (disables Nginx proxy buffering)
//   Connection: keep-alive
//
// Wire format:
//   event: state
//   data: {"id":"…","status":"…","version":"…"}
//
//   event: ping
//   data: {}
router.get('/:id/events', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !isClient && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  // Flush headers immediately so clients that buffer until first byte
  // (some SSE polyfills) start consuming.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Build an envelope that matches the /state endpoint response so
  // iOS can decode both with the same Decodable.
  const buildEnvelope = (a) => {
    const lastEvent = (a.timeline_events || []).slice(-1)[0];
    const lastEventAt = lastEvent?.created_at || a.updated_at || a.created_at || '';
    const docCount    = (a.documents_uploaded || []).length;
    const docPending  = (a.documents_uploaded || []).filter(d => !d.review_status || d.review_status === 'pending').length;
    const payStatus   = a.payment?.verification_status || 'none';
    const installmentCount = a.payment_plan?.installments?.length || 0;
    const installmentPending = (a.payment_plan?.installments || []).filter(i => i.status === 'proof_uploaded').length;
    return {
      id:                 a.id,
      status:             a.status,
      last_event_at:      lastEventAt,
      last_event_type:    lastEvent?.type || null,
      updated_at:         a.updated_at || null,
      doc_count:          docCount,
      doc_pending_review: docPending,
      payment_status:     payStatus,
      installment_count:  installmentCount,
      installment_pending_review: installmentPending,
      version: `${a.status}|${lastEventAt}|${docCount}|${docPending}|${payStatus}|${installmentPending}`,
    };
  };

  const send = (event, payload) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      // Client disconnected mid-write — let the close handler clean up
    }
  };

  // 1) Initial state so the client immediately has a baseline
  send('state', buildEnvelope(app));

  // 2) Subscribe to in-process change notifications
  const unsubscribe = appEvents.subscribe(req.params.id, () => {
    const fresh = store.getApplicationById(req.params.id);
    if (fresh) send('state', buildEnvelope(fresh));
  });

  // 3) Heartbeat every 20s — Nginx's /api/ proxy_read_timeout is 30s,
  //    so we need to emit at least one byte more often than that. 20s
  //    leaves a safety margin for network jitter. Clients also use
  //    these pings to detect a dead connection.
  const heartbeat = setInterval(() => {
    send('ping', { t: Date.now() });
  }, 20_000);

  // 4) Cleanup on disconnect
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch {}
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

// ── GET /:id/state  — Lightweight state poll ─────────────────────
// Returns just enough to reconcile a cached detail without re-fetching
// the whole application. Intended for periodic polling from iOS/web
// while a detail view is open. Response body is ~200 bytes.
//
// The `version` is a monotonically increasing counter the client can
// use to decide "do I need to re-fetch?" — it bumps on any status
// change, new timeline event, or document/payment update.
router.get('/:id/state', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !isClient && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Compute a cheap version key from the fields that matter. Any
  // change to the status, last timeline event, uploaded doc count,
  // or payment state bumps the hash, so the client can compare and
  // decide whether to re-fetch the full detail.
  const lastEvent = (app.timeline_events || []).slice(-1)[0];
  const lastEventAt = lastEvent?.created_at || app.updated_at || app.created_at || '';
  const docCount    = (app.documents_uploaded || []).length;
  const docPending  = (app.documents_uploaded || []).filter(d => !d.review_status || d.review_status === 'pending').length;
  const payStatus   = app.payment?.verification_status || 'none';
  const installmentCount = app.payment_plan?.installments?.length || 0;
  const installmentPending = (app.payment_plan?.installments || []).filter(i => i.status === 'proof_uploaded').length;

  res.json({
    id:                 app.id,
    status:             app.status,
    last_event_at:      lastEventAt,
    last_event_type:    lastEvent?.type || null,
    updated_at:         app.updated_at || null,
    doc_count:          docCount,
    doc_pending_review: docPending,
    payment_status:     payStatus,
    installment_count:  installmentCount,
    installment_pending_review: installmentPending,
    // Monotonic-ish key — iOS compares as a string.
    version: `${app.status}|${lastEventAt}|${docCount}|${docPending}|${payStatus}|${installmentPending}`,
  });
});

// ══════════════════════════════════════════════════════════════════
// ── PUT /:id/status  — Change status ─────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.put('/:id/status', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Subscription re-check: status transitions are pro-only writes.
  // The middleware on /api/applications already gates list reads, but
  // a broker whose plan lapsed mid-deal could still drive an
  // application to 'completado' and trigger commission/notification
  // side-effects. Block them here. Admins are exempt; secretaries
  // inherit from their inmobiliaria via the same gate elsewhere.
  if (!admin && (isBroker || isInmobiliaria)) {
    if (!isSubscriptionActive(user)) {
      return res.status(402).json({
        error: 'Tu suscripción no está activa. Renueva tu plan para continuar.',
        needsSubscription: true,
      });
    }
  }

  const { status, reason } = req.body;
  if (!status) return res.status(400).json({ error: 'status es requerido' });

  // ── Idempotency: no-op if already in the requested state ─────
  // This used to throw "Transición no válida: X → X" whenever the
  // broker's UI was one tick behind the server (e.g. the client had
  // just uploaded a receipt, auto-advancing to pago_enviado). Now
  // we just return the current application so the client reconciles.
  if (app.status === status) {
    return res.json(decryptAppPII(app));
  }

  // ── Ownership gate: broker can only set broker-owned statuses.
  // Client-automated (pago_enviado, documentos_enviados) and review-
  // automated (pago_aprobado, documentos_insuficientes) statuses are
  // set via their own domain endpoints — never via the generic
  // status-change API. Blocking them here means the broker cannot
  // accidentally race the client's automation.
  if (!isBrokerSettable(status)) {
    const ownership = STATUS_OWNERSHIP[status] || 'unknown';
    const explain = {
      client_auto: 'Este estado se establece automáticamente cuando el cliente sube el comprobante o los documentos.',
      review_auto: 'Este estado se establece como resultado de una revisión (aprobar pago o revisar documentos).',
      unknown:     'Este estado no es válido.',
    }[ownership];
    return res.status(400).json({
      error: explain,
      code: 'status_not_broker_settable',
      status,
      ownership,
    });
  }

  const allowed = STATUS_FLOW[app.status];
  if (!allowed || !allowed.includes(status))
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

  // ── Cancel pending tasks + void commission on terminal statuses ──
  if (status === 'rechazado' || status === 'completado') {
    // Cancel all active tasks for this application
    const allEvents = ['documents_requested', 'documents_rejected', 'document_uploaded',
                       'payment_plan_created', 'payment_uploaded', 'payment_rejected', 'receipt_ready'];
    for (const evt of allEvents) autoCompleteTasksByEvent(app.id, evt);

    // Void approved commission if application is rejected (sale didn't happen)
    if (status === 'rechazado' && app.commission?.status === 'approved') {
      app.commission.status = 'voided';
      app.commission.voided_at = new Date().toISOString();
      addEvent(app, 'commission_voided',
        'Comisión anulada por rechazo de la aplicación',
        'system', 'Sistema', { reason: 'application_rejected' });
      store.saveApplication(app);
    }
  }

  // ── Auto-update unit inventory on status change ────────────────
  if (app.assigned_unit?.unitId && app.listing_id) {
    try {
      const listing = store.getListingById(app.listing_id);
      if (listing && Array.isArray(listing.unit_inventory)) {
        const unit = listing.unit_inventory.find(u => u.id === app.assigned_unit.unitId);
        if (unit) {
          if (status === 'completado') {
            unit.status = 'sold';
          } else if (status === 'rechazado') {
            unit.status = 'available';
            unit.applicationId = null;
            unit.clientName = null;
            // Clear assigned unit from application
            app.assigned_unit = null;
            store.saveApplication(app);
          } else if (['reservado', 'aprobado'].includes(status)) {
            unit.status = 'reserved';
            unit.applicationId = app.id;
            unit.clientName = app.client_name || app.client?.name || '';
          }
          listing.units_available = listing.unit_inventory.filter(u => u.status === 'available').length;
          store.saveListing(listing);
        }
      }
    } catch (e) { console.error('[inventory] Auto-update error:', e.message); }
  }

  // Notify client via email
  if (app.client.email) {
    const email = statusEmail(app, oldStatus, status, reason);
    sendNotification(app.client.email, email.subject, email.html);
  }

  // Push notification → client
  if (app.client.user_id) {
    pushNotify(app.client.user_id, {
      type: 'status_changed',
      title: 'Estado Actualizado',
      body: `Tu aplicación para ${app.listing_title} cambió a: ${STATUS_LABELS[status] || status}`,
      url: `/my-applications?id=${app.id}`,
    });
  }

  res.json(decryptAppPII(app));
});

// ══════════════════════════════════════════════════════════════════
// ── DOCUMENTS ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/documents/request  — Broker requests documents ────
router.post('/:id/documents/request', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (app.broker.user_id !== req.user.sub && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  // Block document requests on terminal statuses
  if (['rechazado', 'completado'].includes(app.status))
    return res.status(400).json({ error: 'No se pueden solicitar documentos en una aplicación finalizada.' });

  let { documents } = req.body; // [{ type, label, required }]
  if (!Array.isArray(documents) || !documents.length)
    return res.status(400).json({ error: 'Lista de documentos requerida' });
  if (documents.length > 20)
    return res.status(400).json({ error: 'Demasiados documentos (máximo 20)' });

  documents = documents
    .filter(d => d && typeof d === 'object' && typeof d.type === 'string' && typeof d.label === 'string')
    .map(d => ({
      type:     d.type.slice(0, 50),
      label:    d.label.slice(0, 100),
      required: d.required !== false,
    }));
  if (!documents.length)
    return res.status(400).json({ error: 'Lista de documentos inválida' });

  // Filter out document types that already have a pending request
  const pendingTypes = new Set(
    app.documents_requested.filter(d => d.status === 'pending').map(d => d.type)
  );
  const deduped = documents.filter(d => !pendingTypes.has(d.type || 'other'));
  if (!deduped.length)
    return res.status(400).json({ error: 'Todos los documentos solicitados ya están pendientes.' });

  const newDocs = deduped.map(d => ({
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

  // Auto-task: notify client to upload requested documents
  if (app.client?.user_id) {
    const task = createAutoTask({
      title: `Sube los documentos solicitados para ${app.listing_title || 'la propiedad'}`,
      description: newDocs.map(d => d.label).join(', '),
      assigned_to: app.client.user_id,
      assigned_by: req.user.sub,
      application_id: app.id,
      listing_id: app.listing_id,
      source_event: 'documents_requested',
    });

    // If dedup blocked task creation, update the existing task's
    // description so it reflects ALL pending documents — not just the
    // first batch that was requested.
    if (!task) {
      const existing = store.getTasksByApplication(app.id);
      const pendingTask = existing.find(t => t.source_event === 'documents_requested' && t.status !== 'completada' && t.status !== 'no_aplica');
      if (pendingTask) {
        const allPendingLabels = app.documents_requested
          .filter(d => d.status === 'pending')
          .map(d => d.label);
        pendingTask.description = allPendingLabels.join(', ');
        pendingTask.updated_at = new Date().toISOString();
        store.saveTask(pendingTask);
      }
    }
  }

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

  res.json(decryptAppPII(app));
});

// ── POST /:id/documents/skip  — Broker bypasses the document gate ─
// Used when the broker already has the documents offline (received via
// WhatsApp, in person, etc.) and doesn't need the client to upload
// anything. Marks every pending document request as `skipped`,
// auto-completes any pending tasks, advances the status out of the
// document-collection cycle, and writes a full audit-trail entry with
// the agent's mandatory note. The skip is recorded per-doc so the
// origin of each completion is auditable later.
router.post('/:id/documents/skip', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker       = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary    = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin          = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Subscription re-check: same gate the status-change endpoint uses.
  if (!admin && (isBroker || isInmobiliaria) && !isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'Tu suscripción no está activa. Renueva tu plan para continuar.',
      needsSubscription: true,
    });
  }

  // Block on terminal statuses — symmetric with the request endpoint.
  if (['rechazado', 'completado'].includes(app.status))
    return res.status(400).json({ error: 'No se puede saltar documentos en una aplicación finalizada.' });

  const note = (req.body?.note || '').toString().trim();
  if (note.length < 5)
    return res.status(400).json({
      error: 'Se requiere un comentario explicando por qué se omiten los documentos (mínimo 5 caracteres).',
      code: 'note_required',
    });

  const requested = Array.isArray(app.documents_requested) ? app.documents_requested : [];
  const pendingDocs = requested.filter(d => d.status === 'pending');

  // Mark every pending request as skipped with the agent's reason.
  // Approved / uploaded docs are left alone — those reflect real client
  // submissions that should remain in the trail.
  const now = new Date().toISOString();
  for (const d of pendingDocs) {
    d.status        = 'skipped';
    d.skipped_at    = now;
    d.skipped_by    = req.user.sub;
    d.skip_reason   = note.slice(0, 500);
  }

  // Audit event — keeps the full reason in the timeline alongside the
  // labels of each doc that was skipped, so reviewers can see what the
  // agent considered already covered.
  addEvent(app, 'documents_skipped',
    `Documentos omitidos por el agente — ${note.slice(0, 200)}`,
    req.user.sub, user?.name || 'Agente',
    {
      reason:        note,
      skipped_count: pendingDocs.length,
      skipped_docs:  pendingDocs.map(d => ({ id: d.id, type: d.type, label: d.label })),
      skipped_by:    req.user.sub,
      skipped_role:  user?.role || null,
    }
  );

  // Status advance: if the app is sitting in any of the doc-cycle
  // statuses, move it to en_aprobacion so the broker can keep working.
  // Don't force a status change if the app is already past the gate
  // (e.g. someone clicked skip from en_aprobacion already).
  const docCycleStatuses = new Set([
    'documentos_requeridos',
    'documentos_enviados',
    'documentos_insuficientes',
  ]);
  if (docCycleStatuses.has(app.status)) {
    const from = app.status;
    app.status = 'en_aprobacion';
    addEvent(app, 'status_change',
      `Estado avanzado a ${STATUS_LABELS['en_aprobacion']} (documentos omitidos)`,
      req.user.sub, user?.name || 'Agente',
      { from, to: 'en_aprobacion', via: 'documents_skipped' });
  }

  store.saveApplication(app);

  // Close out any client-side tasks tied to the document gate so the
  // client doesn't keep seeing "upload your documents" after the agent
  // explicitly waived it.
  autoCompleteTasksByEvent(app.id, 'documents_requested');
  autoCompleteTasksByEvent(app.id, 'documents_rejected');

  // Notify the client (push + email) so they understand they no longer
  // need to upload anything.
  if (app.client?.user_id) {
    pushNotify(app.client.user_id, {
      type:  'document_reviewed',
      title: 'No es necesario subir documentos',
      body:  `${user?.name || 'Tu agente'} confirmó que ya tiene los documentos para ${app.listing_title || 'tu aplicación'}.`,
      url:   `/my-applications?id=${app.id}`,
    });
  }
  if (app.client?.email) {
    sendNotification(app.client.email,
      `HogaresRD — No es necesario subir documentos para ${app.listing_title || 'tu aplicación'}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
         <p>Hola <strong>${app.client.name || ''}</strong>,</p>
         <p>${user?.name || 'Tu agente'} indicó que ya cuenta con la documentación necesaria, así que no necesitas subir nada por ahora.</p>
         <p style="background:#F1F5F9;border-radius:8px;padding:12px;border-left:3px solid #2563eb;font-size:0.9rem;">
           <strong>Comentario del agente:</strong> ${note.replace(/[<>]/g, '')}
         </p>
         <a href="${BASE_URL}/my-applications" style="display:inline-block;background:#2563eb;color:#fff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver mi aplicación</a>
       </div>`
    );
  }

  res.json({
    ok: true,
    skipped_count: pendingDocs.length,
    application: decryptAppPII(app),
  });
});

// ── POST /:id/initial-upload  — Public: attach documents right after creation
// Accepts multipart uploads from anonymous/guest users during initial apply.
// Only usable within 10 minutes of creation and limited to 10 files total per app.
router.post('/:id/initial-upload', appCreateLimiter, docUpload.array('files', 10), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  // Time-box the public upload window to 10 minutes after creation
  const ageMs = Date.now() - new Date(app.created_at).getTime();
  if (ageMs > 10 * 60 * 1000) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(403).json({ error: 'Ventana de subida inicial expirada. Inicia sesión en tu cuenta para subir documentos.' });
  }

  // Hard cap: no more than 10 uploads via this public endpoint
  if ((app.documents_uploaded || []).filter(d => d.via_initial).length >= 10) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(429).json({ error: 'Límite de subida inicial alcanzado.' });
  }

  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No se recibieron archivos' });

  // Validate MIME types on every file
  for (const f of req.files) {
    const ok = await validateMime(f.path);
    if (!ok) {
      req.files.forEach(x => { if (x.path !== f.path) fs.unlink(x.path, () => {}); });
      return res.status(400).json({ error: `Tipo de archivo no permitido: ${f.originalname}. Formatos aceptados: JPG, PNG, HEIC, PDF, DOC(X), XLS(X), TXT, CSV.` });
    }
  }

  const docType   = (req.body.type  || 'other').toString().slice(0, 50);
  const docLabel  = (req.body.label || DOCUMENT_TYPES[docType] || 'Documento').toString().slice(0, 120);

  const uploaded = req.files.map(f => ({
    id:            uuid(),
    request_id:    null,
    type:          docType,
    label:         docLabel,
    filename:      f.filename,
    path:          f.path,
    original_name: f.originalname,
    size:          f.size,
    uploaded_at:   new Date().toISOString(),
    via_initial:   true,
    review_status: 'pending',
    review_note:   '',
    reviewed_at:   null,
    reviewed_by:   null,
  }));

  app.documents_uploaded.push(...uploaded);
  addEvent(app, 'document_uploaded',
    `${uploaded.length} documento(s) adjunto(s) durante la aplicación: ${uploaded.map(d => d.original_name).join(', ')}`,
    'system', app.client?.name || 'Cliente', { files: uploaded.map(d => d.original_name), initial: true });
  store.saveApplication(app);

  res.json({ ok: true, uploaded: uploaded.length });
});

// ── POST /:id/documents/upload  — Client uploads documents ──────
router.post('/:id/documents/upload', userAuth, docUpload.array('files', 10), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
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
      return res.status(400).json({ error: `Tipo de archivo no permitido: ${f.originalname}. Formatos aceptados: JPG, PNG, HEIC, PDF, DOC(X), XLS(X), TXT, CSV.` });
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
  } else if (docType && docType !== 'other') {
    // No explicit request_id — try to match by document type
    const docReq = app.documents_requested.find(d => d.type === docType && d.status === 'pending');
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

  // Auto-task: complete client's "upload docs" task only when ALL required
  // documents are fulfilled — otherwise the client loses their reminder for
  // remaining docs.
  if (allFulfilled) {
    autoCompleteTasksByEvent(app.id, 'documents_requested');
    autoCompleteTasksByEvent(app.id, 'documents_rejected');
  }
  if (app.broker?.user_id) {
    createAutoTask({
      title: `Revisa documentos de ${app.client?.name || 'cliente'} para ${app.listing_title || 'la propiedad'}`,
      description: `${req.files?.length || 1} documento(s) subido(s)`,
      assigned_to: app.broker.user_id,
      assigned_by: 'system',
      application_id: app.id,
      listing_id: app.listing_id,
      source_event: 'document_uploaded',
    });
  }

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

  const user = store.getUserById(req.user.sub);
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (app.broker.user_id !== req.user.sub && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const doc = app.documents_uploaded.find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

  const { status, note } = req.body; // 'approved' or 'rejected'
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status debe ser approved o rejected' });
  doc.review_status = status;
  doc.review_note   = (typeof note === 'string' ? note : '').slice(0, 1000);
  doc.reviewed_at   = new Date().toISOString();
  doc.reviewed_by   = req.user.sub;

  // Sync the corresponding documents_requested entry so the client
  // can re-upload against it (the upload handler matches by status === 'pending').
  if (status === 'rejected') {
    const reqEntry = doc.request_id
      ? app.documents_requested.find(d => d.id === doc.request_id)
      : app.documents_requested.find(d => d.type === doc.type && d.status === 'uploaded');
    if (reqEntry) reqEntry.status = 'pending';
  }

  addEvent(app, 'document_reviewed',
    `Documento "${doc.original_name}" ${status === 'approved' ? 'aprobado' : 'rechazado'}${note ? ': ' + note : ''}`,
    req.user.sub, user?.name || 'Broker',
    { doc_id: doc.id, status, note });

  // If any REQUIRED doc rejected → documentos_insuficientes.
  // Optional docs failing review are noted in the timeline but don't
  // demote the application's status — the buyer hasn't blocked progress.
  const hasRejectedRequired = app.documents_uploaded.some(d =>
    d.review_status === 'rejected' && d.required === true
  );
  if (hasRejectedRequired && STATUS_FLOW[app.status]?.includes('documentos_insuficientes')) {
    const old = app.status;
    app.status = 'documentos_insuficientes';
    addEvent(app, 'status_change', 'Documentos insuficientes — se requieren correcciones',
      req.user.sub, user?.name || 'Broker', { from: old, to: 'documentos_insuficientes' });
  }

  store.saveApplication(app);

  // Auto-task: tell client to re-upload
  autoCompleteTasksByEvent(app.id, 'document_uploaded');
  if (status === 'rejected' && app.client?.user_id) {
    const rejectedDocs = app.documents_uploaded
      .filter(d => d.review_status === 'rejected')
      .map(d => d.original_name);
    const rejDesc = rejectedDocs.length
      ? `Documentos rechazados: ${rejectedDocs.join(', ')}${note ? '. Nota: ' + note : ''}`
      : (note ? `Nota: ${note}` : 'Revisa los documentos rechazados y sube nuevas versiones.');

    const task = createAutoTask({
      title: `Documentos insuficientes — revisa y vuelve a subir para ${app.listing_title || 'la propiedad'}`,
      description: rejDesc,
      assigned_to: app.client.user_id,
      assigned_by: req.user.sub,
      application_id: app.id,
      listing_id: app.listing_id,
      source_event: 'documents_rejected',
    });

    // If dedup blocked task creation, update the existing task's
    // description with the latest rejection details.
    if (!task) {
      const existing = store.getTasksByApplication(app.id);
      const pendingTask = existing.find(t => t.source_event === 'documents_rejected' && t.status !== 'completada' && t.status !== 'no_aplica');
      if (pendingTask) {
        pendingTask.description = rejDesc;
        pendingTask.updated_at = new Date().toISOString();
        store.saveTask(pendingTask);
      }
    }
  }

  // Push notification → client (document reviewed)
  if (app.client.user_id) {
    const docLabel = status === 'approved' ? 'aprobado ✓' : 'rechazado';
    pushNotify(app.client.user_id, {
      type: 'document_reviewed',
      title: `Documento ${docLabel}`,
      body: `"${doc.original_name}" fue ${docLabel} en tu aplicación para ${app.listing_title}`,
      url: `/my-applications?id=${app.id}`,
    });
  }

  // Email notification → client (document reviewed)
  if (app.client.email) {
    const reviewBody = status === 'rejected'
      ? et.p(`Tu documento <strong>"${et.esc(doc.original_name)}"</strong> fue rechazado para la aplicación de <strong>${et.esc(app.listing_title)}</strong>.`)
        + (note ? et.alertBox('<strong>Motivo:</strong> ' + et.esc(note), 'danger') : '')
        + et.p('Por favor sube una nueva versión corregida desde tu panel.')
        + et.button('Subir documentos', `${BASE_URL}/my-applications?id=${app.id}`)
      : et.p(`Tu documento <strong>"${et.esc(doc.original_name)}"</strong> fue aprobado para la aplicación de <strong>${et.esc(app.listing_title)}</strong>.`)
        + et.button('Ver mi aplicación', `${BASE_URL}/my-applications?id=${app.id}`);
    sendNotification(app.client.email,
      `Documento ${status === 'approved' ? 'aprobado' : 'rechazado'} — ${app.listing_title}`,
      et.layout({ title: `Documento ${status === 'approved' ? 'aprobado' : 'rechazado'}`, subtitle: et.esc(app.listing_title), body: reviewBody })
    );
  }

  res.json(decryptAppPII(app));
});

// ── GET /:id/documents/:docId/file  — Serve uploaded document ───
router.get('/:id/documents/:docId/file', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isBroker && !isClient && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const doc = app.documents_uploaded.find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

  if (!fs.existsSync(doc.path)) return res.status(404).json({ error: 'Archivo no encontrado' });

  const safePath = guardDocPath(doc.path);
  if (!safePath) return res.status(400).json({ error: 'Ruta de archivo inválida' });
  // Force download, don't render in browser (prevents XSS via uploaded HTML/SVG)
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(doc.original_name || 'document')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

  // Validate date format and ensure it's not in the past
  const tourDate = new Date(`${scheduled_date}T${scheduled_time}`);
  if (isNaN(tourDate.getTime()))
    return res.status(400).json({ error: 'Formato de fecha u hora inválido' });
  if (tourDate < new Date())
    return res.status(400).json({ error: 'No se puede programar una visita en el pasado' });

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

  res.json(decryptAppPII(app));
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
  res.json(decryptAppPII(app));
});

// ══════════════════════════════════════════════════════════════════
// ── PAYMENT ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/payment/upload  — Upload payment receipt ──────────
// Client, broker, inmobiliaria, constructora, or secretary can upload.
// When the agent uploads on behalf of the client, the client's upload
// task is auto-completed and no self-verify task is created.
router.post('/:id/payment/upload', userAuth, docUpload.single('receipt'), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  // If a payment plan exists, use the installment upload instead
  if (app.payment_plan && app.payment_plan.installments?.length > 0) {
    return res.status(400).json({ error: 'Esta aplicación tiene un plan de pagos. Suba el comprobante en la cuota correspondiente.' });
  }

  const user = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isClient && !isBroker && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  if (!req.file) return res.status(400).json({ error: 'Recibo es requerido' });

  // Block upload if a receipt is already pending verification
  if (app.payment?.verification_status === 'pending')
    return res.status(400).json({ error: 'Ya tienes un recibo pendiente de revisión. Espera la verificación antes de subir otro.' });

  // Block re-upload after payment was already approved
  if (app.payment?.verification_status === 'approved')
    return res.status(400).json({ error: 'El pago ya fue aprobado.' });

  // Validate MIME type via magic bytes
  if (!(await validateMime(req.file.path)))
    return res.status(400).json({ error: 'Tipo de archivo no permitido. Formatos aceptados: JPG, PNG, HEIC, PDF, DOC(X), XLS(X), TXT, CSV.' });

  if (!app.payment) app.payment = {};
  app.payment.receipt_path = req.file.path;
  app.payment.receipt_filename = req.file.filename;
  app.payment.receipt_original = req.file.originalname;
  app.payment.receipt_uploaded_at = new Date().toISOString();
  const paymentAmount = Number(req.body.amount) || Number(app.listing_price) || 0;
  if (paymentAmount <= 0) return res.status(400).json({ error: 'Monto de pago inválido' });
  app.payment.amount = paymentAmount;
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
    req.user.sub, user?.name || app.client.name,
    { filename: req.file.originalname, uploaded_by_role: isClient ? 'client' : 'agent' });

  store.saveApplication(app);

  // Auto-task: broker must verify payment (only when client uploaded)
  if (app.broker?.user_id && isClient) {
    createAutoTask({
      title: `Verifica el pago de ${app.client?.name || 'cliente'} para ${app.listing_title || 'la propiedad'}`,
      description: `Recibo: ${req.file?.originalname || 'archivo subido'}`,
      assigned_to: app.broker.user_id,
      assigned_by: 'system',
      application_id: app.id,
      listing_id: app.listing_id,
      source_event: 'payment_uploaded',
    });
  }

  // When agent uploads on behalf of client, complete the client's upload task
  if (!isClient) {
    autoCompleteTasksByEvent(app.id, 'payment_plan_created');
  }

  // Notify broker (only if someone else uploaded)
  if (!isBroker && app.broker.email) {
    sendNotification(app.broker.email,
      `Recibo de pago recibido — ${app.client.name}`,
      `<p>${user?.name || app.client.name} ha subido un recibo de pago para ${app.listing_title}.</p>
       <a href="${BASE_URL}/broker">Verificar en Dashboard</a>`
    );
  }

  // Confirmation email → client
  if (isClient && app.client.email) {
    sendNotification(app.client.email,
      `Recibo de pago recibido — ${app.listing_title}`,
      et.layout({
        title: 'Recibo de pago recibido',
        subtitle: et.esc(app.listing_title),
        body: et.p('Tu recibo de pago ha sido recibido y está pendiente de verificación por tu agente.')
          + et.p('Te notificaremos cuando sea revisado.')
          + et.button('Ver mi aplicación', `${BASE_URL}/my-applications?id=${app.id}`),
      })
    );
  }

  res.json({ ok: true });
});

// ── PUT /:id/payment/verify  — Broker verifies payment ──────────
router.put('/:id/payment/verify', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (app.broker.user_id !== req.user.sub && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { approved, notes } = req.body;

  app.payment.verification_status = approved ? 'approved' : 'rejected';
  app.payment.verified_at = new Date().toISOString();
  app.payment.verified_by = req.user.sub;
  if (notes) app.payment.notes = notes;

  if (approved && STATUS_FLOW[app.status]?.includes('pago_aprobado')) {
    const old = app.status;
    app.status = 'pago_aprobado';
    addEvent(app, 'status_change', 'Pago verificado y aprobado',
      req.user.sub, user?.name || 'Broker', { from: old, to: 'pago_aprobado' });
  } else if (!approved) {
    // Payment rejected — always revert to pendiente_pago so client can re-upload
    const old = app.status;
    app.status = 'pendiente_pago';
    addEvent(app, 'status_change', `Pago rechazado${notes ? ': ' + notes : ''}`,
      req.user.sub, user?.name || 'Broker', { from: old, to: 'pendiente_pago' });
  }

  addEvent(app, 'payment_reviewed',
    `Pago ${approved ? 'aprobado' : 'rechazado'}${notes ? ': ' + notes : ''}`,
    req.user.sub, user?.name || 'Broker', { approved, notes });

  store.saveApplication(app);

  // Auto-complete the "verify payment" task
  autoCompleteTasksByEvent(app.id, 'payment_uploaded');

  // Notify client
  if (app.client.email) {
    const email = statusEmail(app, null, app.status, notes);
    sendNotification(app.client.email, email.subject, email.html);
  }

  // Push notification → client (payment reviewed)
  if (app.client.user_id) {
    pushNotify(app.client.user_id, {
      type: 'payment_approved',
      title: approved ? 'Pago Aprobado ✓' : 'Pago Rechazado',
      body: approved
        ? `Tu pago para ${app.listing_title} ha sido aprobado`
        : `Tu pago para ${app.listing_title} fue rechazado${notes ? ': ' + notes : ''}`,
      url: `/my-applications?id=${app.id}`,
    });
  }

  res.json(decryptAppPII(app));
});

// ── GET /:id/payment/receipt  — Serve payment receipt ────────────
router.get('/:id/payment/receipt', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isBroker && !isClient && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  if (!app.payment.receipt_path || !fs.existsSync(app.payment.receipt_path))
    return res.status(404).json({ error: 'Recibo no encontrado' });

  const safeReceipt = guardDocPath(app.payment.receipt_path);
  if (!safeReceipt) return res.status(400).json({ error: 'Ruta de archivo inválida' });
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(app.payment.receipt_original || 'receipt')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(safeReceipt);
});

// ── POST /:id/payment/processed-receipt — Agent uploads processed receipt ──
// After verifying payment, the broker/inmobiliaria uploads the official
// processed receipt so the client can download it.
router.post('/:id/payment/processed-receipt', userAuth, docUpload.single('receipt'), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicacion no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isBroker && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'Solo agentes pueden subir recibo procesado' });

  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
  if (!(await validateMime(req.file.path)))
    return res.status(400).json({ error: 'Tipo de archivo no permitido.' });

  if (!app.payment) app.payment = {};
  app.payment.processed_receipt_path = req.file.path;
  app.payment.processed_receipt_filename = req.file.filename;
  app.payment.processed_receipt_original = req.file.originalname;
  app.payment.processed_receipt_uploaded_at = new Date().toISOString();

  addEvent(app, 'processed_receipt_uploaded', `Recibo procesado subido: ${req.file.originalname}`,
    req.user.sub, user?.name || 'Agente', { filename: req.file.originalname });

  store.saveApplication(app);

  // Auto-complete the broker's "verify payment" task
  autoCompleteTasksByEvent(app.id, 'payment_uploaded');

  // Notify client their processed receipt is ready (push only — no open task,
  // since this is informational and the receipt is already available to download)
  if (app.client?.user_id) {
    pushNotify(app.client.user_id, {
      type: 'document_reviewed',
      title: 'Recibo Procesado Disponible',
      body: `Tu recibo de pago procesado para ${app.listing_title || 'tu propiedad'} esta listo para descargar.`,
      url: `/my-applications?id=${app.id}`,
    });
  }

  res.json({ ok: true });
});

// ── GET /:id/payment/processed-receipt — Serve processed receipt ──
router.get('/:id/payment/processed-receipt', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicacion no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isBroker && !isClient && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  if (!app.payment?.processed_receipt_path || !fs.existsSync(app.payment.processed_receipt_path))
    return res.status(404).json({ error: 'Recibo procesado no encontrado' });

  const safePath = guardDocPath(app.payment.processed_receipt_path);
  if (!safePath) return res.status(400).json({ error: 'Ruta de archivo invalida' });
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(app.payment.processed_receipt_original || 'processed_receipt')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(safePath);
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
                   (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isBroker && !isClient && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje es requerido' });

  const senderRole = isBroker ? 'broker' : 'client';
  addEvent(app, 'message', message,
    req.user.sub, user?.name || (isBroker ? 'Broker' : app.client.name),
    { role: senderRole });

  store.saveApplication(app);

  // ── Sync to Conversations system so messages appear in iOS Messages tab ──
  // Find or create a conversation for this (client, property) pair.
  const clientId = app.client?.user_id || null;
  const brokerId = app.broker?.user_id || null;
  if (clientId && brokerId && clientId !== brokerId) {
    let conv = store.getConversations().find(
      c => c.clientId === clientId && c.propertyId === app.listing_id
    );
    const msgObj = {
      id:         'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      senderId:   req.user.sub,
      senderRole,
      senderName: user?.name || (isBroker ? 'Broker' : app.client.name),
      text:       message,
      timestamp:  new Date().toISOString(),
    };
    if (conv) {
      store.addMessage(conv.id, msgObj);
      conv.lastMessage = message;
      conv.updatedAt   = new Date().toISOString();
      if (isBroker) conv.unreadClient = (conv.unreadClient || 0) + 1;
      else          conv.unreadBroker = (conv.unreadBroker || 0) + 1;
      store.saveConversation(conv);
    } else {
      conv = {
        id:             'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        propertyId:     app.listing_id || '',
        propertyTitle:  app.listing_title || 'Propiedad',
        propertyImage:  null,
        clientId,
        clientName:     app.client?.name || 'Cliente',
        brokerId,
        brokerName:     app.broker?.name || 'Agente',
        inmobiliariaId: app.inmobiliaria_id || null,
        createdAt:      new Date().toISOString(),
        updatedAt:      new Date().toISOString(),
        lastMessage:    message,
        unreadBroker:   isBroker ? 0 : 1,
        unreadClient:   isBroker ? 1 : 0,
        message_count:  1,
      };
      store.saveConversation(conv);
      store.addMessage(conv.id, msgObj);
    }
    // Push notification to the other party
    const pushTarget = isBroker ? clientId : brokerId;
    pushNotify(pushTarget, {
      type:  'new_message',
      title: `💬 ${user?.name || 'Usuario'}`,
      body:  message.slice(0, 120),
      url:   `/mensajes?conv=${conv.id}`,
    });
  }

  // Email notification to the other party
  const notifyEmail = isBroker ? app.client.email : app.broker.email;
  if (notifyEmail) {
    sendNotification(notifyEmail,
      `HogaresRD — Nuevo mensaje sobre ${app.listing_title}`,
      `<p><strong>${user?.name || 'Usuario'}</strong> te ha enviado un mensaje:</p>
       <blockquote style="border-left:3px solid #0038A8;padding:0.5rem 1rem;color:#333;">${message}</blockquote>
       <a href="${BASE_URL}/${isBroker ? 'my-applications' : 'broker'}">Ver conversación</a>`
    );
  }

  res.json(decryptAppPII(app));
});

// ── POST /:id/contact-client — Broker starts or continues an in-app
//      conversation with the applicant ───────────────────────────
//
// Before this existed, a broker could only contact the client via email
// (see the /:id/message endpoint above). This creates or reuses a proper
// Conversation row in the messaging system so the client sees a red
// unread badge on the iOS Messages tab and can reply back through the
// app.
router.post('/:id/contact-client', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  // Authorization: broker assigned to this app, the inmobiliaria owning
  // the broker, a secretary in the same inmobiliaria, or an admin.
  const isBroker = app.broker?.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user.role) && app.inmobiliaria_id === user.id;
  const isSecretary    = user.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin          = user.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin) {
    return res.status(403).json({ error: 'No autorizado para contactar este cliente' });
  }

  const { message } = req.body || {};
  const text = (message || '').trim();
  if (!text) return res.status(400).json({ error: 'El mensaje es obligatorio' });
  if (text.length > 2000) {
    return res.status(400).json({ error: 'El mensaje es demasiado largo (máximo 2000 caracteres)' });
  }

  // Resolve the client's user id. Guest applications don't have one, so
  // fall back to looking them up by email.
  let clientId = app.client?.user_id || null;
  if (!clientId && app.client?.email) {
    const clientUser = store.getUserByEmail(app.client.email);
    if (clientUser) {
      clientId = clientUser.id;
      // Back-fill the id on the application so later calls don't re-query
      app.client.user_id = clientUser.id;
      store.saveApplication(app);
    }
  }
  if (!clientId) {
    return res.status(400).json({
      error: 'Este cliente aplicó como invitado y no tiene una cuenta en la app. Contáctalo por correo o teléfono.',
    });
  }

  // Self-contact guard — a pro user can also be the client of their own
  // testing apps; don't create a self-conversation.
  if (clientId === req.user.sub) {
    return res.status(400).json({ error: 'No puedes enviarte un mensaje a ti mismo.' });
  }

  // Find or create the conversation — one per (client, property) pair.
  let conv = store.getConversations().find(
    c => c.clientId === clientId && c.propertyId === app.listing_id
  );

  const msgObj = {
    id:         'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    senderId:   req.user.sub,
    senderRole: 'broker',
    senderName: user.name || 'Agente',
    text,
    timestamp:  new Date().toISOString(),
  };

  if (conv) {
    // Continue existing thread. Don't reassign the broker if the
    // conversation already belongs to someone else.
    store.addMessage(conv.id, msgObj);
    conv.lastMessage  = text;
    conv.updatedAt    = new Date().toISOString();
    conv.unreadClient = (conv.unreadClient || 0) + 1;
    if (!conv.brokerId) { conv.brokerId = req.user.sub; conv.brokerName = user.name; }
    store.saveConversation(conv);
  } else {
    conv = {
      id:             'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      propertyId:     app.listing_id || '',
      propertyTitle:  app.listing_title || 'Propiedad',
      propertyImage:  null,
      clientId,
      clientName:     app.client?.name || 'Cliente',
      brokerId:       req.user.sub,
      brokerName:     user.name || 'Agente',
      inmobiliariaId: app.inmobiliaria_id || null,
      createdAt:      new Date().toISOString(),
      updatedAt:      new Date().toISOString(),
      lastMessage:    text,
      unreadBroker:   0,
      unreadClient:   1,
      message_count:  1,
    };
    store.saveConversation(conv);
    store.addMessage(conv.id, msgObj);
  }

  // Log on the application timeline so both sides have an audit trail
  addEvent(app, 'message', 'Mensaje enviado al cliente por la app: ' + text,
    req.user.sub, user.name || 'Broker',
    { role: 'broker', conversationId: conv.id, via: 'app' });
  store.saveApplication(app);

  // Push notification to the client's device
  pushNotify(clientId, {
    type:  'new_message',
    title: `💬 ${user.name || 'Agente'}`,
    body:  text.slice(0, 120) + (text.length > 120 ? '…' : ''),
    url:   `/mensajes?conv=${conv.id}`,
  });

  // Email fallback so they get it even without the app installed
  if (app.client?.email) {
    sendNotification(app.client.email,
      `HogaresRD — Nuevo mensaje sobre ${app.listing_title}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
         <div style="background:#002D62;color:#fff;padding:1.25rem 1.5rem;border-radius:10px 10px 0 0;">
           <h2 style="margin:0;font-size:1.1rem;">Nuevo mensaje de ${user.name || 'tu agente'}</h2>
         </div>
         <div style="background:#fff;padding:1.25rem 1.5rem;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px;">
           <p style="margin:0 0 12px;color:#4d6a8a;font-size:0.9rem;">Sobre tu aplicación para <strong>${app.listing_title}</strong>:</p>
           <blockquote style="margin:0 0 14px;padding:0.75rem 1rem;background:#f0f6ff;border-left:3px solid #0038A8;border-radius:6px;color:#1a2b40;font-size:0.92rem;line-height:1.5;">${text.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</blockquote>
           <a href="${BASE_URL}/mensajes" style="display:inline-block;background:#0038A8;color:#fff;padding:0.7rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:700;">Responder en la app →</a>
         </div>
       </div>`
    );
  }

  res.json({ success: true, conversation: conv });
});

// ══════════════════════════════════════════════════════════════════
// ── COMMISSIONS ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
//
// Flow:
//   1. Agent (broker/agency) submits the commission for a sale via
//      POST /:id/commission. Status becomes 'pending_review'.
//   2. The inmobiliaria owner (or the agent themselves if they are
//      independent — no inmobiliaria_id) reviews via
//      PUT /:id/commission/review with action 'approve' | 'adjust'
//      | 'reject'. Adjusting reopens the submission with new numbers
//      and tracks the delta in the history audit trail.
//   3. GET /commissions returns an aggregated summary scoped to the
//      caller's role — agents see their own; inmobiliaria owners
//      see the whole team plus their own "inmobiliaria cut" totals.
//
// Data shape stored on the application under `commission`:
// {
//   sale_amount, agent_percent, agent_amount,
//   inmobiliaria_percent, inmobiliaria_amount, agent_net,
//   status: 'pending_review' | 'approved' | 'rejected',
//   submitted_by, submitted_at,
//   reviewed_by,  reviewed_at, reviewer_name,
//   adjustment_note,
//   history: [{ at, by, byName, action, snapshot, note }]
// }

function safePercent(value, fallback = 0) {
  const n = Number(value);
  if (!isFinite(n) || n < 0 || n > 100) return fallback;
  return Math.round(n * 100) / 100;
}
function safeAmount(value) {
  const n = Number(String(value || '').replace(/[^\d.]/g, ''));
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}
function commissionComputed({ sale_amount, agent_percent, inmobiliaria_percent }) {
  const sale  = safeAmount(sale_amount);
  const ap    = safePercent(agent_percent);
  const ip    = safePercent(inmobiliaria_percent);
  const agent_amount        = Math.round((sale * ap / 100) * 100) / 100;
  const inmobiliaria_amount = Math.round((sale * ip / 100) * 100) / 100;
  // The inmobiliaria cut is taken FROM the agent's commission — that's
  // how DR real-estate offices typically split it. agent_net = what the
  // agent ends up with after the office takes their share.
  const agent_net = Math.max(0, Math.round((agent_amount - inmobiliaria_amount) * 100) / 100);
  return {
    sale_amount:          sale,
    agent_percent:        ap,
    agent_amount,
    inmobiliaria_percent: ip,
    inmobiliaria_amount,
    agent_net,
  };
}

// POST /:id/commission — agent submits commission for a sale
router.post('/:id/commission', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  const isBroker = app.broker?.user_id === req.user.sub;
  const isAdmin  = user.role === 'admin';
  if (!isBroker && !isAdmin) {
    return res.status(403).json({ error: 'Solo el agente asignado puede registrar la comisión.' });
  }

  // Only allow commission entry when the sale is essentially done.
  const allowed = ['aprobado', 'pendiente_pago', 'pago_enviado', 'pago_aprobado', 'completado'];
  if (!allowed.includes(app.status)) {
    return res.status(400).json({
      error: 'Solo puedes registrar la comisión cuando la aplicación esté aprobada o en fase de pago.',
    });
  }

  const payload = commissionComputed(req.body || {});
  if (payload.sale_amount <= 0) {
    return res.status(400).json({ error: 'Monto de venta es obligatorio y debe ser mayor a 0.' });
  }
  if (payload.agent_percent <= 0) {
    return res.status(400).json({ error: 'El porcentaje de comisión debe ser mayor a 0.' });
  }
  if (payload.inmobiliaria_amount > payload.agent_amount) {
    return res.status(400).json({
      error: 'La comisión de la inmobiliaria no puede ser mayor que la comisión del agente.',
    });
  }

  const now = new Date().toISOString();
  const prev = app.commission ? { ...app.commission } : null;

  app.commission = {
    ...payload,
    status:         'pending_review',
    submitted_by:   user.id,
    submitted_name: user.name || '',
    submitted_at:   now,
    reviewed_by:    null,
    reviewer_name:  '',
    reviewed_at:    null,
    adjustment_note: '',
    history: Array.isArray(prev?.history) ? prev.history.slice() : [],
  };
  app.commission.history.push({
    at:       now,
    by:       user.id,
    byName:   user.name || '',
    action:   prev ? 'resubmitted' : 'submitted',
    snapshot: { ...payload },
    note:     (req.body?.note || '').toString().slice(0, 300),
  });
  app.updated_at = now;

  addEvent(app, 'commission_submitted',
    `Comisión registrada: $${payload.agent_amount.toLocaleString()} (${payload.agent_percent}%)` +
    (payload.inmobiliaria_amount > 0
      ? ` — inmobiliaria $${payload.inmobiliaria_amount.toLocaleString()}`
      : ''),
    user.id, user.name || 'Agente', { commission: payload });
  saveApplicationEncryptingFinancials(app);

  // Notify the inmobiliaria owner if the broker belongs to one.
  if (app.inmobiliaria_id) {
    const inmUser = store.getUserById(app.inmobiliaria_id);
    if (inmUser?.email) {
      sendNotification(
        inmUser.email,
        `HogaresRD — Nueva comisión para revisar: ${app.listing_title}`,
        `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
           <div style="background:#002D62;color:#fff;padding:1.25rem;border-radius:10px 10px 0 0;text-align:center;">
             <h2 style="margin:0;font-size:1.1rem;">Comisión pendiente de aprobación</h2>
           </div>
           <div style="background:#fff;padding:1.25rem 1.5rem;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px;">
             <p>El agente <strong>${user.name || ''}</strong> registró una comisión sobre:</p>
             <p style="font-size:1.05rem;font-weight:700;">${app.listing_title}</p>
             <table style="font-size:0.88rem;color:#1a2b40;width:100%;max-width:280px;">
               <tr><td style="color:#7a9bbf;padding:4px 0;">Venta:</td><td style="text-align:right;font-weight:700;">$${payload.sale_amount.toLocaleString()}</td></tr>
               <tr><td style="color:#7a9bbf;padding:4px 0;">Comisión del agente:</td><td style="text-align:right;font-weight:700;">${payload.agent_percent}% · $${payload.agent_amount.toLocaleString()}</td></tr>
               <tr><td style="color:#7a9bbf;padding:4px 0;">Cuota inmobiliaria:</td><td style="text-align:right;font-weight:700;">${payload.inmobiliaria_percent}% · $${payload.inmobiliaria_amount.toLocaleString()}</td></tr>
               <tr><td style="color:#7a9bbf;padding:4px 0;">Neto al agente:</td><td style="text-align:right;font-weight:700;">$${payload.agent_net.toLocaleString()}</td></tr>
             </table>
             <div style="margin-top:20px;">
               <a href="${BASE_URL}/broker#contabilidad" style="display:inline-block;background:#002D62;color:#fff;padding:0.7rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:700;">Revisar comisión →</a>
             </div>
           </div>
         </div>`
      );
    }
    pushNotify(app.inmobiliaria_id, {
      type:  'commission_submitted',
      title: 'Nueva comisión para revisar',
      body:  `${user.name || 'Un agente'} registró una comisión de $${payload.agent_amount.toLocaleString()} sobre ${app.listing_title}`,
      url:   '/broker#contabilidad',
    });
  }

  res.json({ success: true, commission: app.commission });
});

// PUT /:id/commission/review — inmobiliaria owner approves / adjusts / rejects
router.put('/:id/commission/review', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  // Only the inmobiliaria owner tied to this application (or an admin)
  // can review commissions. Independent agents can't review their own
  // submissions — if they have no inmobiliaria, their submission is
  // auto-approved on creation (see auto-approve branch further down).
  const isInmOwner = ['inmobiliaria', 'constructora'].includes(user.role)
                     && app.inmobiliaria_id === user.id;
  const isAdmin    = user.role === 'admin';
  if (!isInmOwner && !isAdmin) {
    return res.status(403).json({
      error: 'Solo la inmobiliaria dueña de este agente puede aprobar comisiones.',
    });
  }

  if (!app.commission) return res.status(400).json({ error: 'No hay comisión registrada.' });

  const action = (req.body?.action || '').toString();
  if (!['approve', 'adjust', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Acción inválida.' });
  }

  const now = new Date().toISOString();
  const { history: _bh, ...snapshotBefore } = app.commission;

  if (action === 'reject') {
    app.commission.status          = 'rejected';
    app.commission.reviewed_by     = user.id;
    app.commission.reviewer_name   = user.name || '';
    app.commission.reviewed_at     = now;
    app.commission.adjustment_note = (req.body?.note || '').toString().slice(0, 300);
  } else if (action === 'approve') {
    app.commission.status          = 'approved';
    app.commission.reviewed_by     = user.id;
    app.commission.reviewer_name   = user.name || '';
    app.commission.reviewed_at     = now;
    app.commission.adjustment_note = '';
  } else if (action === 'adjust') {
    const recomputed = commissionComputed(req.body || {});
    if (recomputed.sale_amount <= 0 || recomputed.agent_percent <= 0) {
      return res.status(400).json({ error: 'Monto o porcentaje inválido.' });
    }
    if (recomputed.inmobiliaria_amount > recomputed.agent_amount) {
      return res.status(400).json({
        error: 'La comisión de la inmobiliaria no puede ser mayor que la del agente.',
      });
    }
    Object.assign(app.commission, recomputed);
    app.commission.status          = 'approved';
    app.commission.reviewed_by     = user.id;
    app.commission.reviewer_name   = user.name || '';
    app.commission.reviewed_at     = now;
    app.commission.adjustment_note = (req.body?.note || '').toString().slice(0, 300);
  }

  if (!Array.isArray(app.commission.history)) app.commission.history = [];
  app.commission.history.push({
    at:       now,
    by:       user.id,
    byName:   user.name || '',
    action,
    snapshotBefore,
    snapshotAfter: (() => { const { history: _ah, ...rest } = app.commission; return rest; })(),
    note:     (req.body?.note || '').toString().slice(0, 300),
  });
  app.updated_at = now;

  addEvent(app, 'commission_' + action,
    action === 'approve' ? `Comisión aprobada por ${user.name || 'inmobiliaria'}` :
    action === 'adjust'  ? `Comisión ajustada por ${user.name || 'inmobiliaria'}` :
                           `Comisión rechazada por ${user.name || 'inmobiliaria'}`,
    user.id, user.name || '', { commission: app.commission });

  saveApplicationEncryptingFinancials(app);

  // Notify the submitting agent
  const agentUser = app.commission.submitted_by
    ? store.getUserById(app.commission.submitted_by)
    : null;
  if (agentUser) {
    pushNotify(agentUser.id, {
      type:  'commission_reviewed',
      title: action === 'reject' ? 'Comisión rechazada'
           : action === 'adjust' ? 'Comisión ajustada'
                                 : 'Comisión aprobada',
      body:  `${user.name || 'Inmobiliaria'} ${action === 'reject' ? 'rechazó' : action === 'adjust' ? 'ajustó' : 'aprobó'} tu comisión sobre ${app.listing_title}`,
      url:   '/broker#contabilidad',
    });
    if (agentUser.email) {
      sendNotification(
        agentUser.email,
        `HogaresRD — Tu comisión fue ${action === 'reject' ? 'rechazada' : action === 'adjust' ? 'ajustada' : 'aprobada'}`,
        `<p>Hola <strong>${(agentUser.name || '').split(' ')[0]}</strong>,</p>
         <p>${user.name || 'La inmobiliaria'} revisó tu comisión sobre <strong>${app.listing_title}</strong>.</p>
         <table style="font-size:0.88rem;color:#1a2b40;">
           <tr><td style="color:#7a9bbf;padding:4px 10px 4px 0;">Estado:</td><td style="font-weight:700;">${app.commission.status === 'approved' ? 'Aprobada' : 'Rechazada'}</td></tr>
           <tr><td style="color:#7a9bbf;padding:4px 10px 4px 0;">Comisión agente:</td><td style="font-weight:700;">${app.commission.agent_percent}% · $${app.commission.agent_amount.toLocaleString()}</td></tr>
           <tr><td style="color:#7a9bbf;padding:4px 10px 4px 0;">Neto al agente:</td><td style="font-weight:700;">$${app.commission.agent_net.toLocaleString()}</td></tr>
         </table>
         ${app.commission.adjustment_note ? '<p><em>Nota: ' + String(app.commission.adjustment_note).replace(/</g,'&lt;') + '</em></p>' : ''}
         <a href="${BASE_URL}/broker#contabilidad">Ver detalle →</a>`
      );
    }
  }

  res.json({ success: true, commission: app.commission });
});

// ── GET /:id/commission/history — audit trail of commission changes ──
// Every commission submit / resubmit / approve / adjust / reject pushes
// an entry onto app.commission.history. Until now nothing exposed it,
// so the audit trail was write-only. Returning it here lets brokers and
// inmobiliarias see who did what and when.
router.get('/:id/commission/history', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Decrypt before returning so any commission snapshots in the
  // history (sale_amount, agent_amount, etc.) aren't ciphertext.
  const dec = decryptAppPII(app);
  const history = Array.isArray(dec.commission?.history) ? dec.commission.history : [];
  res.json({
    application_id: app.id,
    status: dec.commission?.status || null,
    history,
  });
});

// GET /commissions/summary — per-user aggregated view
router.get('/commissions/summary', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  const proRoles = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];
  if (!proRoles.includes(user.role) && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo agentes e inmobiliarias tienen comisiones.' });
  }

  // Scope
  let apps;
  if (['inmobiliaria', 'constructora'].includes(user.role)) {
    apps = store.getApplicationsByInmobiliaria(user.id);
  } else if (user.role === 'secretary') {
    apps = store.getApplicationsByInmobiliaria(user.inmobiliaria_id);
  } else if (user.role === 'admin') {
    apps = store.getApplications();
  } else {
    apps = store.getApplicationsByBroker(user.id);
  }

  const withCommission = apps.filter(a => a.commission && a.commission.sale_amount > 0);

  let agent_pending = 0;
  let agent_approved = 0;
  let agent_total_sales = 0;
  let inmobiliaria_pending = 0;
  let inmobiliaria_approved = 0;

  const rows = withCommission.map(a => {
    const c = a.commission;
    if (c.status === 'pending_review') {
      agent_pending += c.agent_net || 0;
      inmobiliaria_pending += c.inmobiliaria_amount || 0;
    }
    if (c.status === 'approved') {
      agent_approved += c.agent_net || 0;
      inmobiliaria_approved += c.inmobiliaria_amount || 0;
      agent_total_sales += c.sale_amount || 0;
    }
    return {
      application_id: a.id,
      listing_title:  a.listing_title,
      listing_price:  Number(a.listing_price) || 0,
      client_name:    a.client?.name || '',
      agent_user_id:  a.broker?.user_id || null,
      agent_name:     a.broker?.name || '',
      commission:     c,
      status:         a.status,
      created_at:     a.created_at,
      updated_at:     a.updated_at,
    };
  });

  rows.sort((x, y) => new Date(y.updated_at || 0) - new Date(x.updated_at || 0));

  res.json({
    role: user.role,
    summary: {
      agent_pending,
      agent_approved,
      agent_total_sales,
      inmobiliaria_pending,
      inmobiliaria_approved,
      total_pending_count:  rows.filter(r => r.commission.status === 'pending_review').length,
      total_approved_count: rows.filter(r => r.commission.status === 'approved').length,
    },
    commissions: rows,
  });
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
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const isBrokerOwner  = app.broker.user_id === req.user.sub;
  const admin          = isAdmin(req) || user?.role === 'admin';

  if (!isBrokerOwner && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Status guard: payment plan requires an approved or later status
  const paymentAllowed = ['aprobado', 'pendiente_pago', 'pago_enviado', 'pago_aprobado'];
  if (!paymentAllowed.includes(app.status) && !admin) {
    return res.status(400).json({
      error: 'El plan de pagos solo puede crearse cuando la aplicación está aprobada.',
    });
  }

  // Broker can only create the plan (first time). Once it exists, only inmobiliaria can edit.
  const planExists = !!(app.payment_plan?.installments?.length);
  if (planExists && isBrokerOwner && !isInmobiliaria && !admin)
    return res.status(403).json({
      error: 'El plan de pagos ya fue creado. Solo la inmobiliaria puede modificarlo.',
    });

  const { payment_method, method_details, currency, total_amount, notes, installments } = req.body;
  if (!Array.isArray(installments) || !installments.length)
    return res.status(400).json({ error: 'Se requiere al menos una cuota' });

  // Validate installment amounts are positive
  for (const inst of installments) {
    if (!inst.amount || Number(inst.amount) <= 0)
      return res.status(400).json({ error: 'Cada cuota debe tener un monto mayor a 0' });
  }

  // Validate installment sum matches total (if total provided)
  const instSum = installments.reduce((s, inst) => s + Number(inst.amount || 0), 0);
  if (total_amount && Math.abs(instSum - Number(total_amount)) > 1) {
    return res.status(400).json({ error: `La suma de las cuotas (${instSum.toLocaleString()}) no coincide con el total (${Number(total_amount).toLocaleString()})` });
  }

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
  saveApplicationEncryptingFinancials(app);
  if (!isEdit && app.client.email)
    sendNotification(app.client.email, 'HogaresRD — Plan de Pagos Creado', buildPaymentPlanEmail(app));

  // Auto-create task for client to upload payment proof
  if (!isEdit && app.client?.user_id) {
    const firstDue = installments[0]?.due_date || null;
    createAutoTask({
      title:          'Sube tu comprobante de pago',
      description:    `Tu plan de pagos ha sido creado con ${installments.length} cuota(s) por ${fmtAmt(total_amount, currency || 'DOP')}. Sube el comprobante de tu primer pago.`,
      assigned_to:    app.client.user_id,
      assigned_by:    req.user.sub,
      application_id: app.id,
      listing_id:     app.listing_id,
      source_event:   'payment_plan_created',
      due_date:       firstDue,
      approver_id:    app.broker.user_id,
    });
  }

  // Return only the payment plan — avoids circular JSON from the full app object
  res.json({ ok: true, payment_plan: app.payment_plan });
});

// ── POST /:id/payment-plan/:iid/upload  — Client uploads proof ───
router.post('/:id/payment-plan/:iid/upload', userAuth, docUpload.single('proof'), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app || !app.payment_plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const user     = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
    (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isClient && !isBroker && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });
  const inst = app.payment_plan.installments.find(i => i.id === req.params.iid);
  if (!inst)       return res.status(404).json({ error: 'Cuota no encontrada' });
  if (!req.file)   return res.status(400).json({ error: 'Archivo requerido' });
  if (inst.status === 'approved') return res.status(400).json({ error: 'Este pago ya fue aprobado' });
  if (inst.status === 'proof_uploaded') return res.status(400).json({ error: 'Ya subiste un comprobante para esta cuota. Espera la revisión antes de subir otro.' });

  // Validate MIME type via magic bytes
  if (!(await validateMime(req.file.path)))
    return res.status(400).json({ error: 'Tipo de archivo no permitido. Formatos aceptados: JPG, PNG, HEIC, PDF, DOC(X), XLS(X), TXT, CSV.' });
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
  // If agent uploaded on behalf of client, complete client's upload task
  if (!isClient) {
    autoCompleteTasksByEvent(app.id, 'payment_plan_created');
  }
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
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin       = isAdmin(req) || user?.role === 'admin';
  // Only inmobiliaria, secretary, or admin can verify payments (not the broker — separation of duties)
  if (!isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'Solo la inmobiliaria o secretaria pueden aprobar pagos' });
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
  // Mirror the single-payment /verify path: clear the broker's
  // "verify payment" task so it doesn't linger after the review,
  // regardless of whether the installment was approved or rejected.
  autoCompleteTasksByEvent(app.id, 'payment_uploaded');
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
  res.json(decryptAppPII(app));
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
    (!app.client.user_id && user && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  if (!isBroker && !isClient && !isInmobiliaria && !isSecretary && !isAdmin(req)) return res.status(403).json({ error: 'No autorizado' });
  const inst = app.payment_plan.installments.find(i => i.id === req.params.iid);
  if (!inst?.proof_path)               return res.status(404).json({ error: 'Comprobante no encontrado' });
  if (!fs.existsSync(inst.proof_path)) return res.status(404).json({ error: 'Archivo no encontrado' });
  const safeProof = guardDocPath(inst.proof_path);
  if (!safeProof) return res.status(400).json({ error: 'Ruta de archivo inválida' });
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(inst.proof_original || 'proof')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
  res.json(decryptAppPII(app));
});

module.exports = router;
