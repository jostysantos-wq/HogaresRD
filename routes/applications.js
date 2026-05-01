const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');
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
// file-type v16 is the last CJS-compatible release (v17+ is ESM-only).
// v16 exports `fromFile(path) → Promise<{ ext, mime } | undefined>` —
// previously this destructured `fileTypeFromFile` (the v17+ name) which
// resolved to undefined and made `validateMime` throw on every call,
// silently rejecting EVERY upload in production. Tests stub `validateMime`
// directly via __test._setValidateMime so the breakage was invisible.
const { fromFile: fileTypeFromFile } = require('file-type');

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
let transporter = createTransport();

// ── In-process idempotency guard (P1 #16) ────────────────────────
// Two near-simultaneous POST /api/applications/ requests with the
// same `listing_id|email` could both pass the dedup scan because the
// row only lands in the cache after `withTransaction` resolves. We
// add a soft, in-process `_recentSubmits` Map keyed on
// `listing_id|lower(email)` with a 60s TTL. The first request to
// reach the handler claims the key; the second sees it and treats
// the call as a duplicate.
//
// This is a SINGLE-PROCESS guard — it depends on PM2 fork mode
// (already required by this codebase because of the in-memory cache
// in routes/store.js). Cluster mode or multiple replicas would need
// a Redis SET NX or DB unique constraint instead.
const _recentSubmits = new Map(); // key → expiresAt (ms)
const _RECENT_SUBMIT_TTL_MS = 60 * 1000;
function _claimRecentSubmit(key) {
  const now = Date.now();
  // Best-effort lazy GC so the Map can't grow unbounded.
  if (_recentSubmits.size > 1000) {
    for (const [k, exp] of _recentSubmits) {
      if (exp <= now) _recentSubmits.delete(k);
    }
  }
  const existing = _recentSubmits.get(key);
  if (existing && existing > now) return false; // already claimed
  _recentSubmits.set(key, now + _RECENT_SUBMIT_TTL_MS);
  return true;
}
function _releaseRecentSubmit(key) {
  _recentSubmits.delete(key);
}

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

// Currencies accepted on payment + payment-plan upload endpoints.
// Persisted strings flow into receipts, payment-plan rows, and the
// timeline event labels — letting an arbitrary string through means
// the UI ends up rendering "BTC" or worse on broker dashboards.
const VALID_CURRENCIES = ['DOP', 'USD'];

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
// Routed through the indirection `validateMime` (let-binding) so tests
// can swap in a stub via __test._setValidateMime — the file-type
// package doesn't ship a usable test fixture-mode.
//
// Optional `expectedMime` lets callers (and regression tests) assert
// that the sniffed mime matches what the upload claimed — when omitted,
// we keep the original "any allowed mime is fine" behavior so existing
// route handlers don't change shape.
async function _validateMimeImpl(filePath, expectedMime) {
  try {
    const result = await fileTypeFromFile(filePath);
    // result is undefined for plain-text or unknown formats — block them
    if (!result || !ALLOWED_MIME_TYPES.has(result.mime)) {
      fs.unlink(filePath, () => {}); // async delete, ignore errors
      return false;
    }
    if (expectedMime && result.mime !== expectedMime) {
      fs.unlink(filePath, () => {});
      return false;
    }
    return true;
  } catch {
    fs.unlink(filePath, () => {});
    return false;
  }
}
let validateMime = _validateMimeImpl;

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

// JWT verify with rotation grace. Hoisted to utils/jwt.js so the same
// rotation logic is shared with routes/inventory.js (and any future
// direct-verify call site). routes/auth.js's `userAuth`/`verifyJWT`
// remain the standard middleware path.
const { verifyJwtAcceptingPrev } = require('../utils/jwt');

// Strip server-side / broker-internal data from an application before
// returning it to a buyer. Used for:
//   • the magic-link tracker (GET /track-token) — recipients can be
//     forwarded; the link is not equivalent to authenticating as the
//     applicant, so it should leak strictly less than GET /:id.
//   • GET /:id when the requester is a "pure client" (the application's
//     buyer with no broker/owner/admin role on this record).
//   • GET /my (always — endpoint is buyer-only by design).
//
// Returns a deep clone with the following stripped:
//   • timeline_events with is_internal === true (or data.is_internal === true)
//     — buyer must not see broker private notes.
//   • app.commission entirely — broker payout details are not buyer-visible.
//   • app.payment.receipt_path / processed_receipt_path — server-side
//     filesystem paths. Amount, currency, status, verified flags stay.
//   • payment_plan.installments[].proof_path — same reason.
//   • broker.email / broker.phone — a leaked link should not auto-disclose
//     the agent's contact info; the rightful applicant has these in their
//     confirmation email.
//   • co_applicant.id_number / co_applicant.monthly_income — the
//     magic-link page doesn't render these and we want to minimize the
//     decrypted footprint.
function scrubForBuyer(app) {
  if (!app || typeof app !== 'object') return app;
  const copy = JSON.parse(JSON.stringify(app));

  // Timeline events — drop anything flagged internal at the top-level
  // OR inside data.is_internal.
  if (Array.isArray(copy.timeline_events)) {
    copy.timeline_events = copy.timeline_events.filter(ev =>
      !(ev && (ev.is_internal === true || ev.data?.is_internal === true))
    );
  }

  // Commission block — entirely broker/owner internal.
  delete copy.commission;

  // Payment: keep buyer-visible status/amount fields, drop file paths.
  if (copy.payment && typeof copy.payment === 'object') {
    delete copy.payment.receipt_path;
    delete copy.payment.processed_receipt_path;
  }

  // Payment plan installments: drop server-side proof paths.
  if (copy.payment_plan && Array.isArray(copy.payment_plan.installments)) {
    for (const inst of copy.payment_plan.installments) {
      if (inst && typeof inst === 'object') {
        delete inst.proof_path;
      }
    }
  }

  // Broker contact channels — name/agency_name remain visible.
  if (copy.broker && typeof copy.broker === 'object') {
    delete copy.broker.email;
    delete copy.broker.phone;
  }

  // Co-applicant: keep name + existence flag, drop sensitive PII.
  if (copy.co_applicant && typeof copy.co_applicant === 'object') {
    delete copy.co_applicant.id_number;
    delete copy.co_applicant.monthly_income;
  }

  return copy;
}

function addEvent(app, type, description, actor, actorName, data = {}) {
  if (!app.timeline_events) app.timeline_events = [];
  app.timeline_events.push({
    id: uuid(), type, description, actor, actor_name: actorName, data,
    created_at: new Date().toISOString(),
  });
  app.updated_at = new Date().toISOString();
}

// D2 helper: derive the actor's effective access level. Owners
// (inmobiliaria/constructora/admin) are always max (3 — Director).
// Team members with explicit access_level use that; everyone else
// (brokers, clients, etc.) get 0. Used to gate aprobado/completado.
function OWNER_ACCESS_LEVEL_LIMIT(user) {
  if (!user) return 0;
  if (['inmobiliaria', 'constructora', 'admin'].includes(user.role)) return 3;
  if (user.inmobiliaria_id) return Number(user.access_level) || 1;
  return 0;
}

// Persist a failed delivery onto the application so it's auditable
// and can be surfaced (or retried) later. Side-effect-only — never
// throws; if even the recording itself blows up we just log it.
function recordNotificationFailure(app, info) {
  try {
    if (!app) return;
    app.notification_failures = app.notification_failures || [];
    app.notification_failures.push({
      id:        uuid(),
      recipient: info.recipient || '',
      subject:   info.subject   || '',
      purpose:   info.purpose   || 'unknown',
      error:     info.error     || 'unknown',
      failed_at: new Date().toISOString(),
      retried:   false,
    });
    addEvent(app, 'notification_failed',
      `No se pudo enviar el email "${info.subject}" a ${info.recipient}: ${info.error}`,
      'system', 'Sistema',
      { recipient: info.recipient, subject: info.subject, error: info.error, purpose: info.purpose });
    store.saveApplication(app);
  } catch (innerErr) {
    console.error('[applications] Failed to record notification failure:', innerErr.message);
  }
}

// Persist a failed unit-inventory sync so the unit doesn't silently
// stay `reserved` after a rejection (or stay `available` after a
// completion). Same shape as recordNotificationFailure — never throws.
function recordInventorySyncFailure(app, error, unitId) {
  try {
    if (!app) return;
    app.inventory_sync_failed_at = new Date().toISOString();
    app.inventory_sync_error     = error?.message || String(error);
    app.inventory_sync_unit_id   = unitId || app.assigned_unit?.unitId || null;
    addEvent(app, 'inventory_sync_failed',
      `Falló la sincronización del inventario tras cambio de estado: ${app.inventory_sync_error}`,
      'system', 'Sistema',
      { unitId: app.inventory_sync_unit_id, error: app.inventory_sync_error });
    store.saveApplication(app);
  } catch (innerErr) {
    console.error('[applications] Failed to record inventory sync failure:', innerErr.message);
  }
}

// ── Shared rejection side-effects ─────────────────────────────────
// Applies the side-effects of moving an application to `rechazado`:
//   • flips `app.status` + `status_reason`
//   • voids any approved commission (and clears stale payout pointers)
//   • releases the assigned `unit_inventory` slot back to `available`
//   • writes an audit event capturing from→to + reason
//
// MUST be invoked inside an open transaction — the caller is
// responsible for `await store.saveApplication(app, client)` after this
// returns. Listing writes (when an inventory release happens) join the
// same transaction so rejection + inventory release commit together.
//
// Notifications (email/push) and task auto-completion are
// intentionally deferred to the caller and executed AFTER the txn
// resolves, mirroring the established pattern at PUT /:id/status.
//
// Returns metadata so the caller can drive post-txn side-effects:
//   { from, voidedCommission, releasedUnitId }
async function applyRejection(app, { reason, actorId, actorName, client, bulk = false } = {}) {
  const from = app.status;
  app.status = 'rechazado';
  app.status_reason = reason || '';

  const rejectionLabel = bulk
    ? `Aplicación rechazada (acción en lote)${reason ? ': ' + reason : ''}`
    : `Estado cambiado a ${STATUS_LABELS['rechazado']}${reason ? ': ' + reason : ''}`;
  addEvent(app, 'status_change', rejectionLabel,
    actorId, actorName,
    { from, to: 'rechazado', reason: reason || '', bulk });

  // Void approved commission: a rejected sale shouldn't pay out.
  let voidedCommission = false;
  if (app.commission?.status === 'approved') {
    app.commission.status     = 'voided';
    app.commission.voided_at  = new Date().toISOString();
    if (app.commission.payout_id)  app.commission.payout_id  = null;
    if (app.commission.payout_ref) app.commission.payout_ref = null;
    addEvent(app, 'commission_voided',
      'Comisión anulada por rechazo de la aplicación',
      'system', 'Sistema', { reason: 'application_rejected', bulk });
    voidedCommission = true;
  }

  // Release the assigned unit so a teammate can offer it again.
  let releasedUnitId = null;
  if (app.assigned_unit?.unitId && app.listing_id) {
    const targetUnitId = app.assigned_unit.unitId;
    try {
      const listing = store.getListingById(app.listing_id);
      if (listing && Array.isArray(listing.unit_inventory)) {
        const unit = listing.unit_inventory.find(u => u.id === targetUnitId);
        if (unit) {
          unit.status        = 'available';
          unit.applicationId = null;
          unit.clientName    = null;
          listing.units_available = listing.unit_inventory.filter(u => u.status === 'available').length;
          await store.saveListing(listing, client);
          releasedUnitId = targetUnitId;
          app.assigned_unit = null;
        }
      }
    } catch (e) {
      // Inventory sync is best-effort, like the existing PUT /:id/status
      // path — record the failure on the app but don't block the reject.
      console.error('[applyRejection] inventory release failed:', e.message);
      recordInventorySyncFailure(app, e, targetUnitId);
    }
  }

  return { from, voidedCommission, releasedUnitId };
}

// Fire-and-forget email sender. When given an app context, a failed
// delivery is recorded on that application (timeline event +
// notification_failures entry) so the broker can see that the
// customer never got the message and follow up out-of-band.
function sendNotification(to, subject, html, context = {}) {
  if (!to) return;
  transporter.sendMail({ to, subject, html, department: 'admin' })
    .catch(err => {
      console.error('[applications] Email failed:', subject, '→', to, err.message);
      if (context.app) {
        recordNotificationFailure(context.app, {
          recipient: to,
          subject,
          purpose: context.purpose || 'unknown',
          error:   err.message,
        });
      }
    });
}

// E7: status labels are now sourced from public/locales/<lang>.json so
// the same translation table powers admin, broker, and email surfaces.
// We cache the parsed JSON per-language; first hit pays the disk read.
const _localeCache = new Map();
function loadLocale(lang) {
  if (_localeCache.has(lang)) return _localeCache.get(lang);
  try {
    const file = path.join(__dirname, '..', 'public', 'locales', `${lang}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    _localeCache.set(lang, json);
    return json;
  } catch {
    _localeCache.set(lang, null);
    return null;
  }
}
function appStatusLabel(status, lang) {
  const want = (lang === 'en') ? 'en' : 'es';
  const fallback = loadLocale('es')?.application_status || {};
  const labels = loadLocale(want)?.application_status || fallback;
  return labels[status] || fallback[status] || status;
}
function userLangFor(app) {
  const uid = app?.client?.user_id;
  if (!uid) return 'es';
  try {
    const u = store.getUserById(uid);
    return (u && (u.lang === 'en' || u.lang === 'es')) ? u.lang : 'es';
  } catch { return 'es'; }
}

function statusEmail(app, oldStatus, newStatus, reason) {
  const lang = userLangFor(app);
  const statusName = appStatusLabel(newStatus, lang);
  const isPositive = ['aprobado', 'pago_aprobado', 'completado', 'reservado'].includes(newStatus);
  const isNegative = ['rechazado', 'documentos_insuficientes'].includes(newStatus);
  const badgeColor = isPositive ? '#16a34a' : isNegative ? '#CE1126' : '#002D62';

  const isEs = lang === 'es';
  const introCopy   = isEs
    ? 'Tu aplicacion para <strong>' + et.esc(app.listing_title) + '</strong> ha sido actualizada.'
    : 'Your application for <strong>' + et.esc(app.listing_title) + '</strong> has been updated.';
  const reasonLabel = isEs ? 'Motivo' : 'Reason';
  const buttonCopy  = isEs ? 'Ver mi aplicacion' : 'View my application';
  const footerCopy  = isEs
    ? 'Si tienes preguntas sobre este cambio, responde a este correo.'
    : 'If you have questions about this change, reply to this email.';
  const titleCopy   = isEs ? 'Estado de tu aplicacion' : 'Your application status';
  const preheader   = isEs
    ? 'Tu aplicacion para ' + (app.listing_title || '') + ' ahora esta: ' + statusName
    : 'Your application for ' + (app.listing_title || '') + ' is now: ' + statusName;
  const subjectCopy = isEs
    ? 'Tu aplicacion: ' + statusName + ' — HogaresRD'
    : 'Your application: ' + statusName + ' — HogaresRD';

  // Anonymous applicants don't have an account, so /my-applications?id=
  // bounces them to /login and they can't reach their tracking page.
  // Mint a fresh magic-link `/track.html?token=...` URL instead — same
  // signTrackToken helper used by the post-submit confirmation email.
  // Logged-in buyers (client.user_id set) keep the in-app deep link.
  const baseUrl = process.env.BASE_URL || 'https://hogaresrd.com';
  const trackUrl = app?.client?.user_id
    ? `${baseUrl}/my-applications?id=${app.id}`
    : `${baseUrl}/track.html?token=${signTrackToken(app.id)}`;

  const body = et.p(introCopy)
    + '<div style="text-align:center;margin:20px 0;">' + et.statusBadge(statusName, badgeColor) + '</div>'
    + (reason ? et.alertBox('<strong>' + reasonLabel + ':</strong> ' + et.esc(reason), isNegative ? 'danger' : 'info') : '')
    + et.button(buttonCopy, trackUrl)
    + et.divider()
    + et.small(footerCopy);

  return {
    subject: subjectCopy,
    html: et.layout({ title: titleCopy, subtitle: et.esc(app.listing_title), preheader, body }),
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

// ── Buyer confirmation email helpers (B3 + B4) ───────────────────
// `buyerConfirmationHtml` produces the HTML body for the post-submit
// confirmation email sent to BOTH logged-in clients and anonymous
// applicants. Anonymous applicants additionally receive a magic-link
// "track" URL — `signTrackToken` mints the JWT for that link.
function signTrackToken(applicationId) {
  // 30-day expiry — same window we tell brokers to expect a buyer to
  // complete or withdraw before we admin-archive an inactive lead.
  return jwt.sign(
    { aid: applicationId, kind: 'track' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function buyerConfirmationHtml(app, link) {
  const brokerLine = app.broker?.name && app.broker?.email
    ? et.infoRow('Tu agente', `${et.esc(app.broker.name)} <${et.esc(app.broker.email)}>`)
    : (app.broker?.name ? et.infoRow('Tu agente', et.esc(app.broker.name)) : '');
  return et.layout({
    title: 'Recibimos tu aplicación',
    subtitle: et.esc(app.listing_title || 'HogaresRD'),
    preheader: 'Hemos recibido tu aplicación — aquí está el enlace para darle seguimiento.',
    body:
      et.p('Gracias por aplicar a través de HogaresRD. Tu aplicación ha sido recibida y un agente la revisará pronto.')
      + et.infoTable(
          et.infoRow('Propiedad', et.esc(app.listing_title || ''))
          + et.infoRow('Aplicación #', et.esc(app.id))
          + brokerLine
        )
      + et.button('Dar seguimiento a mi aplicación', link)
      + et.divider()
      + et.small('Si no reconoces esta aplicación, ignora este correo o respóndenos para que la archivemos.'),
  });
}

// ══════════════════════════════════════════════════════════════════
// ── GET /track-token  — Magic-link tracker (B3) ──────────────────
// ══════════════════════════════════════════════════════════════════
// Anonymous applicants receive an email link of the form
//   ${BASE_URL}/track.html?token=<JWT>
// That page calls this endpoint to fetch the application detail keyed
// solely on the JWT — no userAuth required. Token `kind` MUST be
// 'track'.
//
// IMPORTANT: this route is registered HERE, before the `GET /:id`
// handler later in the file. Otherwise `/track-token` would match
// `/:id`, hit `userAuth`, and 401 the public tracker page. The
// tradeoff is that the route lives outside the "append at end"
// region used by other audit items — no sibling worktree touches
// this header range so the merge stays clean.
router.get('/track-token', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Token requerido.' });

  let payload;
  try {
    payload = verifyJwtAcceptingPrev(token);
  } catch (e) {
    return res.status(401).json({ error: 'Enlace inválido o expirado.' });
  }
  if (!payload || payload.kind !== 'track' || !payload.aid) {
    return res.status(401).json({ error: 'Enlace inválido.' });
  }

  const app = store.getApplicationById(payload.aid);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada.' });

  // Magic-link recipients get a buyer-scrubbed view: no internal events,
  // no commission block, no server-side file paths, no broker contact
  // channels, no decrypted co-applicant PII. The link can be forwarded
  // and is indexed in mail provider logs, so we minimize the footprint.
  res.json(scrubForBuyer(decryptAppPII(app)));
});

// ══════════════════════════════════════════════════════════════════
// ── POST /:id/track-upload — Magic-link document upload (P1 #24) ─
// ══════════════════════════════════════════════════════════════════
// Anonymous applicants who deferred documents on the apply form had no
// way to attach them later — the regular /:id/documents/upload route
// requires a logged-in client. This route accepts the same magic-link
// bearer token used by GET /track-token + the standard `docUpload.array`
// middleware so anon users can upload from the public track.html page.
//
// Auth: Authorization: Bearer <jwt> where the JWT was issued by
// `signTrackToken(applicationId)`. The token's `kind` MUST be 'track'
// AND `aid` MUST equal the route's :id.
//
// File-handling parity with /:id/documents/upload:
//   • multer disk storage in DOCS_DIR
//   • magic-byte MIME sniff via validateMime
//   • appended to app.documents_uploaded with review_status: 'pending'
//
// Mutation goes through `claimApplicationAtomic` to avoid losing writes
// when the buyer uploads multiple files in quick succession.
//
// NOTE FOR public/track.html: a follow-up agent will wire the UI. This
// endpoint expects multipart/form-data with the file under field name
// `files`, the bearer token in the Authorization header, plus optional
// `type` / `label` / `request_id` fields mirroring /documents/upload.
router.post('/:id/track-upload', docUpload.array('files', 10), async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(404).json({ error: 'Aplicación no encontrada.' });
  }

  const authHeader = req.headers.authorization || '';
  const cookieTok  = req.cookies?.hrdt;
  const bearer     = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (cookieTok || '');
  if (!bearer) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(401).json({ error: 'Token requerido.' });
  }

  let payload;
  try {
    payload = verifyJwtAcceptingPrev(bearer);
  } catch (_) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
  if (!payload || payload.kind !== 'track' || !payload.aid) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(401).json({ error: 'Token inválido.' });
  }
  if (payload.aid !== req.params.id) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(403).json({ error: 'Token no corresponde a esta aplicación.' });
  }

  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No se recibieron archivos.' });
  }

  // Validate MIME types — same gate as /:id/documents/upload.
  for (const f of req.files) {
    const ok = await validateMime(f.path);
    if (!ok) {
      req.files.forEach(x => { if (x.path !== f.path) fs.unlink(x.path, () => {}); });
      return res.status(400).json({
        error: `Tipo de archivo no permitido: ${f.originalname}. Formatos aceptados: JPG, PNG, HEIC, PDF, DOC(X), XLS(X), TXT, CSV.`,
      });
    }
  }

  const requestId = req.body.request_id || null;
  const docType   = String(req.body.type  || 'other').slice(0, 50);
  const docLabel  = String(req.body.label || DOCUMENT_TYPES[docType] || 'Documento').slice(0, 120);

  const uploaded = req.files.map(f => ({
    id:            uuid(),
    request_id:    requestId,
    type:          docType,
    label:         docLabel,
    filename:      f.filename,
    path:          f.path,
    original_name: f.originalname,
    size:          f.size,
    uploaded_at:   new Date().toISOString(),
    via_track:     true, // flag so the broker UI can show "subido vía enlace público"
    review_status: 'pending',
    review_note:   '',
    reviewed_at:   null,
    reviewed_by:   null,
  }));

  try {
    await store.claimApplicationAtomic(
      req.params.id,
      app.updated_at || null,
      async (current /*, client */) => {
        if (!Array.isArray(current.documents_uploaded)) current.documents_uploaded = [];
        current.documents_uploaded.push(...uploaded);
        addEvent(current, 'document_uploaded',
          `${uploaded.length} documento(s) subido(s) vía enlace público: ${uploaded.map(d => d.original_name).join(', ')}`,
          'magic-link', current.client?.name || 'Cliente (enlace)',
          { files: uploaded.map(d => d.original_name), via: 'track_token' });
      }
    );
    return res.json({ ok: true, uploaded: uploaded.length });
  } catch (err) {
    if (err && err.name === 'ConflictError') {
      req.files.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(409).json({ error: 'Conflicto al guardar la aplicación. Intenta de nuevo.' });
    }
    console.error('[applications/track-upload] failed:', err.message);
    req.files.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(500).json({ error: 'No se pudo guardar la subida. Inténtalo de nuevo.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── POST /  — Create application ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// optionalAuth so the endpoint stays public (anonymous applies are a
// real product feature) but, when an authenticated session IS present,
// we can derive the client identity from req.user.sub. The previous
// behavior of trusting req.body.user_id let an anonymous attacker
// attribute an application to any victim's account; that attribution
// is now ignored in favor of the JWT-verified subject.
router.post('/', appCreateLimiter, optionalAuth, async (req, res) => {
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
  // Basic age sanity (must be 18+ and not in the future).
  // Anchor the parsed date at noon to dodge timezone edge cases — a
  // date-string parsed as UTC midnight can land on the previous day
  // in DR (UTC-4). The 18-year check uses calendar-day arithmetic
  // (this-year-vs-(birth-year+18)) so leap years and any TZ offset
  // resolve correctly, instead of hand-rolled `365.25` math.
  const dob = new Date(dobRaw + 'T12:00:00');
  if (isNaN(dob.getTime()) || dob > new Date())
    return res.status(400).json({ error: 'Fecha de nacimiento inválida (paso 2).' });
  const eighteenth = new Date(dob.getFullYear() + 18, dob.getMonth(), dob.getDate());
  if (eighteenth > new Date())
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
  // Two-layer guard:
  //   1. Cache scan finds rows already committed (catches retries that
  //      fire AFTER the first transaction resolved).
  //   2. `_recentSubmits` claim is acquired BEFORE the cache scan so two
  //      simultaneous in-flight requests (the actual race) can't both
  //      pass — the second request sees the in-process key and bails.
  // The claim is released after `withTransaction` resolves (or 60s,
  // whichever comes first via the TTL).
  let _idemKey = null;
  if (emailTrimmed) {
    _idemKey = `${listing_id}|${emailTrimmed.toLowerCase()}`;
    const claimed = _claimRecentSubmit(_idemKey);
    if (!claimed) {
      // A concurrent request is already in flight for this key. Look up
      // any row it may have already committed; if not yet visible, return
      // an `accepted`-shaped response so the client treats it as a dup.
      const existing = (store.getApplications() || []).find(a =>
        a.listing_id === listing_id
        && a.client && a.client.email && a.client.email.toLowerCase() === emailTrimmed.toLowerCase()
      );
      if (existing) {
        return res.status(200).json({ id: existing.id, duplicate: true });
      }
      return res.status(202).json({ id: null, duplicate: true, accepted: true });
    }

    const sixtySecondsAgo = Date.now() - 60 * 1000;
    const existing = (store.getApplications() || []).find(a =>
      a.listing_id === listing_id
      && a.client && a.client.email && a.client.email.toLowerCase() === emailTrimmed.toLowerCase()
      && a.created_at && new Date(a.created_at).getTime() >= sixtySecondsAgo
    );
    if (existing) {
      _releaseRecentSubmit(_idemKey);
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

  // Commit the new application row inside a real transaction BEFORE we
  // respond 201. Previously the save was fire-and-forget via the pool, so
  // a failed pg INSERT would silently leave the cache populated while the
  // DB stayed empty — pm2 reload then lost the row entirely. The
  // transactional path mirrors the PUT /:id/status pattern.
  try {
    await store.withTransaction(async (client) => {
      await store.saveApplication(app, client);
    });
  } catch (err) {
    console.error('[applications/create] transaction failed:', err.message);
    if (_idemKey) _releaseRecentSubmit(_idemKey);
    return res.status(500).json({ error: 'No se pudo registrar la aplicación. Inténtalo de nuevo.' });
  }
  // Best-effort: release the idempotency claim so a third (legitimate)
  // retry can succeed sooner than the 60s TTL. The TTL is the safety net.
  if (_idemKey) _releaseRecentSubmit(_idemKey);

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
        try {
          await store.withTransaction(async (client) => {
            await store.saveApplication(app, client);
          });
        } catch (err) {
          console.error('[applications/create] cascade-fallback save failed:', err.message);
          // Initial create already committed; assignment will be retried by
          // the next write touching this row. Don't fail the response.
        }
      }
    }

    // Broker assignment is now final — respond.
    res.status(201).json({ ok: true, id: app.id });

    // ── Buyer confirmation email (B3 anon / B4 logged-in) ────────
    if (app.client.email) {
      try {
        const isAnon = !app.client.user_id;
        const link = isAnon
          ? `${BASE_URL}/track.html?token=${signTrackToken(app.id)}`
          : `${BASE_URL}/my-applications?id=${app.id}`;
        sendNotification(
          app.client.email,
          `Recibimos tu aplicación — ${app.listing_title}`,
          buyerConfirmationHtml(app, link),
          { app, purpose: 'buyer_confirmation' }
        );
      } catch (e) {
        console.error('[applications/create] buyer confirmation send failed:', e.message);
      }
    }

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

      // ── ADMIN FALLBACK is hoisted out of this branch so the
      //    non-cascade path (no resolvable agency, cascade disabled)
      //    also fires it. See the post-branch block below.
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

    // ── Buyer confirmation email (B3 anon / B4 logged-in) ────────
    if (app.client.email) {
      try {
        const isAnon = !app.client.user_id;
        const link = isAnon
          ? `${BASE_URL}/track.html?token=${signTrackToken(app.id)}`
          : `${BASE_URL}/my-applications?id=${app.id}`;
        sendNotification(
          app.client.email,
          `Recibimos tu aplicación — ${app.listing_title}`,
          buyerConfirmationHtml(app, link),
          { app, purpose: 'buyer_confirmation' }
        );
      } catch (e) {
        console.error('[applications/create] buyer confirmation send failed:', e.message);
      }
    }

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

  // ══════════════════════════════════════════════════════════════════
  // ── ORPHAN FALLBACK (P1 #20) ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════
  // Fires regardless of which branch ran above. The cascade path used
  // to own this exclusively, but a non-cascade submission with no
  // resolvable agency (e.g. cascade disabled, agencies array empty,
  // or every agency without a registered user) would silently drop
  // the lead. By hoisting here we guarantee the admin always learns
  // about a truly unassigned application — even if the in-cascade
  // inmobiliaria notification ALSO fired.
  if (!app.broker?.user_id && !app.inmobiliaria_id) {
    try {
      const adminEmail = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';
      console.warn(`[applications] ORPHANED LEAD: app ${app.id} — no resolvable agent or inmobiliaria for ${app.listing_title}`);
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
      try {
        await store.withTransaction(async (client) => {
          await store.saveApplication(app, client);
        });
      } catch (saveErr) {
        // Best-effort save outside the txn so the cache picks up the event.
        try { store.saveApplication(app); } catch (_) {}
        console.error('[applications/create] orphan-fallback save failed:', saveErr.message);
      }
    } catch (e) {
      console.error('[applications/create] orphan fallback failed:', e.message);
    }
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

  const { status, include_archived, include_stale } = req.query;
  if (status) apps = apps.filter(a => a.status === status);
  // C7: archived/stale apps are hidden from the default list. Pass
  // ?include_archived=1 / ?include_stale=1 to opt them back in.
  if (include_archived !== '1' && include_archived !== 'true') {
    apps = apps.filter(a => a.archived !== true);
  }
  if (include_stale !== '1' && include_stale !== 'true') {
    apps = apps.filter(a => a.stale !== true);
  }

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
  // Gate by emailVerified — otherwise registering with someone else's
  // leaked email would let an attacker claim their submitted apps.
  if (user.email && user.emailVerified === true) {
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
  // scrubForBuyer because /my is buyer-only by design — no internal
  // events, commission, broker contact channels, etc. should leak into
  // the client's list view (decryptAppPII handles encrypted PII but
  // does not strip internal timeline events).
  const enriched = apps.map(a => {
    const dec = scrubForBuyer(decryptAppPII(a));
    const listing = a.listing_id ? store.getListingById(a.listing_id) : null;
    const images = Array.isArray(listing?.images) ? listing.images : [];
    return {
      ...dec,
      listing_image: images[0]?.url || images[0] || null,
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

// ── GET /notification-failures  — Admin-only cross-app digest ────
// Lists applications that have non-empty `notification_failures`
// arrays so an admin can see which clients didn't actually receive
// the emails the platform thought it sent. Registered BEFORE the
// `/:id` param route so it isn't shadowed.
router.get('/notification-failures', userAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin' });
  const apps = store.getApplications();
  const out = [];
  for (const app of apps) {
    const failures = Array.isArray(app.notification_failures) ? app.notification_failures : [];
    if (!failures.length) continue;
    out.push({
      application_id: app.id,
      listing_title:  app.listing_title || '',
      client_name:    app.client?.name || '',
      broker_name:    app.broker?.name || '',
      inmobiliaria_id: app.inmobiliaria_id || null,
      failures,
    });
  }
  // Most-recent failure first across all apps
  out.sort((a, b) => {
    const at = a.failures[a.failures.length - 1]?.failed_at || '';
    const bt = b.failures[b.failures.length - 1]?.failed_at || '';
    return bt.localeCompare(at);
  });
  res.json(out);
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
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';

  if (!isBroker && !isInmobiliaria && !isSecretary && !isClient && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // C1: pure clients get a buyer-scrubbed view (no internal events,
  // no commission, no server file paths, no broker contact channels,
  // no decrypted co-applicant PII). Brokers/owners/admins see all.
  const decoded = decryptAppPII(app);
  const isPureClient = isClient && !isBroker && !isInmobiliaria && !isSecretary && !admin;
  res.json(isPureClient ? scrubForBuyer(decoded) : decoded);
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
// `client` is an optional 2nd arg — when invoked inside `withTransaction`,
// the route passes the pg client so the underlying saveApplication write
// joins the surrounding BEGIN/COMMIT and the function returns the query
// promise for the caller to await.
function saveApplicationEncryptingFinancials(app, client) {
  const clone = JSON.parse(JSON.stringify(app));
  encryptFinancials(clone);
  return store.saveApplication(clone, client);
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
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
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

  // C1: pure clients should not see internal events even at the SSE
  // envelope level (last_event_type/at would otherwise leak the fact
  // that the broker just filed an internal note).
  const isPureClient = isClient && !isBroker && !isInmobiliaria && !isSecretary && !admin;
  const visibleEvents = (a) => {
    const all = a.timeline_events || [];
    if (!isPureClient) return all;
    return all.filter(ev => !(ev && (ev.is_internal === true || ev.data?.is_internal === true)));
  };

  // Build an envelope that matches the /state endpoint response so
  // iOS can decode both with the same Decodable.
  const buildEnvelope = (a) => {
    const lastEvent = visibleEvents(a).slice(-1)[0];
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
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !isClient && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Compute a cheap version key from the fields that matter. Any
  // change to the status, last timeline event, uploaded doc count,
  // or payment state bumps the hash, so the client can compare and
  // decide whether to re-fetch the full detail.
  //
  // C1: pure clients must not see metadata for is_internal events —
  // otherwise a polling buyer can detect that the broker just filed
  // an internal note (last_event_type/at/version would all change)
  // even though they can't read the body. Filter first, then compute.
  const isPureClient = isClient && !isBroker && !isInmobiliaria && !isSecretary && !admin;
  const allEvents = app.timeline_events || [];
  const visibleEvents = isPureClient
    ? allEvents.filter(ev => !(ev && (ev.is_internal === true || ev.data?.is_internal === true)))
    : allEvents;
  const lastEvent = visibleEvents.slice(-1)[0];
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

// ── GET /:id/notification-failures  — Per-app delivery audit ─────
// Returns the list of failed notifications recorded by
// recordNotificationFailure(), so the broker can see which emails
// to the client / counterparty silently failed and follow up.
// Same auth surface as GET /:id (broker, owner inmobiliaria,
// secretary, admin).
router.get('/:id/notification-failures', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  res.json({ failures: Array.isArray(app.notification_failures) ? app.notification_failures : [] });
});

// ══════════════════════════════════════════════════════════════════
// ── PUT /:id/status  — Change status ─────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.put('/:id/status', userAuth, async (req, res) => {
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

  // ── D2: approval-delegation gate ────────────────────────────
  // Critical-stage transitions (`aprobado`, `completado`) require an
  // owner-level (Director, access_level=3) actor. Secretaries are
  // ALWAYS blocked. Other team members (Asistente / Agente) under an
  // inmobiliaria are also blocked when their access level is below 3 —
  // OWNER_ACCESS_LEVEL_LIMIT returns 3 for inmobiliaria/constructora/admin
  // owners and the user's access_level (default 1) for everyone else
  // affiliated to an inmobiliaria. Admins are exempt.
  if (['aprobado', 'completado'].includes(status)) {
    const isLowAccessTeam = user?.role !== 'admin' && user?.inmobiliaria_id &&
                            OWNER_ACCESS_LEVEL_LIMIT(user) < 3;
    if (user?.role === 'secretary' || isLowAccessTeam) {
      return res.status(403).json({
        error: 'Necesitas autorización del propietario para aprobar esta etapa.',
        code:  'requires_escalation',
      });
    }
  }

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

  // Reject reason length parity with skip-phase / bulk reject — at least
  // 5 characters of explanation so the timeline event is meaningful.
  if (status === 'rechazado') {
    const trimmedReason = (reason || '').toString().trim();
    if (trimmedReason.length < 5) {
      return res.status(400).json({
        error: 'Se requiere una razón (mínimo 5 caracteres) para rechazar.',
      });
    }
  }

  const oldStatus = app.status;

  // Atomic status mutation: SELECT … FOR UPDATE on the app row, run the
  // mutation, save inside the same txn. Two simultaneous writers (e.g.
  // owner approves while broker rejects) can no longer both succeed.
  let claimed;
  try {
    claimed = await store.claimApplicationAtomic(req.params.id, app.updated_at || null, async (a, client) => {
      a.status = status;
      a.status_reason = reason || '';

      if (status === 'rechazado') {
        // applyRejection writes the status_change event with the right
        // wording AND voids commission + releases inventory inside the
        // same transaction.
        await applyRejection(a, {
          reason,
          actorId:   req.user.sub,
          actorName: user?.name || 'Broker',
          client,
          bulk:      false,
        });
      } else {
        addEvent(a, 'status_change',
          `Estado cambiado a ${STATUS_LABELS[status]}${reason ? ': ' + reason : ''}`,
          req.user.sub, user?.name || 'Broker',
          { from: oldStatus, to: status, reason });
      }
    });
  } catch (err) {
    if (err instanceof store.ConflictError) {
      return res.status(409).json({ error: 'La aplicación fue actualizada por otra persona; recarga.' });
    }
    throw err;
  }

  // Refresh local reference to the post-mutation row for downstream
  // side-effects (notifications, push, inventory sync on completado).
  Object.assign(app, claimed);

  // D2 + P1 #26: targeted clear. Only remove pending-approval rows
  // whose `requested_status` matches the status just applied — those
  // are now resolved by this transition. Other pending recommendations
  // for unrelated future statuses must survive (e.g. a secretary
  // recommending `completado` should NOT be wiped by an unrelated
  // `aplicado → en_revision` flip). Each cleared row gets a
  // `pending_approval_dismissed` event so the timeline shows the
  // resolution.
  try {
    const pendings = (typeof store.getPendingApprovalsForApp === 'function')
      ? store.getPendingApprovalsForApp(app.id)
      : [];
    const matched = pendings.filter(p => p && p.requested_status === status);
    for (const p of matched) {
      try { store.removePendingApproval(p.id); } catch {}
      addEvent(app, 'pending_approval_dismissed',
        `Aprobación pendiente resuelta por el cambio de estado a ${STATUS_LABELS[status] || status}`,
        req.user.sub, user?.name || 'Sistema',
        { approval_id: p.id, requested_status: p.requested_status, requested_by: p.requested_by });
    }
    if (matched.length > 0) {
      // Persist the dismissal events.
      store.saveApplication(app);
    }
  } catch (_) { /* best-effort */ }

  // ── Cancel pending tasks on terminal statuses ─────────────────
  if (status === 'rechazado' || status === 'completado') {
    const allEvents = ['documents_requested', 'documents_rejected', 'document_uploaded',
                       'payment_plan_created', 'payment_uploaded', 'payment_rejected', 'receipt_ready'];
    for (const evt of allEvents) autoCompleteTasksByEvent(app.id, evt);
  }

  // ── D3: auto-assign a unit on completado when none was reserved ──
  // The constructora workflow normally reserves a unit at `reservado`
  // and flips it to `sold` here, but some teams skip the reservation
  // step (manual sales, off-platform deals). On `completado` with no
  // pre-reserved unit, grab the first available unit from the
  // listing's inventory so the constructora's stock count stays
  // accurate. Logged via `completed_without_unit` when stock is empty.
  if (status === 'completado' && !app.assigned_unit?.unitId && app.listing_id) {
    try {
      await store.withTransaction(async (client) => {
        const listing = store.getListingById(app.listing_id);
        if (listing && Array.isArray(listing.unit_inventory) && listing.unit_inventory.length) {
          const unit = listing.unit_inventory.find(u => u.status === 'available');
          if (unit) {
            unit.status        = 'sold';
            unit.applicationId = app.id;
            unit.clientName    = app.client_name || app.client?.name || '';
            listing.units_available = listing.unit_inventory.filter(u => u.status === 'available').length;
            await store.saveListing(listing, client);

            app.assigned_unit = { unitId: unit.id, unitLabel: unit.label, unitType: unit.type };
            addEvent(app, 'unit_auto_assigned',
              `Unidad ${unit.label} asignada automáticamente al completar la venta`,
              'system', 'Sistema', { unit_id: unit.id, unit_label: unit.label });
            await store.saveApplication(app, client);
          } else {
            addEvent(app, 'completed_without_unit',
              'Aplicación completada sin unidad asignada — inventario agotado',
              'system', 'Sistema', { listing_id: listing.id, reason: 'inventory_exhausted' });
            await store.saveApplication(app, client);
          }
        }
      });
    } catch (e) {
      console.error('[inventory] Auto-assign on completed error:', e.message);
      recordInventorySyncFailure(app, e, null);
    }
  }

  // ── Auto-update unit inventory on status change ────────────────
  // Status change touches three rows (application, listing,
  // unit_inventory inside listing) and used to do them as three
  // fire-and-forget writes — a partial failure could leave the unit
  // marked sold while the application stayed pending. Wrap in a real
  // transaction so the writes either all land or roll back together.
  // The outer try/catch still records failures via
  // recordInventorySyncFailure so the workflow continues — the
  // inventory side-effect is best-effort, not blocking, by design.
  //
  // Note: rechazado is handled inside applyRejection() above (releases
  // the unit and clears app.assigned_unit inside the claim txn) — the
  // block here only covers completado / reservado / aprobado.
  if (status !== 'rechazado' && app.assigned_unit?.unitId && app.listing_id) {
    const targetUnitId = app.assigned_unit.unitId;
    try {
      await store.withTransaction(async (client) => {
        const listing = store.getListingById(app.listing_id);
        if (listing && Array.isArray(listing.unit_inventory)) {
          const unit = listing.unit_inventory.find(u => u.id === targetUnitId);
          if (unit) {
            if (status === 'completado') {
              unit.status = 'sold';
            } else if (['reservado', 'aprobado'].includes(status)) {
              unit.status = 'reserved';
              unit.applicationId = app.id;
              unit.clientName = app.client_name || app.client?.name || '';
            }
            listing.units_available = listing.unit_inventory.filter(u => u.status === 'available').length;
            await store.saveListing(listing, client);
          }
        }
      });
    } catch (e) {
      console.error('[inventory] Auto-update error:', e.message);
      recordInventorySyncFailure(app, e, targetUnitId);
    }
  }

  // Notify client via email
  if (app.client.email) {
    const email = statusEmail(app, oldStatus, status, reason);
    sendNotification(app.client.email, email.subject, email.html, { app, purpose: 'status_change' });
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
// ── POST /:id/skip-phase  — Broker overrides client_auto stage ──
// ══════════════════════════════════════════════════════════════════
//
// The generic PUT /:id/status only lets the broker advance into
// 'broker'-owned statuses; client_auto statuses (documentos_enviados,
// pago_enviado) are normally driven by the CLIENT uploading something.
// In practice brokers often have the docs/payment receipt off-platform
// (WhatsApp, in person, agency office), and being unable to advance
// without forcing a fake upload is a real friction.
//
// This endpoint is the audit-trailed escape hatch: target status MUST
// be in STATUS_FLOW for the current state, AND a non-trivial reason
// must be provided. Everything else (subscription gate, ownership
// validation, terminal-state guard, transition validation, status
// notifications) mirrors the regular PUT /:id/status.
router.post('/:id/skip-phase', userAuth, async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user           = store.getUserById(req.user.sub);
  const isBroker       = app.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary    = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin          = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Subscription re-check (same gate as PUT /:id/status).
  if (!admin && (isBroker || isInmobiliaria) && !isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'Tu suscripción no está activa. Renueva tu plan para continuar.',
      needsSubscription: true,
    });
  }

  if (['rechazado', 'completado'].includes(app.status))
    return res.status(400).json({ error: 'No se puede saltar etapas en una aplicación finalizada.' });

  const { status, reason } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status es requerido' });

  // ── D2: approval-delegation gate (parity with PUT /:id/status) ──
  // Skip-phase is the broker escape hatch; without this gate a
  // secretary or low-access team member could leapfrog `aprobado` /
  // `completado` from `en_aprobacion` and bypass owner approval. Same
  // shape and `requires_escalation` code so the client UI handles
  // both endpoints identically.
  if (['aprobado', 'completado'].includes(status)) {
    const isLowAccessTeam = user?.role !== 'admin' && user?.inmobiliaria_id &&
                            OWNER_ACCESS_LEVEL_LIMIT(user) < 3;
    if (user?.role === 'secretary' || isLowAccessTeam) {
      return res.status(403).json({
        error: 'Necesitas autorización del propietario para aprobar esta etapa.',
        code:  'requires_escalation',
      });
    }
  }

  const note = (reason || '').toString().trim();
  if (note.length < 5)
    return res.status(400).json({
      error: 'Se requiere un comentario explicando por qué se salta esta etapa (mínimo 5 caracteres).',
      code: 'note_required',
    });

  // No-op if already there.
  if (app.status === status) return res.json(decryptAppPII(app));

  // Block transitioning to 'rechazado' through this endpoint — that's a
  // separate gesture with its own UX (rejection zone).
  if (status === 'rechazado')
    return res.status(400).json({ error: 'Para rechazar la aplicación usa la zona de rechazo.' });

  const allowed = STATUS_FLOW[app.status];
  if (!allowed || !allowed.includes(status))
    return res.status(400).json({ error: `Transición no válida: ${app.status} → ${status}` });

  const oldStatus = app.status;

  // Atomic mutation — same OCC pattern as PUT /:id/status. Two skips
  // racing on the same app (or a skip racing a normal status change)
  // can no longer overwrite each other.
  let claimed;
  try {
    claimed = await store.claimApplicationAtomic(req.params.id, app.updated_at || null, async (a /* , client */) => {
      a.status = status;
      a.status_reason = note;
      addEvent(a, 'status_change',
        `Etapa saltada: ${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[status]} — ${note.slice(0, 200)}`,
        req.user.sub, user?.name || 'Agente',
        {
          from:        oldStatus,
          to:          status,
          reason:      note,
          manual_skip: true,
          skipped_by:  req.user.sub,
          skipped_role: user?.role || null,
        });
    });
  } catch (err) {
    if (err instanceof store.ConflictError) {
      return res.status(409).json({ error: 'La aplicación fue actualizada por otra persona; recarga.' });
    }
    throw err;
  }

  Object.assign(app, claimed);

  // Notify the client (same wording as PUT /:id/status — they don't
  // need to know it was skipped, just that the stage moved).
  if (app.client.email) {
    const email = statusEmail(app, oldStatus, status, note);
    sendNotification(app.client.email, email.subject, email.html, { app, purpose: 'skip_phase' });
  }
  if (app.client.user_id) {
    pushNotify(app.client.user_id, {
      type:  'status_changed',
      title: 'Estado Actualizado',
      body:  `Tu aplicación para ${app.listing_title} cambió a: ${STATUS_LABELS[status] || status}`,
      url:   `/my-applications?id=${app.id}`,
    });
  }

  res.json(decryptAppPII(app));
});

// ══════════════════════════════════════════════════════════════════
// ── DOCUMENTS ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── POST /:id/documents/request  — Broker requests documents ────
router.post('/:id/documents/request', userAuth, async (req, res) => {
  const initial = store.getApplicationById(req.params.id);
  if (!initial) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isSecretary = user?.role === 'secretary' && initial.inmobiliaria_id === user.inmobiliaria_id;
  if (initial.broker.user_id !== req.user.sub && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  // Block document requests on terminal statuses
  if (['rechazado', 'completado'].includes(initial.status))
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
    initial.documents_requested.filter(d => d.status === 'pending').map(d => d.type)
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

  let app;
  try {
    app = await store.claimApplicationAtomic(req.params.id, initial.updated_at || null, async (app /*, client */) => {
      app.documents_requested.push(...newDocs);
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
    });
  } catch (err) {
    if (err instanceof store.ConflictError) {
      return res.status(409).json({ error: 'La aplicación fue actualizada por otra persona; recarga.' });
    }
    throw err;
  }

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
  const initial = store.getApplicationById(req.params.id);
  if (!initial) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isClient = initial.client.user_id === req.user.sub ||
                   (user?.emailVerified === true && !initial.client.user_id && initial.client.email && user.email && initial.client.email.toLowerCase() === user.email.toLowerCase());
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

  // Match the corresponding documents_requested entry up-front so we
  // can stamp `required` (and `request_id`) onto each uploaded record.
  // This is belt-and-suspenders for the auto-status logic in the
  // review handler — that path now ALSO falls back to looking it up
  // by request_id/type, but copying it here means any future read can
  // tell at a glance whether a doc was required or optional.
  const matchedRequest = (() => {
    const reqs = initial.documents_requested || [];
    if (requestId) return reqs.find(d => d.id === requestId) || null;
    if (docType && docType !== 'other') {
      return reqs.find(d => d.type === docType && d.status === 'pending') || null;
    }
    return null;
  })();

  const uploaded = req.files.map(f => ({
    id:            uuid(),
    request_id:    requestId || (matchedRequest ? matchedRequest.id : null),
    type:          docType,
    required:      !!(matchedRequest && matchedRequest.required),
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

  let app, allFulfilled = false;
  try {
    app = await store.claimApplicationAtomic(req.params.id, initial.updated_at || null, async (app /*, client */) => {
      app.documents_uploaded.push(...uploaded);

      // Mark the request as fulfilled if linked
      if (requestId) {
        const docReq = app.documents_requested.find(d => d.id === requestId);
        if (docReq) docReq.status = 'uploaded';
      } else if (docType && docType !== 'other') {
        const docReq = app.documents_requested.find(d => d.type === docType && d.status === 'pending');
        if (docReq) docReq.status = 'uploaded';
      }

      // Auto-transition to documentos_enviados if all required docs have uploads
      const allRequired = app.documents_requested.filter(d => d.required);
      allFulfilled = allRequired.length > 0 && allRequired.every(d => d.status === 'uploaded');
      if (allFulfilled && STATUS_FLOW[app.status]?.includes('documentos_enviados')) {
        const old = app.status;
        app.status = 'documentos_enviados';
        addEvent(app, 'status_change', 'Todos los documentos requeridos han sido enviados',
          'system', 'Sistema', { from: old, to: 'documentos_enviados' });
      }

      addEvent(app, 'document_uploaded',
        `${uploaded.length} documento(s) subido(s): ${uploaded.map(d => d.original_name).join(', ')}`,
        req.user.sub, user?.name || app.client.name, { files: uploaded.map(d => d.original_name) });
    });
  } catch (err) {
    if (err instanceof store.ConflictError) {
      return res.status(409).json({ error: 'La aplicación fue actualizada por otra persona; recarga.' });
    }
    throw err;
  }

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
router.put('/:id/documents/:docId/review', userAuth, async (req, res) => {
  const initial = store.getApplicationById(req.params.id);
  if (!initial) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker    = initial.broker.user_id === req.user.sub;
  const isSecretary = user?.role === 'secretary' && initial.inmobiliaria_id === user.inmobiliaria_id;
  const admin       = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Subscription re-check: review endpoints are pro-only writes that
  // can drive app.status forward (rejected required doc → documentos_insuficientes).
  // Mirror the gate at PUT /:id/status so a lapsed broker can't push a
  // deal sideways via this surface.
  if (!admin && isBroker && !isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'Tu suscripcion no esta activa.',
      needsSubscription: true,
    });
  }

  const docInitial = initial.documents_uploaded.find(d => d.id === req.params.docId);
  if (!docInitial) return res.status(404).json({ error: 'Documento no encontrado' });

  const { status, note } = req.body; // 'approved' or 'rejected'
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status debe ser approved o rejected' });

  // Caller may pass the updated_at they observed (form-level optimistic
  // concurrency). Falls back to the server-side read if they didn't.
  const expectedUpdatedAt = (typeof req.body.expected_updated_at === 'string' && req.body.expected_updated_at)
    ? req.body.expected_updated_at
    : (initial.updated_at || null);

  let app, doc;
  try {
    app = await store.claimApplicationAtomic(req.params.id, expectedUpdatedAt, async (app /*, client */) => {
      doc = app.documents_uploaded.find(d => d.id === req.params.docId);
      if (!doc) throw new store.ConflictError('document_not_found');
      doc.review_status = status;
      doc.review_note   = (typeof note === 'string' ? note : '').slice(0, 1000);
      doc.reviewed_at   = new Date().toISOString();
      doc.reviewed_by   = req.user.sub;

      // Sync the corresponding documents_requested entry so the client
      // can re-upload against it (upload handler matches by status === 'pending').
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

      // Compute "required-doc rejected?" by joining each uploaded doc
      // back to its `documents_requested` row — historically the
      // upload handler didn't copy `required` onto the uploaded
      // record, so checking `d.required === true` directly silently
      // missed every legacy upload. We now stamp it at the upload
      // site, but the join here is the safety net for old rows.
      const requiredByRequestId = new Map(
        (app.documents_requested || []).map(r => [r.id, r])
      );
      const requiredByType = new Map();
      for (const r of (app.documents_requested || [])) {
        if (r && r.required && r.type) requiredByType.set(r.type, r);
      }
      const hasRejectedRequired = (app.documents_uploaded || []).some(d => {
        if (d.review_status !== 'rejected') return false;
        if (d.required === true) return true; // stamped at upload
        const matched = (d.request_id && requiredByRequestId.get(d.request_id))
          || (d.type && requiredByType.get(d.type));
        return !!(matched && matched.required);
      });
      if (hasRejectedRequired && STATUS_FLOW[app.status]?.includes('documentos_insuficientes')) {
        const old = app.status;
        app.status = 'documentos_insuficientes';
        addEvent(app, 'status_change', 'Documentos insuficientes — se requieren correcciones',
          req.user.sub, user?.name || 'Broker', { from: old, to: 'documentos_insuficientes' });
      }
    });
  } catch (err) {
    if (err instanceof store.ConflictError) {
      return res.status(409).json({ error: 'La aplicación fue actualizada por otra persona; recarga.' });
    }
    throw err;
  }

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
// E5: this endpoint deliberately DOES NOT honor the ?token= query
// fallback that userAuth permits for other GETs. Document URLs end up
// in browser history, server logs, and copy-paste contexts where a
// ?token= leaks the JWT. Callers must use the cookie or an
// `Authorization: Bearer …` header. Web should fetch as a blob and
// hand the blob URL to <img>; iOS should send the header and download
// to a sandbox-only URL.
function rejectQueryToken(req, res, next) {
  if (req.query && typeof req.query.token === 'string' && req.query.token.length > 0) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}
router.get('/:id/documents/:docId/file', rejectQueryToken, userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  const isClient = app.client.user_id === req.user.sub ||
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
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

// ── E4: Tour time helpers ───────────────────────────────────────
// Tours are stored as a single ISO 8601 string with the Dominican
// Republic offset baked in (-04:00). DR doesn't observe DST so the
// offset is constant year-round. Keeping `scheduled_date` and
// `scheduled_time` populated alongside `scheduled_at` is for
// backward compat — older clients that read those fields keep
// working in this same release.
const RD_OFFSET = '-04:00';

/** Take whatever the client sent and produce a canonical
 *  { scheduled_at, scheduled_date, scheduled_time } triple — or null
 *  if the input is unparseable. Accepts either:
 *    - { scheduled_at: '2026-05-15T14:00:00-04:00' }   (preferred)
 *    - { scheduled_at: '2026-05-15T14:00:00' }         (assumed RD)
 *    - { scheduled_date: '2026-05-15', scheduled_time: '14:00' }
 */
function normalizeTourTime({ scheduled_at, scheduled_date, scheduled_time }) {
  let isoLocal; // YYYY-MM-DDTHH:MM[:SS] without offset
  if (typeof scheduled_at === 'string' && scheduled_at.length > 0) {
    // Strip any trailing offset/Z so we can re-attach RD offset.
    const stripped = scheduled_at.replace(/(?:[Zz]|[+-]\d{2}:?\d{2})$/, '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(stripped)) return null;
    isoLocal = stripped.length === 16 ? stripped + ':00' : stripped;
  } else if (scheduled_date && scheduled_time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) return null;
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(scheduled_time)) return null;
    const t = scheduled_time.length === 5 ? scheduled_time + ':00' : scheduled_time;
    isoLocal = `${scheduled_date}T${t}`;
  } else {
    return null;
  }
  const iso = `${isoLocal}${RD_OFFSET}`;
  // Sanity-check: Date must parse it.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // Split for legacy fields.
  const [datePart, timePart] = isoLocal.split('T');
  return {
    scheduled_at:   iso,
    scheduled_date: datePart,
    scheduled_time: timePart.slice(0, 5),
    asDate:         d,
  };
}

// ── POST /:id/tours  — Schedule tour ─────────────────────────────
router.post('/:id/tours', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  if (app.broker.user_id !== req.user.sub && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { location, notes } = req.body;
  const norm = normalizeTourTime(req.body || {});
  if (!norm)
    return res.status(400).json({ error: 'Fecha y hora son requeridos' });
  if (norm.asDate < new Date())
    return res.status(400).json({ error: 'No se puede programar una visita en el pasado' });

  const user = store.getUserById(req.user.sub);
  // Cap free-text tour fields so a malicious client can't blow up
  // emails / event log / push payloads with a multi-MB `notes`. 500
  // chars covers any real "buzz top floor, parking spot 4B" detail
  // and matches the cap pattern at the payment-plan installment site.
  const safeLocation = String(location || app.listing_title || '').trim().slice(0, 500);
  const safeNotes    = String(notes    || '').trim().slice(0, 500);
  const tour = {
    id:             uuid(),
    scheduled_at:   norm.scheduled_at,
    scheduled_date: norm.scheduled_date, // legacy; same source as scheduled_at
    scheduled_time: norm.scheduled_time, // legacy; same source as scheduled_at
    location:       safeLocation,
    notes:          safeNotes,
    status:         'scheduled',
    created_at:     new Date().toISOString(),
    completed_at:   null,
  };

  app.tours.push(tour);
  addEvent(app, 'tour_scheduled',
    `Tour programado para ${norm.scheduled_date} a las ${norm.scheduled_time} (Hora RD)`,
    req.user.sub, user?.name || 'Broker',
    { tour_id: tour.id, scheduled_at: tour.scheduled_at });

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
            <div style="font-size:1.3rem;font-weight:800;color:#0038A8;">${norm.scheduled_date}</div>
            <div style="font-size:1rem;color:#4d6a8a;">${norm.scheduled_time} (Hora RD)</div>
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
  const { status, scheduled_date, scheduled_time, scheduled_at, notes } = req.body;

  // E4: any time-related field triggers a re-normalization. Fall back
  // to existing tour values for the missing half so a partial update
  // (just date OR just time) still produces a coherent ISO.
  if (scheduled_at || scheduled_date || scheduled_time) {
    const norm = normalizeTourTime({
      scheduled_at,
      scheduled_date: scheduled_date || tour.scheduled_date,
      scheduled_time: scheduled_time || tour.scheduled_time,
    });
    if (!norm) return res.status(400).json({ error: 'Formato de fecha u hora inválido' });
    tour.scheduled_at   = norm.scheduled_at;
    tour.scheduled_date = norm.scheduled_date;
    tour.scheduled_time = norm.scheduled_time;
  }
  if (notes !== undefined) tour.notes = String(notes || '').trim().slice(0, 500);
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
  const initial = store.getApplicationById(req.params.id);
  if (!initial) return res.status(404).json({ error: 'Aplicación no encontrada' });

  // If a payment plan exists, use the installment upload instead
  if (initial.payment_plan && initial.payment_plan.installments?.length > 0) {
    return res.status(400).json({ error: 'Esta aplicación tiene un plan de pagos. Suba el comprobante en la cuota correspondiente.' });
  }

  const user = store.getUserById(req.user.sub);
  const isClient = initial.client.user_id === req.user.sub ||
                   (user?.emailVerified === true && !initial.client.user_id && initial.client.email && user.email && initial.client.email.toLowerCase() === user.email.toLowerCase());
  const isBroker = initial.broker.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && initial.inmobiliaria_id === user.id;
  const isSecretary = user?.role === 'secretary' && initial.inmobiliaria_id === user.inmobiliaria_id;
  if (!isClient && !isBroker && !isInmobiliaria && !isSecretary && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  if (!req.file) return res.status(400).json({ error: 'Recibo es requerido' });

  // Block upload if a receipt is already pending verification
  if (initial.payment?.verification_status === 'pending')
    return res.status(400).json({ error: 'Ya tienes un recibo pendiente de revisión. Espera la verificación antes de subir otro.' });

  // Block re-upload after payment was already approved
  if (initial.payment?.verification_status === 'approved')
    return res.status(400).json({ error: 'El pago ya fue aprobado.' });

  // ── Cheap validations first ──────────────────────────────────────
  // Currency / amount / notes are all pure-string checks — do them
  // BEFORE the MIME magic-byte sniff so an obviously-invalid request
  // (BTC currency, negative amount, etc) doesn't burn disk I/O. Any
  // of these failing also means we can short-circuit before the
  // claimApplicationAtomic transaction below.

  const paymentAmount = Number(req.body.amount) || Number(initial.listing_price) || 0;
  if (paymentAmount <= 0) return res.status(400).json({ error: 'Monto de pago inválido' });

  // Currency: whitelist DOP / USD. If the client sent nothing, fall
  // back to the listing's currency, then to the existing payment
  // currency, then to DOP — preserves the previous default.
  const rawCurrency = (req.body.currency || '').toString().trim().toUpperCase();
  let paymentCurrency;
  if (rawCurrency) {
    if (!VALID_CURRENCIES.includes(rawCurrency)) {
      return res.status(400).json({ error: 'Moneda inválida (DOP o USD).' });
    }
    paymentCurrency = rawCurrency;
  } else {
    const listing = store.getListingById(initial.listing_id);
    paymentCurrency = (listing?.currency && VALID_CURRENCIES.includes(listing.currency))
      ? listing.currency
      : (initial.payment?.currency && VALID_CURRENCIES.includes(initial.payment.currency))
        ? initial.payment.currency
        : 'DOP';
  }

  // Cap payment notes so an attacker can't push a multi-MB string
  // into the receipt record (which is rendered into broker emails
  // and the timeline event log).
  const paymentNotes = String(req.body.notes || '').trim().slice(0, 1000);

  // Validate MIME type via magic bytes — runs LAST among gates so
  // we don't pay file-type cost on requests that are going to bounce
  // for a body-shape reason.
  if (!(await validateMime(req.file.path)))
    return res.status(400).json({ error: 'Tipo de archivo no permitido. Formatos aceptados: JPG, PNG, HEIC, PDF, DOC(X), XLS(X), TXT, CSV.' });

  let app;
  try {
    app = await store.claimApplicationAtomic(req.params.id, initial.updated_at || null, async (app /*, client */) => {
      if (!app.payment) app.payment = {};
      app.payment.receipt_path = req.file.path;
      app.payment.receipt_filename = req.file.filename;
      app.payment.receipt_original = req.file.originalname;
      app.payment.receipt_uploaded_at = new Date().toISOString();
      app.payment.amount = paymentAmount;
      app.payment.currency = paymentCurrency;
      app.payment.verification_status = 'pending';
      app.payment.notes = paymentNotes;

      if (STATUS_FLOW[app.status]?.includes('pago_enviado')) {
        const old = app.status;
        app.status = 'pago_enviado';
        addEvent(app, 'status_change', 'Recibo de pago enviado', 'system', 'Sistema',
          { from: old, to: 'pago_enviado' });
      }

      addEvent(app, 'payment_uploaded', `Recibo de pago subido: ${req.file.originalname}`,
        req.user.sub, user?.name || app.client.name,
        { filename: req.file.originalname, uploaded_by_role: isClient ? 'client' : 'agent' });
    });
  } catch (err) {
    if (err instanceof store.ConflictError) {
      return res.status(409).json({ error: 'La aplicación fue actualizada por otra persona; recarga.' });
    }
    throw err;
  }

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
router.put('/:id/payment/verify', userAuth, async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker    = app.broker.user_id === req.user.sub;
  const isSecretary = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin       = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  // Subscription re-check: payment verification flips app.status
  // forward (pago_aprobado) and emits client notifications, so it must
  // honor the same gate as PUT /:id/status. Defense-in-depth for the
  // case where the route-level middleware ever changes shape.
  if (!admin && isBroker && !isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'Tu suscripcion no esta activa.',
      needsSubscription: true,
    });
  }

  const { approved, notes } = req.body;

  // Wrap the multi-field state mutation + persistence in a single transaction
  // so payment-verification status, application status flip, timeline events,
  // and the final saveApplication either all land or all roll back together.
  // Previously a partial DB failure could leave verification_status approved
  // while app.status remained pendiente_pago.
  try {
    await store.withTransaction(async (client) => {
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

      await store.saveApplication(app, client);
    });
  } catch (err) {
    console.error('[payment/verify] transaction failed:', err.message);
    return res.status(500).json({ error: 'Error al verificar el pago' });
  }

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
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
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
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
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
// C1 (option b): the same endpoint accepts an `is_internal` flag so the
// broker can use it for internal notes. When `is_internal === true`,
// the event is tagged and filtered out of the response shown to clients
// (see GET /:id and GET /:id/events).
router.post('/:id/message', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isBroker = app.broker.user_id === req.user.sub;
  // P1 #33: secretaries and inmobiliaria/constructora owners on the same
  // team must be able to post on team applications. Auth surface mirrors
  // /:id/contact-client semantics. Internal-note privileges propagate to
  // these team roles too.
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const isSecretary    = user?.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const isClient = app.client.user_id === req.user.sub ||
                   (user?.emailVerified === true && !app.client.user_id && app.client.email && user.email && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isBroker && !isInmobiliaria && !isSecretary && !isClient && !isAdmin(req))
    return res.status(403).json({ error: 'No autorizado' });

  const { message, is_internal } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje es requerido' });

  // Internal notes: any team-side actor (broker, inmobiliaria, secretary,
  // admin) can flag a message internal. Clients always get coerced to false.
  const isTeamActor = isBroker || isInmobiliaria || isSecretary || isAdmin(req);
  const internal = !!is_internal && isTeamActor;

  const senderRole = isTeamActor ? 'broker' : 'client';
  addEvent(app, 'message', message,
    req.user.sub, user?.name || (isTeamActor ? 'Broker' : app.client.name),
    { role: senderRole, is_internal: internal });

  // Mark the event itself with the flag for fast filtering in GET handlers.
  if (internal && app.timeline_events && app.timeline_events.length) {
    app.timeline_events[app.timeline_events.length - 1].is_internal = true;
  }

  store.saveApplication(app);

  // Internal notes never sync to conversations or notify the client.
  if (internal) {
    return res.json(decryptAppPII(app));
  }

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
      senderName: user?.name || (isTeamActor ? 'Broker' : app.client.name),
      text:       message,
      timestamp:  new Date().toISOString(),
    };
    if (conv) {
      store.addMessage(conv.id, msgObj);
      conv.lastMessage = message;
      conv.updatedAt   = new Date().toISOString();
      if (isTeamActor) conv.unreadClient = (conv.unreadClient || 0) + 1;
      else             conv.unreadBroker = (conv.unreadBroker || 0) + 1;
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
        unreadBroker:   isTeamActor ? 0 : 1,
        unreadClient:   isTeamActor ? 1 : 0,
        message_count:  1,
      };
      store.saveConversation(conv);
      store.addMessage(conv.id, msgObj);
    }
    // Push notification to the other party
    const pushTarget = isTeamActor ? clientId : brokerId;
    pushNotify(pushTarget, {
      type:  'new_message',
      title: `💬 ${user?.name || 'Usuario'}`,
      body:  message.slice(0, 120),
      url:   `/mensajes?conv=${conv.id}`,
    });
  }

  // Email notification to the other party
  const notifyEmail = isTeamActor ? app.client.email : app.broker.email;
  if (notifyEmail) {
    sendNotification(notifyEmail,
      `HogaresRD — Nuevo mensaje sobre ${app.listing_title}`,
      `<p><strong>${user?.name || 'Usuario'}</strong> te ha enviado un mensaje:</p>
       <blockquote style="border-left:3px solid #0038A8;padding:0.5rem 1rem;color:#333;">${message}</blockquote>
       <a href="${BASE_URL}/${isTeamActor ? 'my-applications' : 'broker'}">Ver conversación</a>`
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
// SECRETARY-GATE: HTML hide handled in broker.html commission card; check role===secretary
router.put('/:id/commission/review', userAuth, async (req, res) => {
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

  // D6: secretaries can submit/upload commissions but cannot APPROVE them.
  // The owner-only check above already blocks role==='secretary' (since they
  // hit that branch), but be explicit for the `approve` action so the error
  // code is meaningful to the client UI (which may want to hide the button).
  if (action === 'approve' && user.role === 'secretary') {
    return res.status(403).json({
      error: 'Solo el propietario puede aprobar comisiones.',
      code:  'requires_owner',
    });
  }

  if (action === 'adjust') {
    const recomputed = commissionComputed(req.body || {});
    if (recomputed.sale_amount <= 0 || recomputed.agent_percent <= 0) {
      return res.status(400).json({ error: 'Monto o porcentaje inválido.' });
    }
    if (recomputed.inmobiliaria_amount > recomputed.agent_amount) {
      return res.status(400).json({
        error: 'La comisión de la inmobiliaria no puede ser mayor que la del agente.',
      });
    }
    // Stash on req so the transaction body can use the validated values
    req._commissionRecomputed = recomputed;
  }

  const now = new Date().toISOString();
  const { history: _bh, ...snapshotBefore } = app.commission;

  // Wrap commission state mutation + audit event + save in a transaction
  // so the new commission status, history entry, timeline event, and DB row
  // all commit together. Clear payout pointers on rejection so a rejected
  // commission can't be paid out by a stale reference.
  try {
    await store.withTransaction(async (client) => {
      if (action === 'reject') {
        app.commission.status          = 'rejected';
        app.commission.reviewed_by     = user.id;
        app.commission.reviewer_name   = user.name || '';
        app.commission.reviewed_at     = now;
        app.commission.adjustment_note = (req.body?.note || '').toString().slice(0, 300);
        if (app.commission.payout_id) app.commission.payout_id = null;
        if (app.commission.payout_ref) app.commission.payout_ref = null;
      } else if (action === 'approve') {
        app.commission.status          = 'approved';
        app.commission.reviewed_by     = user.id;
        app.commission.reviewer_name   = user.name || '';
        app.commission.reviewed_at     = now;
        app.commission.adjustment_note = '';
      } else if (action === 'adjust') {
        Object.assign(app.commission, req._commissionRecomputed);
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

      await saveApplicationEncryptingFinancials(app, client);
    });
  } catch (err) {
    console.error('[commission/review] transaction failed:', err.message);
    return res.status(500).json({ error: 'Error al revisar la comisión' });
  }

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

  // D6: surface `secretary_can_approve` so the broker dashboard UI can
  // hide the "Aprobar" button for secretaries reactively. Always false
  // for now — the gate above already blocks role==='secretary'.
  res.json({ success: true, commission: app.commission, secretary_can_approve: false });
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

  // TODO(transactional-rewrite): commission amounts come back encrypted
  // from the store list helpers — the math below treats sale_amount /
  // agent_amount / agent_net as numbers, which silently produces 0 when
  // they're still ciphertext. Map through decryptAppPII before the
  // filter+reduce in a follow-up; the GET / and GET /my list endpoints
  // are already fixed.
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

  // Currency whitelist (parity with /:id/payment/upload + per-installment
  // upload). Default falls back to 'DOP' when the field is omitted.
  if (currency && !VALID_CURRENCIES.includes(String(currency).trim().toUpperCase())) {
    return res.status(400).json({ error: 'Moneda inválida (DOP o USD).' });
  }

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
    currency:       (currency && String(currency).trim().toUpperCase()) || 'DOP',
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

  // If the client passes a currency override on the proof upload,
  // whitelist it (DOP/USD). Most uploads don't override, in which
  // case the installment keeps the plan-level currency. The proof
  // record never carries a currency of its own; we surface the
  // mismatch as a 400 instead of silently ignoring an invalid value.
  if (req.body.currency !== undefined && req.body.currency !== '') {
    const c = String(req.body.currency).trim().toUpperCase();
    if (!VALID_CURRENCIES.includes(c)) {
      return res.status(400).json({ error: 'Moneda inválida (DOP o USD).' });
    }
  }

  // Defensive cap on a posted `amount` override — never accept a
  // value larger than the installment's recorded amount (a client
  // shouldn't be re-pricing the cuota at upload time). If the body
  // sends one, reject anything outside [0, inst.amount * 2] so a
  // typo doesn't trash the plan total.
  if (req.body.amount !== undefined && req.body.amount !== '') {
    const a = Number(req.body.amount);
    if (!isFinite(a) || a <= 0) {
      return res.status(400).json({ error: 'Monto inválido.' });
    }
    const cap = Number(inst.amount) > 0 ? Number(inst.amount) * 2 : Number.MAX_SAFE_INTEGER;
    if (a > cap) {
      return res.status(400).json({ error: 'Monto supera el límite permitido para la cuota.' });
    }
  }

  inst.proof_path        = req.file.path;
  inst.proof_filename    = req.file.filename;
  inst.proof_original    = req.file.originalname;
  inst.proof_uploaded_at = new Date().toISOString();
  inst.proof_notes       = String(req.body.notes || '').trim().slice(0, 500);
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

  // Subscription re-check: approving an installment can advance the app
  // to pago_aprobado. Mirror the PUT /:id/status gate so a lapsed
  // inmobiliaria can't drive deals forward via this surface.
  if (!admin && isInmobiliaria && !isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'Tu suscripcion no esta activa.',
      needsSubscription: true,
    });
  }
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

// ══════════════════════════════════════════════════════════════════
// ── POST /:id/withdraw  — Buyer cancels their own application (B1) ─
// ══════════════════════════════════════════════════════════════════
// Authorization: the application's client OR the magic-link bearer for
// THIS specific application id. Refuses if the app is already terminal.
// Side-effects mirror the rejection branch of PUT /:id/status.
router.post('/:id/withdraw', async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  // ── Authorize: JWT (client owner) or magic-link bearer for this app ──
  let authorized = false;
  let actorId    = 'client';
  let actorName  = app.client?.name || 'Cliente';
  let viaTrackToken = false;

  // Try Authorization: Bearer <token> first. Could be a userAuth JWT
  // OR a track-token JWT — disambiguate by `kind`.
  const authHeader = req.headers.authorization || '';
  const cookieTok  = req.cookies?.hrdt;
  const bearer     = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (cookieTok || '');

  if (bearer) {
    try {
      const payload = verifyJwtAcceptingPrev(bearer);
      if (payload?.kind === 'track') {
        // Track tokens are scoped to a single application id
        if (payload.aid === app.id) {
          authorized   = true;
          actorId      = 'magic-link';
          actorName    = app.client?.name || 'Cliente (enlace)';
          viaTrackToken = true;
        }
      } else if (payload?.sub) {
        // Standard user JWT — must own the application
        if (app.client?.user_id === payload.sub) {
          authorized = true;
          actorId    = payload.sub;
          actorName  = payload.name || app.client?.name || 'Cliente';
        } else {
          // Allow auto-claim by verified email match (mirrors GET /:id)
          const u = store.getUserById(payload.sub);
          if (u && u.emailVerified === true && !app.client?.user_id
              && app.client?.email && u.email
              && app.client.email.toLowerCase() === u.email.toLowerCase()) {
            authorized = true;
            actorId    = payload.sub;
            actorName  = u.name || app.client?.name || 'Cliente';
          }
        }
      }
    } catch (_) {
      // fall through — not authorized
    }
  }

  if (!authorized) return res.status(403).json({ error: 'No autorizado' });

  // ── Reject if already in a terminal state ─────────────────────
  if (app.status === 'rechazado' || app.status === 'completado') {
    return res.status(400).json({ error: 'Esta aplicación ya está finalizada.' });
  }

  const userReason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().slice(0, 500)
    : '';
  const oldStatus = app.status;

  // ── Atomic: status flip + timeline event + commission void + inventory sync ──
  try {
    await store.withTransaction(async (client) => {
      app.status = 'rechazado';
      // Persisted reason is fixed; the user's freeform note is recorded
      // verbatim in the timeline event for audit but never overwrites
      // the canonical "withdrawn by client" marker.
      app.status_reason = 'Retirada por el cliente';
      app.updated_at = new Date().toISOString();

      addEvent(app, 'status_change',
        userReason
          ? `Aplicación retirada por el cliente: ${userReason}`
          : 'Aplicación retirada por el cliente',
        actorId, actorName,
        {
          from: oldStatus,
          to:   'rechazado',
          reason: 'Retirada por el cliente',
          user_reason: userReason || null,
          withdrawn_by_client: true,
          via: viaTrackToken ? 'magic_link' : 'authenticated',
        });

      // Void approved commission (sale didn't happen)
      if (app.commission?.status === 'approved') {
        app.commission.status = 'voided';
        app.commission.voided_at = new Date().toISOString();
        if (app.commission.payout_id)  app.commission.payout_id  = null;
        if (app.commission.payout_ref) app.commission.payout_ref = null;
        addEvent(app, 'commission_voided',
          'Comisión anulada por retiro de la aplicación',
          'system', 'Sistema', { reason: 'application_withdrawn' });
      }

      // Inventory: assigned unit goes back to 'available'
      if (app.assigned_unit?.unitId && app.listing_id) {
        const targetUnitId = app.assigned_unit.unitId;
        const listing = store.getListingById(app.listing_id);
        if (listing && Array.isArray(listing.unit_inventory)) {
          const unit = listing.unit_inventory.find(u => u.id === targetUnitId);
          if (unit) {
            unit.status = 'available';
            unit.applicationId = null;
            unit.clientName = null;
            listing.units_available = listing.unit_inventory.filter(u => u.status === 'available').length;
            await store.saveListing(listing, client);
          }
        }
        app.assigned_unit = null;
      }

      await store.saveApplication(app, client);
    });
  } catch (err) {
    console.error('[applications/withdraw] transaction failed:', err.message);
    return res.status(500).json({ error: 'No se pudo retirar la aplicación. Inténtalo de nuevo.' });
  }

  // Cancel auto-tasks (best-effort, outside the txn — same as PUT /:id/status)
  const allEvents = ['documents_requested', 'documents_rejected', 'document_uploaded',
                     'payment_plan_created', 'payment_uploaded', 'payment_rejected', 'receipt_ready'];
  for (const evt of allEvents) {
    try { autoCompleteTasksByEvent(app.id, evt); } catch (_) {}
  }

  // Notify the broker so they aren't surprised
  if (app.broker?.email) {
    sendNotification(app.broker.email,
      `Aplicación retirada — ${app.listing_title}`,
      et.layout({
        title: 'Aplicación retirada por el cliente',
        subtitle: et.esc(app.listing_title || ''),
        body:
          et.p(`<strong>${et.esc(app.client?.name || 'El cliente')}</strong> ha retirado su aplicación.`)
          + (userReason ? et.alertBox(`<strong>Motivo del cliente:</strong> ${et.esc(userReason)}`, 'info') : '')
          + et.button('Ver en Dashboard', `${BASE_URL}/broker`),
      }),
      { app, purpose: 'application_withdrawn' });
  }

  // P1 #23: confirm to the buyer that the withdrawal succeeded. The
  // magic-link path used to land silently — they'd click "Retirar" and
  // never get a paper trail. Logged-in withdrawals also benefit from
  // a confirmation receipt. Use a fresh track token so the link works
  // even if the user is not logged in.
  if (app.client?.email) {
    try {
      const isAnon = !app.client.user_id;
      const link = isAnon
        ? `${BASE_URL}/track.html?token=${signTrackToken(app.id)}`
        : `${BASE_URL}/my-applications?id=${app.id}`;
      const shortId = String(app.id || '').slice(0, 8);
      sendNotification(app.client.email,
        'Confirmamos la retirada de tu aplicación',
        et.layout({
          title: 'Confirmamos la retirada de tu aplicación',
          subtitle: et.esc(app.listing_title || ''),
          preheader: 'Hemos registrado tu solicitud de retirada y notificamos a tu agente.',
          body:
            et.p(`Hemos retirado tu aplicación para <strong>${et.esc(app.listing_title || '')}</strong>.`)
            + et.infoTable(
                et.infoRow('Aplicación #', et.esc(shortId))
              + et.infoRow('Propiedad', et.esc(app.listing_title || ''))
              + (userReason ? et.infoRow('Motivo', et.esc(userReason)) : '')
            )
            + et.p('Tu agente ha sido notificado de la retirada.')
            + et.button('Ver mi aplicación', link)
            + et.divider()
            + et.small('Si esta retirada no fue solicitada por ti, responde a este correo de inmediato.'),
        }),
        { app, purpose: 'buyer_withdraw_confirmation' });
    } catch (e) {
      console.error('[applications/withdraw] buyer confirmation send failed:', e.message);
    }
  }

  // Push notification → broker
  try {
    if (app.broker?.user_id) {
      pushNotify(app.broker.user_id, {
        type:  'application_withdrawn',
        title: 'Aplicación retirada',
        body:  `${app.client?.name || 'Cliente'} retiró su aplicación para ${app.listing_title}`,
        url:   '/broker.html',
      });
    }
  } catch (_) {}

  res.json(decryptAppPII(app));
});

// ══════════════════════════════════════════════════════════════════
// ── C4: Broker reassigns an application to a teammate ───────────
// ══════════════════════════════════════════════════════════════════
//
// Allowed callers: the current broker on the app, the inmobiliaria
// owner whose team owns it, or admin. The new broker MUST be on the
// same inmobiliaria team. A `broker_reassigned` timeline event is
// recorded and both brokers are emailed.
router.post('/:id/reassign', userAuth, async (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user           = store.getUserById(req.user.sub);
  const isBroker       = app.broker?.user_id === req.user.sub;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user?.role) && app.inmobiliaria_id === user.id;
  const admin          = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !isInmobiliaria && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  const { newBrokerUserId, reason } = req.body || {};
  if (!newBrokerUserId) return res.status(400).json({ error: 'newBrokerUserId es requerido' });
  const note = (reason || '').toString().trim().slice(0, 500);

  const newBroker = store.getUserById(newBrokerUserId);
  if (!newBroker) return res.status(400).json({ error: 'Nuevo broker no existe' });

  // Same-team validation. If the app is unattached to an inmobiliaria,
  // we still need both brokers on the same team to keep ownership coherent.
  const newBrokerTeam = newBroker.inmobiliaria_id || null;
  if (app.inmobiliaria_id && newBrokerTeam !== app.inmobiliaria_id) {
    return res.status(400).json({ error: 'El nuevo broker no pertenece a la misma inmobiliaria.' });
  }

  if (newBroker.id === app.broker?.user_id) {
    return res.status(400).json({ error: 'El nuevo broker ya está asignado a esta aplicación.' });
  }

  const oldBrokerSnap = { ...(app.broker || {}) };

  app.broker = {
    user_id:     newBroker.id,
    name:        newBroker.name || newBroker.email || 'Broker',
    agency_name: newBroker.agency_name || oldBrokerSnap.agency_name || '',
    email:       newBroker.email || '',
    phone:       newBroker.phone || '',
  };

  addEvent(app, 'broker_reassigned',
    `Aplicación reasignada a ${app.broker.name}${note ? ' — ' + note.slice(0, 200) : ''}`,
    req.user.sub, user?.name || 'Sistema',
    {
      from:   oldBrokerSnap.user_id || null,
      to:     newBroker.id,
      reason: note,
      by:     req.user.sub,
    });

  // P1 #14: also propagate the reassignment to:
  //   1. Conversations matching (clientId, propertyId).
  //   2. Auto-tasks for this application currently assigned to the
  //      old broker that aren't done.
  //   3. Tour rows embedded in app.tours[] still pointing at the old
  //      broker (they ride the saveApplication below).
  // Otherwise the new broker can't see the chat, the old broker still
  // owns the to-do list, and the buyer keeps seeing the old name on
  // their tour confirmations.
  const oldBrokerUserId = oldBrokerSnap.user_id || null;
  const propagationStats = { conversations: 0, tasks: 0, tours: 0 };
  await store.withTransaction(async (client) => {
    await store.saveApplication(app, client);

    // Conversations — find by (clientId, propertyId). A buyer typically
    // has a single conversation per property, but we touch all matches
    // defensively in case earlier data migrations created duplicates.
    const clientId = app.client?.user_id || null;
    if (clientId && app.listing_id) {
      const allConvs = (typeof store.getConversations === 'function')
        ? store.getConversations()
        : [];
      const matching = allConvs.filter(c =>
        c && c.clientId === clientId && c.propertyId === app.listing_id
      );
      for (const conv of matching) {
        if (conv.brokerId === newBroker.id) continue; // already on the new broker
        conv.brokerId   = newBroker.id;
        conv.brokerName = app.broker.name;
        conv.updatedAt  = new Date().toISOString();
        try {
          store.saveConversation(conv, client);
          propagationStats.conversations += 1;
        } catch (e) {
          console.error('[applications/reassign] saveConversation failed:', e.message);
        }
      }
    }

    // Tasks — auto-tasks tied to this application currently assigned to
    // the old broker. We skip done/cancelled/completed tasks so a closed
    // checklist item doesn't bounce back to the new broker.
    if (oldBrokerUserId && typeof store.getTasksByApplication === 'function') {
      const tasks = store.getTasksByApplication(app.id) || [];
      for (const t of tasks) {
        if (!t || t.assigned_to !== oldBrokerUserId) continue;
        if (t.status === 'done' || t.status === 'completed' || t.status === 'cancelled') continue;
        t.assigned_to = newBroker.id;
        t.updated_at  = new Date().toISOString();
        try {
          store.saveTask(t, client);
          propagationStats.tasks += 1;
        } catch (e) {
          console.error('[applications/reassign] saveTask failed:', e.message);
        }
      }
    }

    // Tours — embedded inside app.tours[]. Mutate in place; the
    // saveApplication above already persisted (mutation here updates
    // the in-memory cached row, and we re-save at the end of the txn
    // so the new assignments commit).
    if (oldBrokerUserId && Array.isArray(app.tours)) {
      for (const tour of app.tours) {
        if (!tour || tour.assigned_to !== oldBrokerUserId) continue;
        if (tour.status === 'cancelled' || tour.status === 'completed' || tour.status === 'done') continue;
        tour.assigned_to    = newBroker.id;
        tour.broker_user_id = newBroker.id;
        tour.broker_name    = app.broker.name;
        propagationStats.tours += 1;
      }
      if (propagationStats.tours > 0) {
        // Re-save so the mutated tour entries land in the DB row.
        await store.saveApplication(app, client);
      }
    }
  });

  // Notify both brokers (best-effort).
  if (oldBrokerSnap.email) {
    sendNotification(oldBrokerSnap.email,
      `Aplicación reasignada — ${app.listing_title || 'Propiedad'}`,
      `<p>Hola ${oldBrokerSnap.name || ''},</p>
       <p>La aplicación de ${app.client?.name || 'el cliente'} para "${app.listing_title || 'una propiedad'}" fue reasignada a <strong>${app.broker.name}</strong>.</p>
       ${note ? `<p>Motivo: ${note}</p>` : ''}`,
      { app, purpose: 'broker_reassigned' });
  }
  if (app.broker.email) {
    sendNotification(app.broker.email,
      `Nueva aplicación asignada — ${app.listing_title || 'Propiedad'}`,
      `<p>Hola ${app.broker.name || ''},</p>
       <p>Se te asignó la aplicación de ${app.client?.name || 'un cliente'} para "${app.listing_title || 'una propiedad'}".</p>
       <p><a href="${BASE_URL}/broker">Ver en el dashboard</a></p>`,
      { app, purpose: 'broker_reassigned' });
  }

  res.json(decryptAppPII(app));
});

// ══════════════════════════════════════════════════════════════════
// ── C7: Bulk operations on a set of applications ────────────────
// ══════════════════════════════════════════════════════════════════
//
// Body: { ids: string[], action: 'reject'|'archive'|'mark_stale', reason?: string }
// Per-id authorization mirrors GET /:id. Failures are recorded on the
// per-id result so the loop never throws.
router.post('/bulk', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  const { ids, action, reason } = req.body || {};
  if (!Array.isArray(ids) || !ids.length)
    return res.status(400).json({ error: 'ids es requerido' });
  if (ids.length > 200)
    return res.status(400).json({ error: 'Máximo 200 ids por llamada.' });
  if (!['reject', 'archive', 'mark_stale'].includes(action))
    return res.status(400).json({ error: 'action inválida' });

  const note = (reason || '').toString().trim().slice(0, 500);
  if (action === 'reject' && note.length < 5)
    return res.status(400).json({ error: 'reason ≥ 5 caracteres es requerido para rechazar.' });

  const admin = isAdmin(req) || user.role === 'admin';

  // Subscription re-check at the route boundary — same pattern as the
  // single-status path. Bulk reject is the highest-leverage write in the
  // file (one call can reject 200 deals); a lapsed broker should not get
  // to use it.
  const isInmobiliariaActor = ['inmobiliaria', 'constructora'].includes(user.role);
  if (!admin && (user.role === 'broker' || isInmobiliariaActor) && !isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'Tu suscripcion no esta activa.',
      needsSubscription: true,
    });
  }

  const results = [];
  // Track apps successfully rejected so we can drive notifications and
  // task auto-completion AFTER the transaction resolves — same shape as
  // PUT /:id/status. Holding network I/O inside the txn would lengthen
  // the row-lock window unnecessarily.
  const rejectedForPostTxn = [];

  await store.withTransaction(async (client) => {
    for (const id of ids) {
      const app = store.getApplicationById(id);
      if (!app) {
        results.push({ id, ok: false, code: 'not_found' });
        continue;
      }
      const isBroker       = app.broker?.user_id === req.user.sub;
      const isInmobiliaria = isInmobiliariaActor && app.inmobiliaria_id === user.id;
      const isSecretary    = user.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
      if (!isBroker && !isInmobiliaria && !isSecretary && !admin) {
        results.push({ id, ok: false, code: 'forbidden' });
        continue;
      }

      try {
        if (action === 'reject') {
          if (['rechazado', 'completado'].includes(app.status)) {
            results.push({ id, ok: false, code: 'terminal_state' });
            continue;
          }
          // Shared helper: same status flip + commission void +
          // inventory release as the single-status reject path.
          const oldStatus = app.status;
          await applyRejection(app, {
            reason:    note,
            actorId:   req.user.sub,
            actorName: user.name || 'Broker',
            client,
            bulk:      true,
          });
          rejectedForPostTxn.push({ app, oldStatus });
        } else if (action === 'archive') {
          app.archived = true;
          addEvent(app, 'application_archived',
            `Aplicación archivada${note ? ': ' + note : ''}`,
            req.user.sub, user.name || 'Broker', { reason: note, bulk: true });
        } else if (action === 'mark_stale') {
          app.stale = true;
          addEvent(app, 'application_marked_stale',
            `Aplicación marcada como obsoleta${note ? ': ' + note : ''}`,
            req.user.sub, user.name || 'Broker', { reason: note, bulk: true });
        }
        await store.saveApplication(app, client);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, code: 'error', error: err.message });
      }
    }
  });

  // ── Post-transaction side-effects for rejected apps ─────────────
  // Mirror the PUT /:id/status reject path: cancel pending tasks, email
  // and push the client. Email failures are recorded on each app via
  // the existing `recordNotificationFailure` chain in sendNotification.
  for (const { app, oldStatus } of rejectedForPostTxn) {
    const taskEvents = ['documents_requested', 'documents_rejected', 'document_uploaded',
                        'payment_plan_created', 'payment_uploaded', 'payment_rejected', 'receipt_ready'];
    for (const evt of taskEvents) {
      try { autoCompleteTasksByEvent(app.id, evt); } catch (_) {}
    }

    if (app.client?.email) {
      const email = statusEmail(app, oldStatus, 'rechazado', note);
      sendNotification(app.client.email, email.subject, email.html, { app, purpose: 'bulk_reject' });
    }
    if (app.client?.user_id) {
      try {
        pushNotify(app.client.user_id, {
          type:  'status_changed',
          title: 'Estado Actualizado',
          body:  `Tu aplicación para ${app.listing_title} cambió a: ${STATUS_LABELS['rechazado']}`,
          url:   `/my-applications?id=${app.id}`,
        });
      } catch (_) { /* best-effort */ }
    }
  }

  res.json({ ok: true, action, results });
});

// ══════════════════════════════════════════════════════════════════
// ── D2: POST /:id/recommend-status ───────────────────────────────
// Secretaries (or any actor without authorization to flip a
// critical-stage status directly) can RECOMMEND a status change.
// This persists a pending-approval row for the inmobiliaria owner
// and emits a `status_recommended` event — but does NOT change
// app.status. The owner accepts/rejects via the normal
// PUT /:id/status endpoint, which clears the pending row.
// ══════════════════════════════════════════════════════════════════
router.post('/:id/recommend-status', userAuth, (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  // Caller must be tied to this application: broker, owner, secretary,
  // or admin. (Same auth surface as PUT /:id/status.)
  const isBroker       = app.broker?.user_id === user.id;
  const isInmobiliaria = ['inmobiliaria', 'constructora'].includes(user.role) && app.inmobiliaria_id === user.id;
  const isSecretary    = user.role === 'secretary' && app.inmobiliaria_id === user.inmobiliaria_id;
  const admin          = user.role === 'admin' || isAdmin(req);
  if (!isBroker && !isInmobiliaria && !isSecretary && !admin)
    return res.status(403).json({ error: 'No autorizado' });

  const status = (req.body?.status || '').toString();
  const reason = (req.body?.reason || '').toString().slice(0, 500);
  if (!status) return res.status(400).json({ error: 'status es requerido' });
  if (!STATUS_LABELS[status])
    return res.status(400).json({ error: `Estado desconocido: ${status}` });

  // P1 #25: only allow recommending statuses the state machine actually
  // permits from the current state. Without this, a secretary could
  // queue an approval for a status (e.g. `completado` from `aplicado`)
  // that the owner couldn't accept anyway — the eventual PUT
  // /:id/status would 400 on the same STATUS_FLOW guard. Mirror the
  // skip-phase error format for consistency.
  const allowed = STATUS_FLOW[app.status];
  if (!allowed || !allowed.includes(status)) {
    return res.status(400).json({ error: `Transición no válida: ${app.status} → ${status}` });
  }

  const approval = {
    id:                 'pa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    application_id:     app.id,
    requested_status:   status,
    reason,
    requested_by:       user.id,
    requested_by_name:  user.name || '',
    requested_at:       new Date().toISOString(),
    inmobiliaria_id:    app.inmobiliaria_id || null,
  };
  store.addPendingApproval(approval);

  addEvent(app, 'status_recommended',
    `Recomendado: cambiar estado a ${STATUS_LABELS[status]}${reason ? ' (' + reason + ')' : ''}`,
    user.id, user.name || '', { requested_status: status, reason, approval_id: approval.id });
  store.saveApplication(app);

  res.status(201).json({ success: true, approval });
});

module.exports = router;

// Internal hooks for tests. Not part of the public API — do not import
// these from anywhere outside tests/.
//   - recordNotificationFailure / recordInventorySyncFailure: unit-test
//     the bookkeeping that turns a swallowed side-effect failure into an
//     auditable record on the application.
//   - _setTransporter: replace the mailer with a stub so tests can drive
//     the email-failure path through the real route handlers.
module.exports.__test = {
  recordNotificationFailure,
  recordInventorySyncFailure,
  _setTransporter: (t) => { transporter = t; },
  // Swap the magic-byte sniff for a stub so multipart-upload tests
  // can drive the route without committing real binary fixtures.
  // Pass `null` to restore the real implementation.
  _setValidateMime: (fn) => { validateMime = fn || _validateMimeImpl; },
  // Real impl (no stub layer) — Wave 9-D regression tests call this
  // directly to verify the fix to the file-type@16 import.
  _validateMimeImpl,
  // E4 / E7
  normalizeTourTime,
  statusEmail,
  appStatusLabel,
  userLangFor,
};
