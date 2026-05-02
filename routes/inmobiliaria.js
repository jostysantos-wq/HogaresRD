const express      = require('express');
const crypto       = require('crypto');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');
const { userAuth } = require('./auth');

const router   = express.Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const { createTransport } = require('./mailer');
const et = require('../utils/email-templates');
const transporter = createTransport();

function send(to, subject, html) {
  transporter.sendMail({
    to, subject, html,
    department: 'admin',
  }).catch(err => console.error('[inmobiliaria] Email error:', err.message));
}

// ── Access level constants ────────────────────────────────────────────────
const LEVEL_ASISTENTE = 1;
const LEVEL_GERENTE   = 2;
const LEVEL_DIRECTOR  = 3;
const LEVEL_LABELS = { 1: 'Asistente', 2: 'Gerente', 3: 'Director' };
const OWNER_ROLES = ['inmobiliaria', 'constructora'];

// P1 #21 — bump tokenVersion to invalidate any JWT the user is still
// holding when their role/access is downgraded. verifyJWT in auth.js
// rejects tokens whose version is below the user's current version, so
// after a bump the demoted/removed user is forced to re-authenticate.
//
// IMPORTANT: only call on demotion / removal — never on lateral changes
// or upgrades, otherwise we churn tokens for no security benefit.
function bumpTokenVersion(user) {
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  return user;
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
  if (!user || !OWNER_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo inmobiliarias o constructoras pueden realizar esta accion' });
  req.inmobiliariaUser = user;
  next();
}

/**
 * teamAuth(minLevel) — RBAC middleware for team members.
 * Resolves effective access level:
 *   - Owner (inmobiliaria/constructora role) → always level 3
 *   - Team member (has inmobiliaria_id) → stored access_level or default 1
 * Attaches req.teamUser, req.inmobiliariaId, req.accessLevel
 */
function teamAuth(minLevel) {
  return (req, res, next) => {
    const user = store.getUserById(req.user.sub);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    let inmobiliariaId, accessLevel;

    if (OWNER_ROLES.includes(user.role)) {
      inmobiliariaId = user.id;
      accessLevel = LEVEL_DIRECTOR; // owner always has full access
    } else if (user.inmobiliaria_id) {
      inmobiliariaId = user.inmobiliaria_id;
      accessLevel = user.access_level || LEVEL_ASISTENTE;
    } else {
      return res.status(403).json({ error: 'No perteneces a ninguna inmobiliaria' });
    }

    if (accessLevel < minLevel) {
      return res.status(403).json({ error: 'No tienes permisos suficientes para esta acción' });
    }

    req.teamUser = user;
    req.inmobiliariaId = inmobiliariaId;
    req.accessLevel = accessLevel;
    next();
  };
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
  if (!inm || !OWNER_ROLES.includes(inm.role))
    return res.status(404).json({ error: 'Inmobiliaria no encontrada' });

  if (broker.inmobiliaria_id === inmobiliaria_id)
    return res.status(400).json({ error: 'Ya estas afiliado a esta inmobiliaria.' });

  // Block agents who are already linked to a DIFFERENT inmobiliaria
  if (broker.inmobiliaria_id && broker.inmobiliaria_id !== inmobiliaria_id)
    return res.status(400).json({ error: 'Ya estas afiliado a otra inmobiliaria. Debes salir de tu organizacion actual antes de solicitar afiliacion a otra.' });

  if (broker.inmobiliaria_join_status === 'pending')
    return res.status(400).json({ error: 'Ya tienes una solicitud pendiente. Cancelala primero.' });

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
    `Nueva solicitud de afiliacion — ${broker.name}`,
    et.layout({
      title: 'Nueva Solicitud de Afiliacion',
      preheader: `${broker.name} quiere afiliarse a tu inmobiliaria`,
      body:
        et.p(`El agente broker <strong>${et.esc(broker.name)}</strong> (${et.esc(broker.email)}) ha solicitado afiliarse a <strong>${et.esc(inm.companyName || inm.name)}</strong>.`)
        + (broker.licenseNumber ? et.p(`Licencia: <strong>${et.esc(broker.licenseNumber)}</strong>`) : '')
        + et.p('Ingresa a tu dashboard para aprobar o rechazar la solicitud.')
        + et.button('Ver Dashboard', `${BASE_URL}/broker`),
    })
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
router.post('/leave', userAuth, brokerAuth, async (req, res) => {
  const broker = req.brokerUser;

  if (!broker.inmobiliaria_id)
    return res.status(400).json({ error: 'No estás afiliado a ninguna inmobiliaria' });

  // D1: transfer open applications away from the leaving broker so they
  // don't dangle on a non-existent team relation.
  const inmId = broker.inmobiliaria_id;
  const inm   = store.getUserById(inmId);
  let transferToUserId = (req.body?.transferToUserId || '').toString() || inmId;

  // Validate target belongs to same team (or is the owner itself)
  const target = store.getUserById(transferToUserId);
  if (!target || (target.id !== inmId && target.inmobiliaria_id !== inmId)) {
    return res.status(400).json({
      error: 'El usuario destino no pertenece al mismo equipo.',
      code:  'invalid_transfer_target',
    });
  }

  try {
    await reassignBrokerApplications(broker.id, transferToUserId, 'broker_left');
  } catch (err) {
    console.error('[inmobiliaria/leave] reassignment failed:', err.message);
    // Continue — better to log and let the broker leave than to block.
  }

  broker.inmobiliaria_id          = null;
  broker.inmobiliaria_name        = null;
  broker.inmobiliaria_join_status = null;
  broker.inmobiliaria_joined_at   = null;
  // P1 #21 — broker voluntarily left; their JWT still carries the old
  // inmobiliaria_id and access_level. Invalidate to force re-login so
  // teamAuth can't be exploited mid-session against the stale claim.
  bumpTokenVersion(broker);
  store.saveUser(broker);

  res.json({ success: true });
});

// ── Helper: rewrite open applications from one broker to another ─────
// D1 — when a broker leaves or is removed, their open applications
// would otherwise dangle. Walk every open app for the leaving broker
// and rewrite the broker block + emit a `broker_reassigned` timeline
// event. Closed apps (rechazado/completado) are left untouched.
async function reassignBrokerApplications(fromUserId, toUserId, reason) {
  const target = store.getUserById(toUserId);
  if (!target) return;

  const apps = (typeof store.getApplicationsByBroker === 'function'
    ? store.getApplicationsByBroker(fromUserId)
    : store.getApplications().filter(a => a.broker?.user_id === fromUserId));

  const TERMINAL = ['rechazado', 'completado'];
  for (const app of apps) {
    if (TERMINAL.includes(app.status)) continue;
    const newBroker = {
      user_id:     target.id,
      name:        target.name || '',
      email:       target.email || '',
      phone:       target.phone || '',
      agency_name: target.agency?.name || target.companyName || target.inmobiliaria_name || '',
    };
    if (!app.timeline_events) app.timeline_events = [];
    app.timeline_events.push({
      id:          'evt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      type:        'broker_reassigned',
      description: `Aplicación reasignada a ${newBroker.name || 'otro miembro del equipo'} (${reason})`,
      actor:       'system',
      actor_name:  'Sistema',
      data:        { from: fromUserId, to: toUserId, reason },
      created_at:  new Date().toISOString(),
    });
    app.broker     = newBroker;
    app.broker_id  = target.id;
    app.updated_at = new Date().toISOString();

    await store.withTransaction(async (client) => {
      await store.saveApplication(app, client);
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// ── GET /brokers ── Inmobiliaria: see team + pending requests
// ══════════════════════════════════════════════════════════════════
router.get('/brokers', userAuth, teamAuth(LEVEL_GERENTE), (req, res) => {
  const inmId = req.inmobiliariaId;
  const inm = OWNER_ROLES.includes(req.teamUser.role) ? req.teamUser : store.getUserById(inmId);

  const brokers = store.getUsersByInmobiliaria(inmId).map(b => ({
    id:            b.id,
    name:          b.name,
    email:         b.email,
    phone:         b.phone || '',
    role:          b.role,
    licenseNumber: b.licenseNumber || '',
    jobTitle:      b.jobTitle || '',
    team_title:    b.team_title || '',
    access_level:  b.access_level || LEVEL_ASISTENTE,
    joined_at:     b.inmobiliaria_joined_at || b.createdAt,
    app_count:     store.getApplicationsByBroker(b.id).length,
    avatarUrl:     b.avatarUrl || null,
  }));

  const pending_requests = (inm?.join_requests || [])
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

  res.json({ brokers, pending_requests });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/approve ── Inmobiliaria approves
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/approve', userAuth, teamAuth(LEVEL_DIRECTOR), (req, res) => {
  const inm = OWNER_ROLES.includes(req.teamUser.role) ? req.teamUser : store.getUserById(req.inmobiliariaId);
  const broker = store.getUserById(req.params.brokerId);

  if (!broker || !['broker', 'agency'].includes(broker.role))
    return res.status(404).json({ error: 'Agente no encontrado' });

  // Block approval if broker is already linked to a different inmobiliaria
  if (broker.inmobiliaria_id && broker.inmobiliaria_id !== inm.id)
    return res.status(400).json({ error: 'Este agente ya esta afiliado a otra inmobiliaria. Debe salir de esa organizacion antes.' });

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
  broker.access_level              = LEVEL_ASISTENTE;
  broker.team_title                = '';
  store.saveUser(broker);

  // Notify broker
  send(broker.email,
    `Solicitud aprobada — ${inm.companyName || inm.name}`,
    et.layout({
      title: 'Solicitud Aprobada',
      headerColor: et.C.green,
      preheader: `Tu solicitud a ${inm.companyName || inm.name} fue aprobada`,
      body:
        et.alertBox(`Tu solicitud de afiliacion a <strong>${et.esc(inm.companyName || inm.name)}</strong> ha sido aprobada.`, 'success')
        + et.p('Ahora formas parte del equipo. Tus nuevas aplicaciones seran visibles para la inmobiliaria.')
        + et.button('Ir al Dashboard', `${BASE_URL}/broker`),
    })
  );

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/reject ── Inmobiliaria rejects
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/reject', userAuth, teamAuth(LEVEL_DIRECTOR), (req, res) => {
  const inm = OWNER_ROLES.includes(req.teamUser.role) ? req.teamUser : store.getUserById(req.inmobiliariaId);
  const broker = store.getUserById(req.params.brokerId);

  if (!broker)
    return res.status(404).json({ error: 'Agente no encontrado' });

  // Block rejection if broker is already linked to a different inmobiliaria
  if (broker.inmobiliaria_id && broker.inmobiliaria_id !== inm.id)
    return res.status(400).json({ error: 'Este agente ya esta afiliado a otra inmobiliaria. Debe salir de esa organizacion antes.' });

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
    `Solicitud de afiliacion — ${inm.companyName || inm.name}`,
    et.layout({
      title: 'Solicitud No Aprobada',
      headerColor: et.C.red,
      preheader: `Tu solicitud a ${inm.companyName || inm.name} no fue aprobada`,
      body:
        et.alertBox(`Tu solicitud para afiliarte a <strong>${et.esc(inm.companyName || inm.name)}</strong> no fue aprobada en esta ocasion.`, 'danger')
        + et.p('Puedes intentar con otra inmobiliaria desde tu dashboard.')
        + et.button('Ir al Dashboard', `${BASE_URL}/broker`),
    })
  );

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /brokers/:brokerId/remove ── Inmobiliaria removes broker
// ══════════════════════════════════════════════════════════════════
router.post('/brokers/:brokerId/remove', userAuth, teamAuth(LEVEL_DIRECTOR), async (req, res) => {
  const broker = store.getUserById(req.params.brokerId);

  if (!broker || broker.inmobiliaria_id !== req.inmobiliariaId)
    return res.status(404).json({ error: 'Agente no encontrado en tu inmobiliaria' });

  // D1: pick a transfer target. Default to the inmobiliaria owner.
  let transferToUserId = (req.body?.transferToUserId || '').toString() || req.inmobiliariaId;
  const target = store.getUserById(transferToUserId);
  if (!target || (target.id !== req.inmobiliariaId && target.inmobiliaria_id !== req.inmobiliariaId)) {
    return res.status(400).json({
      error: 'El usuario destino no pertenece al mismo equipo.',
      code:  'invalid_transfer_target',
    });
  }
  if (target.id === broker.id) {
    return res.status(400).json({
      error: 'No se pueden transferir aplicaciones al mismo agente que estás retirando.',
      code:  'invalid_transfer_target',
    });
  }

  try {
    await reassignBrokerApplications(broker.id, transferToUserId, 'broker_removed');
  } catch (err) {
    console.error('[inmobiliaria/remove] reassignment failed:', err.message);
    // Continue — broker still gets removed.
  }

  broker.inmobiliaria_id          = null;
  broker.inmobiliaria_name        = null;
  broker.inmobiliaria_join_status = null;
  broker.inmobiliaria_joined_at   = null;
  broker.access_level             = null;
  broker.team_title               = null;
  // P1 #21 — broker was removed from the team; their JWT may still
  // carry inmobiliaria_id/access_level claims (or be relied on by
  // teamAuth elsewhere), so invalidate it.
  bumpTokenVersion(broker);
  store.saveUser(broker);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /profile ── Inmobiliaria public profile info
// D7: merged with the second handler that lived at ~594 (added
// companyDescription + coverImage by parsing the profile JSON blob).
// Keeping a single handler so `team` members and owners both get the
// full payload without Express silently dropping the duplicate.
// ══════════════════════════════════════════════════════════════════
router.get('/profile', userAuth, teamAuth(LEVEL_ASISTENTE), (req, res) => {
  const inm = OWNER_ROLES.includes(req.teamUser.role) ? req.teamUser : store.getUserById(req.inmobiliariaId);
  const { passwordHash, resetToken, resetTokenExpiry, ...safe } = inm;
  // Hydrate the company profile JSON blob (companyDescription, tagline,
  // coverImage, social, etc.) so callers don't need a 2nd request.
  const profile = typeof inm.profile === 'string'
    ? (() => { try { return JSON.parse(inm.profile || '{}'); } catch { return {}; } })()
    : (inm.profile || {});
  safe.profile             = profile;
  safe.companyDescription  = profile.companyDescription || '';
  safe.coverImage          = profile.coverImage || '';
  res.json(safe);
});

// ══════════════════════════════════════════════════════════════════
// ── GET /brokers/:brokerId/details ── Full broker info + recent apps
// ══════════════════════════════════════════════════════════════════
router.get('/brokers/:brokerId/details', userAuth, teamAuth(LEVEL_GERENTE), (req, res) => {
  const broker = store.getUserById(req.params.brokerId);
  if (!broker || broker.inmobiliaria_id !== req.inmobiliariaId)
    return res.status(404).json({ error: 'Agente no encontrado' });

  const apps = store.getApplicationsByBroker(broker.id)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 10)
    .map(a => ({ id: a.id, title: a.listing_title, status: a.status, updated_at: a.updated_at, client: a.client?.name }));

  res.json({
    id: broker.id, name: broker.name, email: broker.email, phone: broker.phone || '',
    licenseNumber: broker.licenseNumber || '', role: broker.role,
    jobTitle: broker.jobTitle || '',
    team_title: broker.team_title || '',
    access_level: broker.access_level || LEVEL_ASISTENTE,
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
router.post('/brokers/:brokerId/send-reset', userAuth, teamAuth(LEVEL_DIRECTOR), async (req, res) => {
  const inm = OWNER_ROLES.includes(req.teamUser.role) ? req.teamUser : store.getUserById(req.inmobiliariaId);
  const broker = store.getUserById(req.params.brokerId);
  if (!broker || broker.inmobiliaria_id !== req.inmobiliariaId)
    return res.status(404).json({ error: 'Agente no encontrado' });

  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  broker.resetToken       = tokenHash;
  broker.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  store.saveUser(broker);

  send(broker.email, 'Restablecer tu contrasena — HogaresRD',
    et.layout({
      title: 'Restablecer Contrasena',
      preheader: 'Solicitud para restablecer tu contrasena en HogaresRD',
      body:
        et.p(`Hola <strong>${et.esc(broker.name)}</strong>,`)
        + et.p(`El administrador de <strong>${et.esc(inm.name || 'tu inmobiliaria')}</strong> ha solicitado restablecer tu contrasena. Haz clic a continuacion para crear una nueva.`)
        + et.alertBox('Este enlace expira en 1 hora.', 'warning')
        + et.button('Restablecer Contrasena', `${BASE_URL}/reset-password?token=${rawToken}`),
    }));

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── PATCH /brokers/:brokerId/notes ── Save internal notes
// ══════════════════════════════════════════════════════════════════
router.patch('/brokers/:brokerId/notes', userAuth, teamAuth(LEVEL_GERENTE), (req, res) => {
  const broker = store.getUserById(req.params.brokerId);
  if (!broker || broker.inmobiliaria_id !== req.inmobiliariaId)
    return res.status(404).json({ error: 'Agente no encontrado' });

  broker.inm_notes = (req.body.notes || '').trim().slice(0, 1000);
  store.saveUser(broker);
  res.json({ success: true });
});

// ── Secretary Management ──────────────────────────────────────────────────

router.get('/secretaries', userAuth, teamAuth(LEVEL_DIRECTOR), (req, res) => {
  const secretaries = store.getSecretariesByInmobiliaria(req.inmobiliariaId);
  res.json({
    secretaries: secretaries.map(s => ({
      id: s.id, name: s.name, email: s.email, phone: s.phone,
      avatarUrl: s.avatarUrl || null,
      joinedAt: s.inmobiliaria_joined_at || s.createdAt,
    })),
  });
});

router.post('/secretaries/invite', userAuth, teamAuth(LEVEL_DIRECTOR), (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  // Check if user already exists
  const existing = store.getUserByEmail(email);
  if (existing) return res.status(400).json({ error: 'Este correo ya está registrado' });

  const token = crypto.randomBytes(32).toString('hex');
  const user = OWNER_ROLES.includes(req.teamUser.role) ? req.teamUser : store.getUserById(req.inmobiliariaId);

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
  send(email, `Invitacion como Secretaria — ${user.agencyName || user.name} en HogaresRD`,
    et.layout({
      title: 'Invitacion de Secretaria',
      preheader: `${user.agencyName || user.name} te invita como secretaria en HogaresRD`,
      body:
        et.p(`<strong>${et.esc(user.agencyName || user.name)}</strong> te ha invitado como secretaria en HogaresRD.`)
        + et.p('Como secretaria, podras gestionar aplicaciones, aprobar pagos de clientes y acceder al panel de la inmobiliaria.')
        + et.button('Aceptar invitacion', inviteUrl),
    }));

  res.json({ success: true, message: 'Invitación enviada' });
});

router.post('/secretaries/:id/remove', userAuth, teamAuth(LEVEL_DIRECTOR), (req, res) => {
  const secretary = store.getUserById(req.params.id);
  if (!secretary || secretary.role !== 'secretary' || secretary.inmobiliaria_id !== req.inmobiliariaId)
    return res.status(404).json({ error: 'Secretaria no encontrada' });

  secretary.role = 'deactivated';
  secretary.inmobiliaria_id = null;
  secretary.deactivatedAt = new Date().toISOString();
  // P1 #21 — secretary lost their role; revoke any existing JWT.
  bumpTokenVersion(secretary);
  store.saveUser(secretary);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── RBAC: Get my access level ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/my-access', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  let accessLevel, inmobiliariaId;
  if (OWNER_ROLES.includes(user.role)) {
    accessLevel = LEVEL_DIRECTOR;
    inmobiliariaId = user.id;
  } else if (user.inmobiliaria_id) {
    accessLevel = user.access_level || LEVEL_ASISTENTE;
    inmobiliariaId = user.inmobiliaria_id;
  } else {
    return res.json({ access_level: 0, team_title: '', inmobiliaria_id: null, role: user.role,
      can: { view_team: false, approve_payments: false, manage_team: false, view_billing: false } });
  }

  res.json({
    access_level:    accessLevel,
    access_label:    LEVEL_LABELS[accessLevel] || '',
    team_title:      user.team_title || '',
    inmobiliaria_id: inmobiliariaId,
    role:            user.role,
    can: {
      view_team:        accessLevel >= LEVEL_GERENTE,
      approve_payments: accessLevel >= LEVEL_GERENTE,
      view_analytics:   accessLevel >= LEVEL_GERENTE,
      manage_team:      accessLevel >= LEVEL_DIRECTOR,
      assign_roles:     accessLevel >= LEVEL_DIRECTOR,
      view_billing:     accessLevel >= LEVEL_DIRECTOR,
      invite_members:   accessLevel >= LEVEL_DIRECTOR,
    },
  });
});

// ══════════════════════════════════════════════════════════════════
// ── RBAC: Assign role + title to a team member ────────────────
// ══════════════════════════════════════════════════════════════════
router.put('/team/:userId/role', userAuth, teamAuth(LEVEL_DIRECTOR), (req, res) => {
  const target = store.getUserById(req.params.userId);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Target must belong to the same inmobiliaria
  if (target.inmobiliaria_id !== req.inmobiliariaId && target.id !== req.inmobiliariaId)
    return res.status(403).json({ error: 'Este usuario no pertenece a tu equipo' });

  // Cannot change owner's level
  if (OWNER_ROLES.includes(target.role))
    return res.status(400).json({ error: 'No se puede cambiar el nivel del propietario' });

  const { access_level, team_title } = req.body;
  // P1 #21 — capture the prior level so we can detect a *downgrade*
  // and bump tokenVersion only in that direction. Lateral moves (same
  // level, title-only edits) and upgrades do not invalidate tokens.
  const priorLevel = Number(target.access_level || LEVEL_ASISTENTE);
  let didDowngrade = false;
  if (access_level !== undefined) {
    const level = Number(access_level);
    if (![LEVEL_ASISTENTE, LEVEL_GERENTE, LEVEL_DIRECTOR].includes(level))
      return res.status(400).json({ error: 'Nivel de acceso inválido (1, 2 o 3)' });
    if (level < priorLevel) didDowngrade = true;
    target.access_level = level;
  }
  if (team_title !== undefined) {
    target.team_title = String(team_title).trim().slice(0, 100);
  }

  if (didDowngrade) bumpTokenVersion(target);
  store.saveUser(target);
  res.json({
    success: true,
    access_level: target.access_level || LEVEL_ASISTENTE,
    team_title: target.team_title || '',
    access_label: LEVEL_LABELS[target.access_level] || LEVEL_LABELS[LEVEL_ASISTENTE],
  });
});

// ══════════════════════════════════════════════════════════════════════════
// COMPANY PROFILE (public + editable)
// D7: the duplicate GET /profile that used to live here was merged into
// the canonical handler near line ~382 (Express dispatches the FIRST
// match, so this one was unreachable). Both companyDescription and
// coverImage now flow through the single handler.
// ══════════════════════════════════════════════════════════════════════════

// PATCH /profile — update company profile (Director only)
router.patch('/profile', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  if (!['inmobiliaria', 'constructora'].includes(user.role))
    return res.status(403).json({ error: 'Solo el dueño puede editar el perfil de empresa' });

  const profile = typeof user.profile === 'string' ? JSON.parse(user.profile || '{}') : (user.profile || {});
  const { companyDescription, tagline, coverImage, website, social, yearsInBusiness,
          officeAddress, officeHours, certifications } = req.body;

  if (companyDescription !== undefined) profile.companyDescription = String(companyDescription).slice(0, 5000);
  if (tagline !== undefined)            profile.tagline = String(tagline).slice(0, 200);
  if (coverImage !== undefined)         profile.coverImage = String(coverImage).slice(0, 500);
  if (website !== undefined)            profile.website = String(website).slice(0, 200);
  if (social !== undefined)             profile.social = {
    facebook:  String(social.facebook  || '').slice(0, 200),
    instagram: String(social.instagram || '').slice(0, 200),
    linkedin:  String(social.linkedin  || '').slice(0, 200),
    whatsapp:  String(social.whatsapp  || '').slice(0, 20),
  };
  if (yearsInBusiness !== undefined) profile.yearsInBusiness = Math.max(0, Math.min(100, Number(yearsInBusiness) || 0));
  if (officeAddress !== undefined)   profile.officeAddress = String(officeAddress).slice(0, 300);
  if (officeHours !== undefined)     profile.officeHours = String(officeHours).slice(0, 100);
  if (certifications !== undefined)  profile.certifications = Array.isArray(certifications) ? certifications.slice(0, 10).map(c => String(c).slice(0, 100)) : [];

  user.profile = profile;
  store.saveUser(user);
  res.json({ success: true, profile });
});

// ══════════════════════════════════════════════════════════════════════════
// POSTS (social updates + articles)
// ══════════════════════════════════════════════════════════════════════════

router.get('/posts', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  const inmId = ['inmobiliaria', 'constructora'].includes(user.role) ? user.id : user.inmobiliaria_id;
  if (!inmId) return res.status(400).json({ error: 'No perteneces a una inmobiliaria' });
  const posts = store.getInmobPosts(inmId).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(posts);
});

router.post('/posts', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  const inmId = ['inmobiliaria', 'constructora'].includes(user.role) ? user.id : user.inmobiliaria_id;
  if (!inmId) return res.status(403).json({ error: 'No autorizado' });

  const { post_type, title, content, image } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Contenido requerido' });

  const post = {
    id:               'ipost_' + crypto.randomBytes(8).toString('hex'),
    inmobiliaria_id:  inmId,
    post_type:        post_type === 'article' ? 'article' : 'update',
    title:            post_type === 'article' ? String(title || '').slice(0, 200) : null,
    content:          String(content).slice(0, post_type === 'article' ? 20000 : 500),
    image:            image || null,
    published:        1,
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  };
  store.saveInmobPost(post);
  res.status(201).json(post);
});

router.put('/posts/:id', userAuth, (req, res) => {
  const post = store.getInmobPostById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post no encontrado' });
  const user = store.getUserById(req.user.sub);
  const inmId = ['inmobiliaria', 'constructora'].includes(user?.role) ? user.id : user?.inmobiliaria_id;
  if (post.inmobiliaria_id !== inmId) return res.status(403).json({ error: 'No autorizado' });

  if (req.body.title !== undefined)   post.title   = String(req.body.title).slice(0, 200);
  if (req.body.content !== undefined) post.content  = String(req.body.content).slice(0, post.post_type === 'article' ? 20000 : 500);
  if (req.body.image !== undefined)   post.image    = req.body.image || null;
  post.updated_at = new Date().toISOString();
  store.saveInmobPost(post);
  res.json(post);
});

router.delete('/posts/:id', userAuth, (req, res) => {
  const post = store.getInmobPostById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post no encontrado' });
  const user = store.getUserById(req.user.sub);
  const inmId = ['inmobiliaria', 'constructora'].includes(user?.role) ? user.id : user?.inmobiliaria_id;
  if (post.inmobiliaria_id !== inmId) return res.status(403).json({ error: 'No autorizado' });
  store.deleteInmobPost(post.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// REVIEWS (public submit + admin manage)
// ══════════════════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');
const reviewLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, message: { error: 'Demasiadas reseñas. Intenta más tarde.' } });

// Public: get approved reviews for an inmobiliaria
router.get('/:inmId/reviews', (req, res) => {
  const reviews = store.getApprovedInmobReviews(req.params.inmId);
  const avg = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : null;
  res.json({ reviews, average: avg ? parseFloat(avg) : null, count: reviews.length });
});

// Submit a review — via email invitation token OR authenticated with completed purchase
router.post('/:inmId/reviews', reviewLimiter, (req, res) => {
  const { rating, comment, token, app: appId, reviewer_name } = req.body;
  if (!rating) return res.status(400).json({ error: 'Calificación requerida' });
  const r = Math.max(1, Math.min(5, Number(rating) || 0));

  let name = '';
  let email = '';

  // Path 1: Token-based review (from email invitation)
  if (token && appId) {
    const application = store.getApplicationById(appId);
    if (!application) return res.status(404).json({ error: 'Aplicación no encontrada' });
    if (application.review_token !== token) return res.status(403).json({ error: 'Enlace de reseña inválido o ya utilizado.' });
    if (application.inmobiliaria_id !== req.params.inmId) return res.status(403).json({ error: 'Enlace no corresponde a esta inmobiliaria.' });
    if (application.status !== 'completado') return res.status(400).json({ error: 'La compra no está completada.' });

    name = application.client?.name || reviewer_name || 'Cliente';
    email = application.client?.email || '';

    // Invalidate the token (single use)
    application.review_token = null;
    application.review_submitted_at = new Date().toISOString();
    store.saveApplication(application);
  }
  // Path 2: Authenticated user with completed purchase
  else {
    const { userAuth } = require('./auth');
    // Manual auth check since middleware can't be conditional
    const cookieToken = req.cookies?.hrdt;
    const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const jwt = cookieToken || headerToken;
    if (!jwt) return res.status(401).json({ error: 'Inicia sesión o usa el enlace de invitación para dejar una reseña.' });

    let payload;
    try { const { verifyJWT } = require('./auth'); payload = verifyJWT(jwt); } catch { return res.status(401).json({ error: 'Sesión expirada' }); }

    const user = store.getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'No autenticado' });

    const apps = store.getApplications().filter(a =>
      a.status === 'completado' && a.inmobiliaria_id === req.params.inmId &&
      (a.client?.user_id === user.id || (a.client?.email && a.client.email.toLowerCase() === user.email.toLowerCase()))
    );
    if (!apps.length) return res.status(403).json({ error: 'Solo clientes con una compra completada pueden dejar reseñas.', code: 'no_completed_purchase' });

    name = user.name;
    email = user.email;
  }

  // Prevent duplicate reviews
  if (email) {
    const existing = store.getInmobReviews(req.params.inmId).find(r =>
      r.reviewer_email && r.reviewer_email.toLowerCase() === email.toLowerCase()
    );
    if (existing) return res.status(400).json({ error: 'Ya dejaste una reseña para esta inmobiliaria.' });
  }

  const review = {
    id:               'irev_' + crypto.randomBytes(8).toString('hex'),
    inmobiliaria_id:  req.params.inmId,
    reviewer_name:    String(name).slice(0, 100),
    reviewer_email:   email,
    rating:           r,
    comment:          String(comment || '').slice(0, 1000),
    status:           'pending',
    created_at:       new Date().toISOString(),
  };
  store.saveInmobReview(review);
  res.status(201).json({ success: true, message: 'Tu reseña ha sido enviada y será revisada por la inmobiliaria. ¡Gracias!' });
});

// Send review invitation email to a client with a completed purchase
router.post('/reviews/invite', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !['inmobiliaria', 'constructora'].includes(user.role))
    return res.status(403).json({ error: 'Solo inmobiliarias pueden enviar invitaciones de reseña' });

  const { application_id } = req.body;
  if (!application_id) return res.status(400).json({ error: 'ID de aplicación requerido' });

  const app = store.getApplicationById(application_id);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });
  if (app.inmobiliaria_id !== user.id) return res.status(403).json({ error: 'No autorizado' });
  if (app.status !== 'completado') return res.status(400).json({ error: 'Solo se pueden solicitar reseñas de compras completadas' });
  if (!app.client?.email) return res.status(400).json({ error: 'El cliente no tiene email registrado' });

  // Generate a unique review token
  const reviewToken = crypto.randomBytes(16).toString('hex');
  const reviewUrl = `${BASE_URL}/resena/${user.id}?token=${reviewToken}&app=${application_id}`;

  // Store the token on the application for verification
  if (!app._extra) app._extra = {};
  app.review_token = reviewToken;
  app.review_invited_at = new Date().toISOString();
  store.saveApplication(app);

  // Send email
  send(app.client.email, `${user.name} te invita a dejar una resena — HogaresRD`,
    et.layout({
      title: 'Como fue tu experiencia?',
      preheader: `${user.name} te invita a compartir tu experiencia`,
      body:
        et.p(`Hola <strong>${et.esc(app.client.name || '')}</strong>,`)
        + et.p(`<strong>${et.esc(user.name)}</strong> te invita a compartir tu experiencia sobre la compra de <strong>${et.esc(app.listing_title || 'tu propiedad')}</strong>.`)
        + et.p('Tu opinion ayuda a otros compradores a tomar mejores decisiones.')
        + et.button('Dejar mi resena', reviewUrl)
        + et.small('Este enlace es personal y de uso unico.'),
    })
  );

  res.json({ success: true, message: `Invitación enviada a ${app.client.email}` });
});

// Authenticated: manage reviews (approve/reject)
router.post('/reviews/:id/approve', userAuth, (req, res) => {
  const review = store.getInmobReviewById(req.params.id);
  if (!review) return res.status(404).json({ error: 'Reseña no encontrada' });
  const user = store.getUserById(req.user.sub);
  if (!['inmobiliaria', 'constructora'].includes(user?.role) || user.id !== review.inmobiliaria_id)
    return res.status(403).json({ error: 'No autorizado' });
  review.status = 'approved';
  store.saveInmobReview(review);
  res.json({ success: true });
});

router.post('/reviews/:id/reject', userAuth, (req, res) => {
  const review = store.getInmobReviewById(req.params.id);
  if (!review) return res.status(404).json({ error: 'Reseña no encontrada' });
  const user = store.getUserById(req.user.sub);
  if (!['inmobiliaria', 'constructora'].includes(user?.role) || user.id !== review.inmobiliaria_id)
    return res.status(403).json({ error: 'No autorizado' });
  review.status = 'rejected';
  store.saveInmobReview(review);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ── D2: GET /pending-approvals — owner-only queue ─────────────────
// Returns the list of pending status-change recommendations submitted
// by team members (typically secretaries) for the caller's
// inmobiliaria. Owners see their queue; team members are blocked
// (the queue is the owner's inbox).
// ══════════════════════════════════════════════════════════════════
router.get('/pending-approvals', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!OWNER_ROLES.includes(user.role)) {
    return res.status(403).json({ error: 'Solo el propietario puede ver esta cola.' });
  }
  const queue = store.getPendingApprovals(user.id) || [];
  res.json({ pending: queue });
});

// ══════════════════════════════════════════════════════════════════
// ── D9: PATCH /cascade-capacity — toggle capacity-aware cascade ───
// Owners can opt the team's lead distribution into capacity-aware
// ordering. Stored on the owner's user record.
// ══════════════════════════════════════════════════════════════════
router.patch('/cascade-capacity', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!OWNER_ROLES.includes(user.role)) {
    return res.status(403).json({ error: 'Solo el propietario puede cambiar este ajuste.' });
  }
  user.cascade_capacity_aware = req.body?.enabled === true;
  store.saveUser(user);
  res.json({ success: true, cascade_capacity_aware: user.cascade_capacity_aware });
});

module.exports = router;
