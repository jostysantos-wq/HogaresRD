const express      = require('express');
const nodemailer   = require('nodemailer');
const store        = require('./store');
const { userAuth } = require('./auth');

const router   = express.Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

function send(to, subject, html) {
  if (!process.env.EMAIL_USER) return;
  transporter.sendMail({
    from: `"HogaresRD" <${process.env.EMAIL_USER}>`,
    to, subject, html,
  }).catch(() => {});
}

// ── Role middlewares ──────────────────────────────────────────────────────
function brokerAuth(req, res, next) {
  const user = store.getUserById(req.user.sub);
  if (!user || !['broker', 'agency'].includes(user.role))
    return res.status(403).json({ error: 'Solo agentes brokers pueden realizar esta acción' });
  req.brokerUser = user;
  next();
}

function inmobiliariaAuth(req, res, next) {
  const user = store.getUserById(req.user.sub);
  if (!user || user.role !== 'inmobiliaria')
    return res.status(403).json({ error: 'Solo inmobiliarias pueden realizar esta acción' });
  req.inmobiliariaUser = user;
  next();
}

// ══════════════════════════════════════════════════════════════════
// ── GET /list ── Public: list all inmobiliarias
// ══════════════════════════════════════════════════════════════════
router.get('/list', (req, res) => {
  const { search } = req.query;
  let list = store.getUsersByRole('inmobiliaria').map(u => ({
    id:            u.id,
    companyName:   u.companyName || u.name,
    name:          u.name,
    licenseNumber: u.licenseNumber || '',
    phone:         u.phone || '',
    createdAt:     u.createdAt,
    broker_count:  store.getUsersByInmobiliaria(u.id).length,
  }));

  if (search) {
    const q = search.toLowerCase();
    list = list.filter(i =>
      (i.companyName || '').toLowerCase().includes(q) ||
      i.name.toLowerCase().includes(q)
    );
  }

  res.json(list);
});

// ══════════════════════════════════════════════════════════════════
// ── POST /join-request ── Broker requests affiliation
// ══════════════════════════════════════════════════════════════════
router.post('/join-request', userAuth, brokerAuth, (req, res) => {
  const { inmobiliaria_id } = req.body;
  const broker = req.brokerUser;

  if (!inmobiliaria_id)
    return res.status(400).json({ error: 'ID de inmobiliaria requerido' });

  const inm = store.getUserById(inmobiliaria_id);
  if (!inm || inm.role !== 'inmobiliaria')
    return res.status(404).json({ error: 'Inmobiliaria no encontrada' });

  if (broker.inmobiliaria_id === inmobiliaria_id)
    return res.status(400).json({ error: 'Ya estás afiliado a esta inmobiliaria' });

  if (broker.inmobiliaria_join_status === 'pending')
    return res.status(400).json({ error: 'Ya tienes una solicitud pendiente. Cancélala primero.' });

  if (!Array.isArray(inm.join_requests)) inm.join_requests = [];

  const existing = inm.join_requests.find(r =>
    r.broker_id === broker.id && r.status === 'pending'
  );
  if (existing)
    return res.status(400).json({ error: 'Ya tienes una solicitud pendiente con esta inmobiliaria' });

  inm.join_requests.push({
    id:             `jr_${Date.now()}`,
    broker_id:      broker.id,
    broker_name:    broker.name,
    broker_email:   broker.email,
    broker_license: broker.licenseNumber || '',
    broker_phone:   broker.phone || '',
    requested_at:   new Date().toISOString(),
    status:         'pending',
  });
  store.saveUser(inm);

  broker.inmobiliaria_pending_id   = inmobiliaria_id;
  broker.inmobiliaria_pending_name = inm.companyName || inm.name;
  broker.inmobiliaria_join_status  = 'pending';
  store.saveUser(broker);

  // Notify inmobiliaria
  send(inm.email,
    `Nueva solicitud de afiliación — ${broker.name}`,
    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
      <div style="background:#002D62;color:#fff;padding:1.5rem;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;font-size:1.1rem;">Nueva Solicitud de Afiliación</h2>
      </div>
      <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;">
        <p>El agente broker <strong>${broker.name}</strong> (${broker.email}) ha solicitado afiliarse a <strong>${inm.companyName || inm.name}</strong>.</p>
        ${broker.licenseNumber ? `<p>Licencia: <strong>${broker.licenseNumber}</strong></p>` : ''}
        <p>Ingresa a tu dashboard para aprobar o rechazar la solicitud.</p>
        <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver Dashboard →</a>
      </div>
    </div>`
  );

  res.json({ success: true, message: `Solicitud enviada a ${inm.companyName || inm.name}` });
});

// ══════════════════════════════════════════════════════════════════
// ── DELETE /join-request ── Broker cancels pending request
// ══════════════════════════════════════════════════════════════════
router.delete('/join-request', userAuth, brokerAuth, (req, res) => {
  const broker = req.brokerUser;

  if (broker.inmobiliaria_join_status !== 'pending')
    return res.status(400).json({ error: 'No tienes una solicitud pendiente' });

  const inm = store.getUserById(broker.inmobiliaria_pending_id);
  if (inm) {
    inm.join_requests = (inm.join_requests || []).map(r =>
      r.broker_id === broker.id && r.status === 'pending'
        ? { ...r, status: 'cancelled', cancelled_at: new Date().toISOString() }
        : r
    );
    store.saveUser(inm);
  }

  broker.inmobiliaria_join_status  = null;
  broker.inmobiliaria_pending_id   = null;
  broker.inmobiliaria_pending_name = null;
  store.saveUser(broker);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /my-affiliation ── Broker sees their current status
// ══════════════════════════════════════════════════════════════════
router.get('/my-affiliation', userAuth, brokerAuth, (req, res) => {
  const b = req.brokerUser;
  res.json({
    inmobiliaria_id:           b.inmobiliaria_id           || null,
    inmobiliaria_name:         b.inmobiliaria_name         || null,
    inmobiliaria_join_status:  b.inmobiliaria_join_status  || null,
    inmobiliaria_pending_id:   b.inmobiliaria_pending_id   || null,
    inmobiliaria_pending_name: b.inmobiliaria_pending_name || null,
    inmobiliaria_joined_at:    b.inmobiliaria_joined_at    || null,
  });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /leave ── Broker leaves current inmobiliaria
// ══════════════════════════════════════════════════════════════════
router.post('/leave', userAuth, brokerAuth, (req, res) => {
  const broker = req.brokerUser;

  if (!broker.inmobiliaria_id)
    return res.status(400).json({ error: 'No estás afiliado a ninguna inmobiliaria' });

  broker.inmobiliaria_id          = null;
  broker.inmobiliaria_name        = null;
  broker.inmobiliaria_join_status = null;
  broker.inmobiliaria_joined_at   = null;
  store.saveUser(broker);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /brokers ── Inmobiliaria: see team + pending requests
// ══════════════════════════════════════════════════════════════════
router.get('/brokers', userAuth, inmobiliariaAuth, (req, res) => {
  const inm = req.inmobiliariaUser;

  const brokers = store.getUsersByInmobiliaria(inm.id).map(b => ({
    id:            b.id,
    name:          b.name,
    email:         b.email,
    phone:         b.phone || '',
    licenseNumber: b.licenseNumber || '',
    joined_at:     b.inmobiliaria_joined_at || b.createdAt,
    app_count:     store.getApplicationsByBroker(b.id).length,
  }));

  const pending_requests = (inm.join_requests || [])
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

  res.json({ brokers, pending_requests });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/approve ── Inmobiliaria approves
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/approve', userAuth, inmobiliariaAuth, (req, res) => {
  const inm    = req.inmobiliariaUser;
  const broker = store.getUserById(req.params.brokerId);

  if (!broker || !['broker', 'agency'].includes(broker.role))
    return res.status(404).json({ error: 'Agente no encontrado' });

  if (!Array.isArray(inm.join_requests)) inm.join_requests = [];
  const jr = inm.join_requests.find(
    r => r.broker_id === broker.id && r.status === 'pending'
  );
  if (!jr)
    return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

  jr.status      = 'approved';
  jr.approved_at = new Date().toISOString();
  store.saveUser(inm);

  broker.inmobiliaria_id           = inm.id;
  broker.inmobiliaria_name         = inm.companyName || inm.name;
  broker.inmobiliaria_join_status  = 'approved';
  broker.inmobiliaria_pending_id   = null;
  broker.inmobiliaria_pending_name = null;
  broker.inmobiliaria_joined_at    = new Date().toISOString();
  store.saveUser(broker);

  // Notify broker
  send(broker.email,
    `¡Solicitud aprobada! — ${inm.companyName || inm.name}`,
    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
      <div style="background:#16A34A;color:#fff;padding:1.5rem;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;font-size:1.1rem;">✅ Solicitud Aprobada</h2>
      </div>
      <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;">
        <p>Tu solicitud de afiliación a <strong>${inm.companyName || inm.name}</strong> ha sido aprobada.</p>
        <p>Ahora formas parte del equipo. Tus nuevas aplicaciones serán visibles para la inmobiliaria.</p>
        <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ir al Dashboard →</a>
      </div>
    </div>`
  );

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/reject ── Inmobiliaria rejects
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/reject', userAuth, inmobiliariaAuth, (req, res) => {
  const inm    = req.inmobiliariaUser;
  const broker = store.getUserById(req.params.brokerId);

  if (!broker)
    return res.status(404).json({ error: 'Agente no encontrado' });

  const jr = (inm.join_requests || []).find(
    r => r.broker_id === broker.id && r.status === 'pending'
  );
  if (jr) {
    jr.status      = 'rejected';
    jr.rejected_at = new Date().toISOString();
    store.saveUser(inm);
  }

  if (broker.inmobiliaria_pending_id === inm.id) {
    broker.inmobiliaria_join_status  = 'rejected';
    broker.inmobiliaria_pending_id   = null;
    broker.inmobiliaria_pending_name = null;
    store.saveUser(broker);
  }

  // Notify broker
  send(broker.email,
    `Solicitud de afiliación — ${inm.companyName || inm.name}`,
    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
      <div style="background:#DC2626;color:#fff;padding:1.5rem;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;font-size:1.1rem;">Solicitud No Aprobada</h2>
      </div>
      <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;">
        <p>Tu solicitud para afiliarte a <strong>${inm.companyName || inm.name}</strong> no fue aprobada en esta ocasión.</p>
        <p>Puedes intentar con otra inmobiliaria desde tu dashboard.</p>
        <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ir al Dashboard →</a>
      </div>
    </div>`
  );

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/remove ── Inmobiliaria removes broker
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/remove', userAuth, inmobiliariaAuth, (req, res) => {
  const inm    = req.inmobiliariaUser;
  const broker = store.getUserById(req.params.brokerId);

  if (!broker || broker.inmobiliaria_id !== inm.id)
    return res.status(404).json({ error: 'Agente no encontrado en tu inmobiliaria' });

  broker.inmobiliaria_id          = null;
  broker.inmobiliaria_name        = null;
  broker.inmobiliaria_join_status = null;
  broker.inmobiliaria_joined_at   = null;
  store.saveUser(broker);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /profile ── Inmobiliaria public profile info
// ══════════════════════════════════════════════════════════════════
router.get('/profile', userAuth, inmobiliariaAuth, (req, res) => {
  const inm = req.inmobiliariaUser;
  const { passwordHash, resetToken, resetTokenExpiry, ...safe } = inm;
  res.json(safe);
});

module.exports = router;
