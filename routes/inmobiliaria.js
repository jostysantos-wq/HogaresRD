const express      = require('express');
const crypto       = require('crypto');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');
const { userAuth } = require('./auth');

const router   = express.Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const { createTransport } = require('./mailer');
const transporter = createTransport();

function send(to, subject, html) {
  if (!process.env.EMAIL_USER) return;
  transporter.sendMail({
    from: `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
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
  if (!user || (user.role !== 'inmobiliaria' && user.role !== 'constructora'))
    return res.status(403).json({ error: 'Solo inmobiliarias o constructoras pueden realizar esta accion' });
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
    jobTitle:      b.jobTitle || '',
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

// ══════════════════════════════════════════════════════════════════
// ── GET /brokers/:brokerId/details ── Full broker info + recent apps
// ══════════════════════════════════════════════════════════════════
router.get('/brokers/:brokerId/details', userAuth, inmobiliariaAuth, (req, res) => {
  const inm    = req.inmobiliariaUser;
  const broker = store.getUserById(req.params.brokerId);
  if (!broker || broker.inmobiliaria_id !== inm.id)
    return res.status(404).json({ error: 'Agente no encontrado' });

  const apps = store.getApplicationsByBroker(broker.id)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 10)
    .map(a => ({ id: a.id, title: a.listing_title, status: a.status, updated_at: a.updated_at, client: a.client?.name }));

  res.json({
    id: broker.id, name: broker.name, email: broker.email, phone: broker.phone || '',
    licenseNumber: broker.licenseNumber || '', role: broker.role,
    jobTitle: broker.jobTitle || '',
    joined_at: broker.inmobiliaria_joined_at || broker.createdAt,
    emailVerified: broker.emailVerified !== false,
    app_count: store.getApplicationsByBroker(broker.id).length,
    notes: broker.inm_notes || '',
    recent_apps: apps,
  });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/send-reset ── Send password reset email
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/send-reset', userAuth, inmobiliariaAuth, async (req, res) => {
  const inm    = req.inmobiliariaUser;
  const broker = store.getUserById(req.params.brokerId);
  if (!broker || broker.inmobiliaria_id !== inm.id)
    return res.status(404).json({ error: 'Agente no encontrado' });

  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  broker.resetToken       = tokenHash;
  broker.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  store.saveUser(broker);

  send(broker.email, 'Restablecer tu contraseña — HogaresRD', `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
      <div style="background:#002D62;padding:28px 32px;">
        <h2 style="color:#fff;margin:0;font-size:1.3rem;">🔒 Restablecer Contraseña</h2>
      </div>
      <div style="padding:28px 32px;background:#fff;">
        <p style="color:#1a2b40;">Hola <strong>${broker.name}</strong>,</p>
        <p style="color:#4d6a8a;line-height:1.6;">El administrador de <strong>${inm.name || 'tu inmobiliaria'}</strong> ha solicitado restablecer tu contraseña. Haz clic a continuación para crear una nueva.</p>
        <p style="color:#4d6a8a;"><strong>Este enlace expira en 1 hora.</strong></p>
        <div style="margin-top:24px;">
          <a href="${BASE_URL}/reset-password?token=${rawToken}" style="background:#002D62;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Restablecer Contraseña →</a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f0f4f9;font-size:0.8rem;color:#4d6a8a;">HogaresRD · República Dominicana</div>
    </div>`);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── PATCH /brokers/:brokerId/notes ── Save internal notes
// ══════════════════════════════════════════════════════════════════
router.patch('/brokers/:brokerId/notes', userAuth, inmobiliariaAuth, (req, res) => {
  const inm    = req.inmobiliariaUser;
  const broker = store.getUserById(req.params.brokerId);
  if (!broker || broker.inmobiliaria_id !== inm.id)
    return res.status(404).json({ error: 'Agente no encontrado' });

  broker.inm_notes = (req.body.notes || '').trim().slice(0, 1000);
  store.saveUser(broker);
  res.json({ success: true });
});

// ── Secretary Management ──────────────────────────────────────────────────

router.get('/secretaries', userAuth, inmobiliariaAuth, (req, res) => {
  const secretaries = store.getSecretariesByInmobiliaria(req.inmobiliariaUser.id);
  res.json({
    secretaries: secretaries.map(s => ({
      id: s.id, name: s.name, email: s.email, phone: s.phone,
      joinedAt: s.inmobiliaria_joined_at || s.createdAt,
    })),
  });
});

router.post('/secretaries/invite', userAuth, inmobiliariaAuth, (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  // Check if user already exists
  const existing = store.getUserByEmail(email);
  if (existing) return res.status(400).json({ error: 'Este correo ya está registrado' });

  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const user = req.inmobiliariaUser;

  if (!user.secretary_invites) user.secretary_invites = [];
  user.secretary_invites.push({
    email, name: name || '',
    token,
    invitedAt: new Date().toISOString(),
    status: 'pending',
  });
  store.saveUser(user);

  // Send invitation email
  const inviteUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/register-secretary?token=${token}`;
  send(email, `Invitación como Secretaria — ${user.agencyName || user.name} en HogaresRD`,
    `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#1a5fa8 100%);padding:36px 40px;">
          <div style="font-size:1rem;font-weight:900;color:#fff;margin-bottom:12px;">🏠 HogaresRD</div>
          <div style="font-size:1.5rem;font-weight:800;color:#fff;line-height:1.2;">Invitación de Secretaria</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 16px;font-size:0.95rem;color:#1a2b40;line-height:1.6;">
            <strong>${user.agencyName || user.name}</strong> te ha invitado como secretaria en HogaresRD.
          </p>
          <p style="margin:0 0 24px;font-size:0.9rem;color:#4d6a8a;line-height:1.6;">
            Como secretaria, podrás gestionar aplicaciones, aprobar pagos de clientes y acceder al panel de la inmobiliaria.
          </p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${inviteUrl}" style="display:inline-block;background:#002D62;color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;">
              Aceptar invitación →
            </a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.76rem;color:#7a9bbf;text-align:center;">© ${new Date().getFullYear()} HogaresRD · República Dominicana</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`);

  res.json({ success: true, message: 'Invitación enviada' });
});

router.post('/secretaries/:id/remove', userAuth, inmobiliariaAuth, (req, res) => {
  const secretary = store.getUserById(req.params.id);
  if (!secretary || secretary.role !== 'secretary' || secretary.inmobiliaria_id !== req.inmobiliariaUser.id)
    return res.status(404).json({ error: 'Secretaria no encontrada' });

  secretary.role = 'deactivated';
  secretary.inmobiliaria_id = null;
  secretary.deactivatedAt = new Date().toISOString();
  store.saveUser(secretary);

  res.json({ success: true });
});

module.exports = router;
