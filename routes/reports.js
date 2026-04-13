const express   = require('express');
const rateLimit = require('express-rate-limit');
const store     = require('./store');
const { userAuth } = require('./auth');
const { createTransport } = require('./mailer');

const router      = express.Router();
const transporter = createTransport();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';
const BASE_URL    = process.env.BASE_URL || 'https://hogaresrd.com';

// Rate limit: 5 reports per hour per IP
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: (req, res) => res.status(429).json({
    error: 'Demasiados reportes. Intenta de nuevo en una hora.',
  }),
});

// Predefined reason codes per report type
const REASONS = {
  listing: {
    informacion_falsa: 'Informacion falsa o engañosa',
    precio_incorrecto: 'Precio incorrecto',
    propiedad_vendida: 'Propiedad ya vendida o no disponible',
    fotos_enganosas:   'Fotos engañosas o no corresponden',
    spam:              'Spam o publicacion duplicada',
    fraude:            'Posible fraude o estafa',
    otro:              'Otro',
  },
  agent: {
    comportamiento_inapropiado: 'Comportamiento inapropiado',
    no_responde:                'No responde a consultas',
    informacion_falsa:          'Proporciona informacion falsa',
    fraude:                     'Posible fraude',
    acoso:                      'Acoso o presion indebida',
    otro:                       'Otro',
  },
  inmobiliaria: {
    practica_desleal:   'Practica comercial desleal',
    incumplimiento:     'Incumplimiento de acuerdos',
    informacion_falsa:  'Informacion falsa sobre la empresa',
    fraude:             'Posible fraude',
    otro:               'Otro',
  },
};

function uid() { return 'rpt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ── GET /api/reports/reasons ──────────────────────────────────────────────
// Public: returns the predefined reason codes
router.get('/reasons', (req, res) => {
  res.json(REASONS);
});

// ── POST /api/reports ─────────────────────────────────────────────────────
// Submit a report (auth optional — logged-in users get their info auto-filled)
router.post('/', reportLimiter, (req, res, next) => {
  // Try to get user if token provided
  try {
    const { userAuth: ua } = require('./auth');
    ua(req, res, () => {});
  } catch {}

  const { type, targetId, targetName, reason, details, attachment } = req.body;

  if (!type || !['listing', 'agent', 'inmobiliaria'].includes(type))
    return res.status(400).json({ error: 'Tipo de reporte invalido' });
  if (!reason || !REASONS[type]?.[reason])
    return res.status(400).json({ error: 'Razon de reporte invalida' });
  if (!targetId)
    return res.status(400).json({ error: 'Se requiere el ID del elemento reportado' });

  // Build target name if not provided
  let resolvedName = targetName || '';
  if (!resolvedName) {
    if (type === 'listing') {
      const listing = store.getListingById(targetId);
      resolvedName = listing?.title || targetId;
    } else {
      const user = store.getUserById(targetId);
      resolvedName = user?.companyName || user?.name || targetId;
    }
  }

  const user = req.user ? store.getUserById(req.user.sub) : null;

  const report = {
    id:             uid(),
    type,
    target_id:      targetId,
    target_name:    resolvedName,
    reporter_id:    user?.id || null,
    reporter_name:  user?.name || req.body.reporterName || 'Anonimo',
    reporter_email: user?.email || req.body.reporterEmail || null,
    reason,
    details:        (details || '').trim().slice(0, 2000),
    // Only accept attachment paths that point to our uploads directory —
    // prevents arbitrary URLs or filesystem paths from being embedded in
    // admin emails / rendered as links.
    attachment:     (typeof attachment === 'string' &&
                     /^\/uploads\/[A-Za-z0-9._/-]+$/.test(attachment) &&
                     !attachment.includes('..'))
                    ? attachment : null,
    status:         'pending',
    admin_notes:    null,
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  };

  store.saveReport(report);

  // Email notification to admin
  const et = require('../utils/email-templates');
  const typeLabels = { listing: 'Propiedad', agent: 'Agente', inmobiliaria: 'Inmobiliaria' };
  transporter.sendMail({
    to:         ADMIN_EMAIL,
    department: 'admin',
    subject:    `Nuevo reporte: ${typeLabels[type]} — ${resolvedName}`,
    html: et.layout({
      title: 'Nuevo reporte recibido',
      subtitle: typeLabels[type] + ': ' + et.esc(resolvedName),
      headerColor: '#991b1b',
      preheader: `Nuevo reporte recibido sobre ${resolvedName}`,
      body: et.infoTable(
              et.infoRow('Tipo', typeLabels[type])
            + et.infoRow('Elemento', et.esc(resolvedName))
            + et.infoRow('Razon', REASONS[type][reason])
            + et.infoRow('Reportado por', et.esc(report.reporter_name))
            + (report.reporter_email ? et.infoRow('Email', report.reporter_email) : '')
          )
        + (report.details ? et.quote(et.esc(report.details)) : '')
        + (report.attachment ? et.p('<a href="' + BASE_URL + report.attachment + '" style="color:#002D62;">Ver archivo adjunto</a>') : '')
        + et.button('Revisar en Admin', BASE_URL + '/' + (process.env.ADMIN_PATH || 'admin')),
    }),
  }).catch(err => console.error('[reports] Email error:', err.message));

  res.status(201).json({ success: true, reportId: report.id });
});

// ── GET /api/admin/reports ────────────────────────────────────────────────
// Admin only: list reports
router.get('/admin', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || user.role !== 'admin')
    return res.status(403).json({ error: 'Solo administradores' });

  const status = req.query.status || null;
  const reports = store.getReports(status);
  res.json({ reports });
});

// ── PUT /api/admin/reports/:id ────────────────────────────────────────────
// Admin only: update report status/notes
router.put('/admin/:id', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || user.role !== 'admin')
    return res.status(403).json({ error: 'Solo administradores' });

  const report = store.getReportById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Reporte no encontrado' });

  const { status, admin_notes } = req.body;
  if (status) report.status = status;
  if (admin_notes !== undefined) report.admin_notes = admin_notes;
  report.updated_at = new Date().toISOString();

  store.saveReport(report);
  res.json(report);
});

module.exports = { router, REASONS };
