const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const store      = require('./store');
const { userAuth } = require('./auth');

const router    = express.Router();
const ADMIN_KEY = process.env.ADMIN_KEY || 'hogaresrd-admin-2026';
const BASE_URL  = process.env.BASE_URL || 'http://localhost:3000';

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
function isAdmin(req) {
  return req.headers['x-admin-key'] === ADMIN_KEY || req.query._key === ADMIN_KEY;
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

// ══════════════════════════════════════════════════════════════════
// ── POST /  — Create application ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.post('/', (req, res) => {
  const {
    listing_id, listing_title, listing_price, listing_type,
    name, phone, email, user_id,
    financing, pre_approved, contact_method, budget, timeline, intent, notes,
  } = req.body;

  if (!name || !phone || !listing_id)
    return res.status(400).json({ error: 'name, phone y listing_id son requeridos' });

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

  const app = {
    id:             uuid(),
    listing_id:     listing_id || '',
    listing_title:  listing_title || listing?.title || '',
    listing_price:  listing_price || listing?.price || '',
    listing_type:   listing_type  || listing?.type  || '',
    client: {
      name:    name.trim(),
      phone:   phone.trim(),
      email:   (email || '').trim(),
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
    timeline_events: [],
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
  };

  addEvent(app, 'status_change', 'Aplicación recibida', 'system', 'Sistema',
    { from: null, to: 'aplicado' });

  store.saveApplication(app);

  // Notify broker
  if (broker.email) {
    sendNotification(broker.email,
      `Nueva aplicación — ${app.listing_title}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#002D62;color:#fff;padding:1.5rem;text-align:center;border-radius:12px 12px 0 0;">
          <h2 style="margin:0;">Nueva Aplicación</h2>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;">
          <p><strong>${app.client.name}</strong> ha aplicado para:</p>
          <p style="font-size:1.1rem;font-weight:700;">${app.listing_title} — $${Number(app.listing_price).toLocaleString()}</p>
          <p>📞 ${app.client.phone} · ✉️ ${app.client.email || 'N/A'}</p>
          <p>Intención: ${app.intent} · Presupuesto: $${app.budget} · Plazo: ${app.timeline}</p>
          <a href="${BASE_URL}/broker" style="display:inline-block;background:#0038A8;color:#fff;padding:0.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver en Dashboard</a>
        </div>
      </div>`
    );
  }

  res.status(201).json({ ok: true, id: app.id });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /  — List applications (broker/admin) ────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/', (req, res, next) => {
  // Allow admin-key access (for admin panel) without JWT
  if (isAdmin(req)) {
    let apps = store.getApplications();
    const { status } = req.query;
    if (status) apps = apps.filter(a => a.status === status);
    return res.json(apps);
  }
  next();
}, userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  let apps;
  if (isAdmin(req) || user.role === 'admin') {
    apps = store.getApplications();
  } else if (user.role === 'agency') {
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
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  const admin = isAdmin(req) || user?.role === 'admin';

  if (!isBroker && !isClient && !admin)
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
  const admin = isAdmin(req) || user?.role === 'admin';
  if (!isBroker && !admin) return res.status(403).json({ error: 'No autorizado' });

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

  // Notify client
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
router.post('/:id/documents/upload', userAuth, docUpload.array('files', 10), (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isClient && !isAdmin(req))
    return res.status(403).json({ error: 'Solo el cliente puede subir documentos' });

  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No se recibieron archivos' });

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

  res.sendFile(path.resolve(doc.path));
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
router.post('/:id/payment/upload', userAuth, docUpload.single('receipt'), (req, res) => {
  const app = store.getApplicationById(req.params.id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });

  const user = store.getUserById(req.user.sub);
  const isClient = app.client.user_id === req.user.sub ||
                   (user && app.client.email.toLowerCase() === user.email.toLowerCase());
  if (!isClient) return res.status(403).json({ error: 'Solo el cliente puede subir recibo' });

  if (!req.file) return res.status(400).json({ error: 'Recibo es requerido' });

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

  res.sendFile(path.resolve(app.payment.receipt_path));
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

// ── PUT /:id/assign  — Admin reassigns broker ────────────────────
router.put('/:id/assign', (req, res) => {
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
