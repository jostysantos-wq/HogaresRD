const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const rateLimit  = require('express-rate-limit');
const store      = require('./store');
const { logSec } = require('./security-log');
const et         = require('../utils/email-templates');

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET; // required — enforced at startup by server.js
// Rotation support: tokens signed under JWT_SECRET_PREV still verify during
// the grace window after a key rotation. Operator rotates by:
//   1. copy current JWT_SECRET to JWT_SECRET_PREV
//   2. generate + set a new JWT_SECRET
//   3. wait 14 days (max token lifetime) — old tokens expire naturally
//   4. remove JWT_SECRET_PREV from .env
const JWT_SECRET_PREV = process.env.JWT_SECRET_PREV || null;
const BASE_URL   = process.env.BASE_URL || 'http://localhost:3000';

/** Verify a JWT against the current secret, falling back to the previous
 * one during rotation windows. Re-throws the original error if neither
 * secret validates the token. */
function verifyJWT(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (JWT_SECRET_PREV) {
      try { return jwt.verify(token, JWT_SECRET_PREV); } catch {}
    }
    throw err;
  }
}

// ── Rate limiters ─────────────────────────────────────────────────────────
// Tight limit on login / registration — these are the brute-force targets.
const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              10,              // 10 attempts per window per IP
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Demasiados intentos. Intenta nuevamente en 15 minutos.' },
  skipSuccessfulRequests: true,      // only count failures toward the limit
});

// Slightly looser limit for password-reset to avoid blocking legitimate users
const resetLimiter = rateLimit({
  windowMs:  60 * 60 * 1000, // 1 hour
  max:       5,               // 5 reset requests per hour per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message:   { error: 'Demasiadas solicitudes de restablecimiento. Intenta en una hora.' },
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta en una hora.' },
});

const twoFALimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de verificación. Intenta en 15 minutos.' },
});

const { createTransport } = require('./mailer');
const transporter = createTransport();

function signToken(user) {
  // jti (JWT ID) is a unique identifier per-token, used for revocation (Sprint 3)
  // 14-day expiry — shorter than the original 30d so stolen tokens decay
  // faster. Users who want long-lived sessions can enable "Remember me"
  // (bumps to 30d) or biometric on iOS (regenerates on demand).
  const jti = crypto.randomUUID();
  return jwt.sign({ sub: user.id, role: user.role, name: user.name, jti }, JWT_SECRET, { expiresIn: '14d' });
}

function safeUser(user) {
  const { passwordHash, resetToken, resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, biometricTokenHash, ...safe } = user;
  return safe;
}

// Password must be 10+ chars with upper, lower, digit, and special character.
// 10-char min is a modest upgrade over 8 — it roughly quadruples brute-force
// search space without being annoying for users to remember.
function validatePassword(password) {
  if (!password || password.length < 10)
    return 'La contraseña debe tener al menos 10 caracteres';
  if (!/[A-Z]/.test(password))
    return 'La contraseña debe incluir al menos una letra mayúscula (A-Z)';
  if (!/[a-z]/.test(password))
    return 'La contraseña debe incluir al menos una letra minúscula (a-z)';
  if (!/[0-9]/.test(password))
    return 'La contraseña debe incluir al menos un número (0-9)';
  if (!/[^A-Za-z0-9]/.test(password))
    return 'La contraseña debe incluir al menos un carácter especial (!@#$%^&*)';
  return null;
}

// Strict email validator — RFC-lite pattern that also rejects CR/LF so the
// value can never be used to inject SMTP headers downstream.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
function validateEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  if (/[\r\n]/.test(email)) return false;
  return EMAIL_RE.test(email.trim());
}

// ── Login anomaly detection ────────────────────────────────────────────────
// Hash IPs (never store raw) and compare against the user's known set.
// Unknown IP triggers an email alert. Keeps last 10 known IP hashes.
function hashIP(ip) {
  return crypto.createHash('sha256').update(String(ip || '') + JWT_SECRET).digest('hex').slice(0, 16);
}

function clientIPFromReq(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';
}

/** Called on successful login. Appends the current IP hash to the user's
 * known list. If this IP has never been seen, fires an async alert email
 * to the user (fire-and-forget). Returns true if alert was sent. */
function trackLoginAndAlert(user, req) {
  const ip    = clientIPFromReq(req);
  const ipHash = hashIP(ip);
  const ua     = (req.headers['user-agent'] || '').slice(0, 200);
  const known  = Array.isArray(user.knownIPs) ? user.knownIPs : [];
  const isNew  = !known.includes(ipHash);

  const updated = isNew ? [...known, ipHash].slice(-10) : known;
  user.knownIPs   = updated;
  user.lastLoginAt = new Date().toISOString();
  user.lastLoginIPHash = ipHash;
  store.saveUser(user);

  if (isNew && known.length > 0) {
    // Not the user's VERY first login — this is a new device/network.
    logSec('login_new_device', req, { userId: user.id });
    sendNewDeviceAlert(user, ip, ua).catch(err =>
      console.error('[auth] new-device alert failed:', err.message)
    );
  }
  return isNew && known.length > 0;
}

async function sendNewDeviceAlert(user, ip, userAgent) {
  if (!user.email) return;
  const when = new Date().toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo' });
  try {
    await transporter.sendMail({
      to:      user.email,
      subject: 'Nuevo inicio de sesion detectado — HogaresRD',
      html: et.layout({
        title: 'Nuevo inicio de sesion',
        subtitle: 'Se detecto acceso desde un dispositivo nuevo',
        preheader: 'Se inicio sesion en tu cuenta desde un dispositivo o red nueva',
        headerColor: '#b45309',
        body: `
          ${et.p('Detectamos un inicio de sesion en tu cuenta desde un dispositivo o red que no reconocemos.')}
          ${et.infoTable(
            et.infoRow('Fecha', when) +
            et.infoRow('IP', ip) +
            et.infoRow('Navegador', et.esc((userAgent || '').slice(0, 100)))
          )}
          ${et.alertBox('Si no reconoces esta actividad, cambia tu contrasena inmediatamente desde tu perfil.', 'danger')}
          ${et.button('Cambiar contrasena', BASE_URL + '/reset-password')}
        `,
      }),
    });
  } catch {}
}

// Generates a SHA-256-hashed verification token, attaches fields to user in place,
// and returns the raw (unhashed) token to embed in the email link.
function attachVerifyToken(user) {
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  user.emailVerified     = false;
  user.emailVerifyToken  = hash;
  user.emailVerifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 h
  return raw;
}

function sendVerificationEmail(user, rawToken) {
  const verifyUrl = `${BASE_URL}/verify-email?token=${rawToken}`;
  return transporter.sendMail({
    to:         user.email,
    subject:    'Verifica tu correo — HogaresRD',
    department: 'soporte',
    html: et.layout({
      title: 'Verifica tu correo electronico',
      subtitle: 'Un paso mas para activar tu cuenta',
      preheader: 'Confirma tu direccion de correo para completar tu registro en HogaresRD',
      body: `
        ${et.p('Haz clic en el boton de abajo para verificar tu direccion de correo y activar tu cuenta. Este enlace expira en <strong>24 horas</strong>.')}
        ${et.button('Verificar mi correo', verifyUrl)}
        ${et.divider()}
        ${et.small('Si no creaste esta cuenta, ignora este correo. No se realizara ningun cambio.')}
      `,
    }),
  }).catch(err => console.error('Verification email error:', err.message));
}

function send2FAEmail(user, code) {
  return transporter.sendMail({
    to:         user.email,
    department: 'soporte',
    subject:    'Codigo de verificacion — HogaresRD',
    html: et.layout({
      title: 'Verificacion de identidad',
      subtitle: 'Ingresa este codigo para continuar',
      preheader: 'Tu codigo de seguridad para iniciar sesion en HogaresRD',
      body: `
        ${et.codeBlock(code)}
        ${et.p('Ingresa este codigo en tu dispositivo para completar el inicio de sesion. Expira en <strong>5 minutos</strong>.')}
        ${et.divider()}
        ${et.alertBox('Si no solicitaste este codigo, ignora este correo. Tu cuenta permanece segura.', 'warning')}
        ${et.small('Nunca compartas este codigo con terceros. HogaresRD nunca te pedira tu codigo por telefono o mensaje.')}
      `,
    }),
  }).catch(err => console.error('2FA email error:', err.message));
}

// Cookie name for the JWT (short to save bandwidth)
const COOKIE_NAME = 'hrdt';
const IS_PROD     = process.env.NODE_ENV === 'production';

// ── Auth middleware (exported for other routes) ────────────────────────────
// Accepts either an httpOnly cookie (preferred) or a Bearer token in the
// Authorization header (kept for backward-compat with existing 30-day sessions
// and API clients that can't use cookies).
function userAuth(req, res, next) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  // Fallback: query-string token. Only honored for GET requests so that POST
  // bodies cannot bypass CSRF protection. This is what lets native apps
  // open protected files (receipts, document previews) in SFSafariViewController
  // which cannot attach custom headers.
  const queryToken = req.method === 'GET' ? (req.query?.token || '').trim() : '';
  const token = cookieToken || headerToken || queryToken;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = verifyJWT(token);

    // Sprint 3: check revocation list (handles forced logout / stolen-token invalidation)
    if (payload.jti && store.isTokenRevoked(payload.jti)) {
      logSec('token_rejected', req, { reason: 'revoked', userId: payload.sub });
      return res.status(401).json({ error: 'Sesión inválida. Inicia sesión de nuevo.' });
    }

    req.user = payload;
    next();
  } catch {
    logSec('token_rejected', req, { reason: 'invalid_jwt' });
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ── Register ───────────────────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, phone, marketingOptIn } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id:               `usr_${Date.now()}`,
      email:            email.toLowerCase().trim(),
      passwordHash,
      name:             name.trim(),
      phone:            phone?.trim() || '',
      createdAt:        new Date().toISOString(),
      lastLoginAt:      null,
      role:             'user',
      favorites:        [],
      profile: {
        preferredTypes:      [],
        preferredProvinces:  [],
        preferredCities:     [],
        priceMin:            0,
        priceMax:            0,
        bedroomsMin:         0,
        preferredTags:       [],
        preferredConditions: [],
        scoredAt:            null,
      },
      resetToken:        null,
      resetTokenExpiry:  null,
      marketingOptIn:    !!marketingOptIn,  // Explicit opt-in required (GDPR-safe)
    };

    const verifyRawToken = attachVerifyToken(user);
    store.saveUser(user);

    // Meta CAPI — CompleteRegistration (fire-and-forget)
    setImmediate(async () => {
      try {
        const meta = require('../utils/meta');
        await meta.trackCompleteRegistration({
          email: user.email, phone: user.phone, name: user.name,
          ip: req.ip, userAgent: req.headers['user-agent'],
          eventId: `reg_${user.id}`,
        });
      } catch (_) {}
    });

    // Welcome email — pull top 3 trending listings by views
    const allListings = store.getListings();
    const listingsArr = Array.isArray(allListings) ? allListings : (allListings.listings || []);
    const trending = listingsArr
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 3);

    const trendingCards = trending.length
      ? trending.map(l => et.listingCard(l)).join('') + et.buttonOutline('Ver todas las propiedades', BASE_URL + '/comprar')
      : '';

    transporter.sendMail({
      department: 'soporte',
      to:      user.email,
      subject: 'Bienvenido a HogaresRD — Tu cuenta esta activa',
      html: et.layout({
        title: 'Bienvenido a HogaresRD',
        subtitle: 'Tu cuenta esta lista. Explora propiedades en toda la Republica Dominicana.',
        preheader: 'Tu cuenta en HogaresRD esta activa. Descubre propiedades en toda la Republica Dominicana.',
        body: `
          ${et.p('Gracias por registrarte. Con tu cuenta puedes guardar favoritos, contactar inmobiliarias y recibir actualizaciones de las propiedades que te interesan.')}
          ${et.featureList([
            'Busca por ciudad, precio, tipo y mas filtros',
            'Explora propiedades en un mapa interactivo',
            'Contacta inmobiliarias directamente desde cada anuncio',
          ])}
          ${et.button('Explorar propiedades', BASE_URL + '/home')}
          ${trendingCards ? et.divider() + '<div style="margin-bottom:8px;font-size:0.75rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7a9bbf;">LO MAS VISTO</div>' + trendingCards : ''}
          ${et.divider()}
          ${et.small('Si tienes alguna pregunta, responde directamente a este correo.')}
        `,
      }),
    }).catch(err => console.error('Welcome email error:', err.message));

    sendVerificationEmail(user, verifyRawToken);
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Public: list registered inmobiliarias (for registration dropdowns) ────
router.get('/inmobiliarias', (req, res) => {
  try {
    const inms = store.getUsersByRole('inmobiliaria').map(u => ({
      id:   u.id,
      name: (u.companyName || u.agencyName || u.name || '').trim(),
    })).filter(u => u.name).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    res.json(inms);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener inmobiliarias' });
  }
});

// ── Register Agency ────────────────────────────────────────────────────────
router.post('/register/agency', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, agencyName, licenseNumber, phone, jobTitle, inmobiliariaId } = req.body;

    if (!name || !email || !password || !agencyName || !licenseNumber || !phone)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const refToken     = crypto.randomBytes(8).toString('hex');

    const user = {
      id:              `usr_${Date.now()}`,
      email:           email.toLowerCase().trim(),
      passwordHash,
      name:            name.trim(),
      phone:           phone.trim(),
      agencyName:      agencyName.trim(),
      licenseNumber:   licenseNumber.trim(),
      jobTitle:        (jobTitle || '').trim().slice(0, 60),
      refToken,
      createdAt:       new Date().toISOString(),
      lastLoginAt:     null,
      role:            'agency',
      // inmobiliaria_id is NEVER set at registration — only after the inmobiliaria approves
      inmobiliaria_id:           null,
      inmobiliaria_join_status:  inmobiliariaId ? 'pending' : null,
      inmobiliaria_pending_id:   inmobiliariaId ? inmobiliariaId.trim() : null,
      inmobiliaria_pending_name: inmobiliariaId ? agencyName.trim() : null,
      inmobiliaria_joined_at:    null,
      favorites:       [],
      resetToken:      null,
      resetTokenExpiry: null,
      marketingOptIn:  false,  // Explicit opt-in required
      subscriptionStatus: 'pending_payment',  // card required before trial starts
      trialEndsAt:     null,                    // trial not started until checkout
      paywallRequired: true,                    // new signups are paywalled
      stripeCustomerId:    null,
      stripeSubscriptionId: null,
    };

    const verifyRawToken = attachVerifyToken(user);
    store.saveUser(user);

    // ── If agent selected a registered inmobiliaria, add a join_request to their record ──
    if (inmobiliariaId) {
      try {
        const inm = store.getUserById(inmobiliariaId.trim());
        if (inm && (inm.role === 'inmobiliaria' || inm.role === 'constructora')) {
          if (!Array.isArray(inm.join_requests)) inm.join_requests = [];
          inm.join_requests.push({
            id:             `jr_${Date.now()}`,
            broker_id:      user.id,
            broker_name:    user.name,
            broker_email:   user.email,
            broker_license: user.licenseNumber || '',
            broker_phone:   user.phone || '',
            requested_at:   new Date().toISOString(),
            status:         'pending',
          });
          store.saveUser(inm);
          transporter.sendMail({
            department: 'soporte',
            to:      inm.email,
            subject: `Solicitud de afiliacion — ${user.name}`,
            html: et.layout({
              title: 'Nueva solicitud de afiliacion',
              preheader: `${user.name} solicito afiliarse a ${inm.companyName || inm.name}`,
              body: `
                ${et.p(`El agente <strong>${et.esc(user.name)}</strong> (${et.esc(user.email)}) solicito afiliarse a <strong>${et.esc(inm.companyName || inm.name)}</strong>.`)}
                ${user.licenseNumber ? et.infoTable(et.infoRow('Licencia', user.licenseNumber)) : ''}
                ${et.button('Ver solicitudes', BASE_URL + '/broker#team-requests')}
              `,
            }),
          }).catch(e => console.error('Inm notify email error:', e.message));
        }
      } catch (e) {
        console.error('Join request creation error:', e.message);
      }
    }

    transporter.sendMail({
      department: 'soporte',
      to:      user.email,
      subject: 'Bienvenido a HogaresRD — Tu cuenta de agencia esta lista',
      html: et.layout({
        title: `Bienvenido, ${name.split(' ')[0]}`,
        subtitle: `${agencyName} — Cuenta activa`,
        preheader: `Tu cuenta de agencia en HogaresRD esta activa. Codigo de agente: ${refToken}`,
        body: `
          ${et.p('Tu cuenta de agente esta activa. Desde tu dashboard puedes gestionar propiedades, generar enlaces afiliados y conectar con clientes.')}
          ${et.featureList([
            'Genera enlaces afiliados para cada propiedad',
            'Clientes que usen tu enlace te contactan directamente',
            'Publica propiedades y proyectos en el portal',
          ])}
          ${et.codeBlock(refToken)}
          ${et.small('Este es tu codigo de agente. Se incluye automaticamente en tus enlaces afiliados.')}
          ${et.button('Explorar propiedades', BASE_URL + '/home')}
        `,
      }),
    }).catch(err => console.error('Agency welcome email error:', err.message));

    sendVerificationEmail(user, verifyRawToken);
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Register Broker ────────────────────────────────────────────────────────
router.post('/register/broker', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, phone, licenseNumber, jobTitle, inmobiliariaId, inmobiliariaName } = req.body;

    if (!name || !email || !password || !phone || !licenseNumber)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const refToken     = crypto.randomBytes(8).toString('hex');

    const user = {
      id:              `usr_${Date.now()}`,
      email:           email.toLowerCase().trim(),
      passwordHash,
      name:            name.trim(),
      phone:           phone.trim(),
      licenseNumber:   licenseNumber.trim(),
      jobTitle:        (jobTitle || '').trim().slice(0, 60),
      refToken,
      createdAt:       new Date().toISOString(),
      lastLoginAt:     null,
      role:            'broker',
      favorites:       [],
      resetToken:      null,
      resetTokenExpiry: null,
      marketingOptIn:  false,  // Explicit opt-in required
      subscriptionStatus: 'pending_payment',  // card required before trial starts
      trialEndsAt:     null,                    // trial not started until checkout
      paywallRequired: true,                    // new signups are paywalled
      stripeCustomerId:    null,
      stripeSubscriptionId: null,
      // inmobiliaria_id is NEVER set at registration — only after the inmobiliaria approves
      inmobiliaria_id:           null,
      inmobiliaria_name:         inmobiliariaId ? null : (inmobiliariaName ? inmobiliariaName.trim() : null),
      inmobiliaria_join_status:  inmobiliariaId ? 'pending' : null,
      inmobiliaria_pending_id:   inmobiliariaId ? inmobiliariaId.trim()   : null,
      inmobiliaria_pending_name: inmobiliariaId ? (inmobiliariaName || '').trim() : null,
      inmobiliaria_joined_at:    null,
    };

    const verifyRawToken = attachVerifyToken(user);
    store.saveUser(user);

    // ── If agent selected a registered inmobiliaria, add a join_request to their record ──
    if (inmobiliariaId) {
      try {
        const inm = store.getUserById(inmobiliariaId.trim());
        if (inm && (inm.role === 'inmobiliaria' || inm.role === 'constructora')) {
          if (!Array.isArray(inm.join_requests)) inm.join_requests = [];
          inm.join_requests.push({
            id:             `jr_${Date.now()}`,
            broker_id:      user.id,
            broker_name:    user.name,
            broker_email:   user.email,
            broker_license: user.licenseNumber || '',
            broker_phone:   user.phone || '',
            requested_at:   new Date().toISOString(),
            status:         'pending',
          });
          store.saveUser(inm);
          transporter.sendMail({
            department: 'soporte',
            to:      inm.email,
            subject: `Solicitud de afiliacion — ${user.name}`,
            html: et.layout({
              title: 'Nueva solicitud de afiliacion',
              preheader: `${user.name} solicito afiliarse a ${inm.companyName || inm.name}`,
              body: `
                ${et.p(`El agente <strong>${et.esc(user.name)}</strong> (${et.esc(user.email)}) solicito afiliarse a <strong>${et.esc(inm.companyName || inm.name)}</strong>.`)}
                ${user.licenseNumber ? et.infoTable(et.infoRow('Licencia', user.licenseNumber)) : ''}
                ${et.button('Ver solicitudes', BASE_URL + '/broker#team-requests')}
              `,
            }),
          }).catch(e => console.error('Inm notify email error:', e.message));
        }
      } catch (e) {
        console.error('Join request creation error:', e.message);
      }
    }

    transporter.sendMail({
      department: 'soporte',
      to:      user.email,
      subject: 'Bienvenido a HogaresRD — Tu cuenta de agente esta lista',
      html: et.layout({
        title: `Bienvenido, ${name.split(' ')[0]}`,
        subtitle: `Agente Broker — Lic. ${licenseNumber}`,
        preheader: 'Tu cuenta de agente broker en HogaresRD esta activa.',
        body: `
          ${et.p('Tu cuenta de agente broker esta activa. Desde tu dashboard puedes gestionar aplicaciones, afiliarte a inmobiliarias y ver analiticas de ventas.')}
          ${et.featureList([
            'Gestiona aplicaciones de clientes',
            'Afiliate a una inmobiliaria registrada',
            'Consulta analiticas de tus operaciones',
          ])}
          ${et.button('Ir a mi dashboard', BASE_URL + '/broker')}
        `,
      }),
    }).catch(err => console.error('Broker welcome email error:', err.message));

    sendVerificationEmail(user, verifyRawToken);
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Register Inmobiliaria ──────────────────────────────────────────────────
router.post('/register/inmobiliaria', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, companyName, licenseNumber, phone } = req.body;

    if (!name || !email || !password || !companyName || !licenseNumber || !phone)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const refToken     = crypto.randomBytes(8).toString('hex');

    const user = {
      id:              `usr_${Date.now()}`,
      email:           email.toLowerCase().trim(),
      passwordHash,
      name:            name.trim(),
      phone:           phone.trim(),
      companyName:     companyName.trim(),
      licenseNumber:   licenseNumber.trim(),
      refToken,
      createdAt:       new Date().toISOString(),
      lastLoginAt:     null,
      role:            'inmobiliaria',
      favorites:       [],
      resetToken:      null,
      resetTokenExpiry: null,
      marketingOptIn:  false,  // Explicit opt-in required
      subscriptionStatus: 'pending_payment',  // card required before trial starts
      trialEndsAt:     null,                    // trial not started until checkout
      paywallRequired: true,                    // new signups are paywalled
      stripeCustomerId:    null,
      stripeSubscriptionId: null,
      join_requests:   [],
    };

    const verifyRawToken = attachVerifyToken(user);
    store.saveUser(user);

    transporter.sendMail({
      department: 'soporte',
      to:      user.email,
      subject: `Bienvenido a HogaresRD — ${companyName} registrada`,
      html: et.layout({
        title: et.esc(companyName),
        subtitle: `Cuenta registrada — Lic. ${licenseNumber}`,
        preheader: `${companyName} ya esta registrada en HogaresRD. Accede a tu dashboard para gestionar tu equipo.`,
        body: `
          ${et.p(`Hola <strong>${et.esc(name.split(' ')[0])}</strong>, tu inmobiliaria ya esta registrada en HogaresRD.`)}
          ${et.featureList([
            'Aprueba solicitudes de afiliacion de agentes brokers',
            'Supervision total de aplicaciones de tu equipo',
            'Gestion de planes de pago y contabilidad consolidada',
          ])}
          ${et.button('Ir a mi dashboard', BASE_URL + '/broker')}
        `,
      }),
    }).catch(err => console.error('Inmobiliaria welcome email error:', err.message));

    sendVerificationEmail(user, verifyRawToken);
    res.status(201).json({ success: true, user: safeUser(user) });

    // ── Notify agents who pre-registered with this company name ──────────
    // (fire-and-forget, after response is sent)
    try {
      const normalise = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const inm_norm  = normalise(companyName);
      if (inm_norm.length >= 3) {
        const candidates = store.getUsers().filter(u =>
          ['broker', 'agency'].includes(u.role) &&
          !u.inmobiliaria_id &&
          !u.inmobiliaria_join_status &&
          u.inmobiliaria_name &&
          normalise(u.inmobiliaria_name) === inm_norm
        );
        candidates.forEach(agent => {
          transporter.sendMail({
            department: 'soporte',
            to:      agent.email,
            subject: `${companyName} se registro en HogaresRD — Conecta tu cuenta`,
            html: et.layout({
              title: `${et.esc(companyName)} esta en HogaresRD`,
              subtitle: 'Ya puedes enviar tu solicitud de afiliacion',
              preheader: `${companyName} acaba de registrarse. Envia tu solicitud de afiliacion desde tu dashboard.`,
              body: `
                ${et.p(`<strong>${et.esc(companyName)}</strong>, la inmobiliaria que indicaste al crear tu cuenta, acaba de registrarse en HogaresRD.`)}
                ${et.p('Ahora puedes enviarles una solicitud de afiliacion desde tu dashboard. Una vez aprobada, quedaras vinculado a su equipo.')}
                ${et.button('Ir a mi dashboard', BASE_URL + '/broker')}
                ${et.small('En tu dashboard encontraras la opcion de afiliacion en la seccion correspondiente.')}
              `,
            }),
          }).catch(e => console.error('Agent notify email error:', e.message));
        });
      }
    } catch (notifyErr) {
      console.error('Agent notify scan error:', notifyErr.message);
    }
  } catch (err) { next(err); }
});

// ── Register: constructora ────────────────────────────────────────────────
router.post('/register/constructora', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, companyName, licenseNumber, phone, yearsExperience, projectsCompleted } = req.body;

    if (!name || !email || !password || !companyName || !phone)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const refToken     = crypto.randomBytes(8).toString('hex');

    const user = {
      id:              `usr_${Date.now()}`,
      email:           email.toLowerCase().trim(),
      passwordHash,
      name:            name.trim(),
      phone:           phone.trim(),
      companyName:     companyName.trim(),
      licenseNumber:   (licenseNumber || '').trim(),
      refToken,
      createdAt:       new Date().toISOString(),
      lastLoginAt:     null,
      role:            'constructora',
      favorites:       [],
      resetToken:      null,
      resetTokenExpiry: null,
      marketingOptIn:  false,  // Explicit opt-in required
      subscriptionStatus: 'pending_payment',  // card required before trial starts
      trialEndsAt:     null,                    // trial not started until checkout
      paywallRequired: true,                    // new signups are paywalled
      stripeCustomerId:    null,
      stripeSubscriptionId: null,
      join_requests:   [],
      yearsExperience: parseInt(yearsExperience) || 0,
      projectsCompleted: parseInt(projectsCompleted) || 0,
    };

    const verifyRawToken = attachVerifyToken(user);
    store.saveUser(user);
    sendVerificationEmail(user, verifyRawToken);
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Login ──────────────────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Correo y contraseña requeridos' });

    const user = store.getUserByEmail(email);
    if (!user) {
      logSec('login_failed', req, { email, reason: 'unknown_email' });
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    // Account lockout check (Sprint 4)
    if (user.loginLockedUntil && new Date(user.loginLockedUntil) > new Date()) {
      const remainingMs  = new Date(user.loginLockedUntil) - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      logSec('login_blocked', req, { userId: user.id, reason: 'account_locked' });
      return res.status(429).json({
        error: `Cuenta bloqueada por demasiados intentos fallidos. Intenta nuevamente en ${remainingMin} minuto${remainingMin !== 1 ? 's' : ''}.`
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      user.loginAttempts    = (user.loginAttempts || 0) + 1;
      const attempts        = user.loginAttempts;
      const LOCKOUT_AFTER   = 5;
      const LOCKOUT_MS      = 15 * 60 * 1000; // 15 minutes

      if (attempts >= LOCKOUT_AFTER) {
        user.loginLockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
        logSec('account_locked', req, { userId: user.id, attempts });

        // Notify user by email (fire-and-forget)
        transporter.sendMail({
          department: 'soporte',
          to:      user.email,
          subject: 'Cuenta bloqueada temporalmente — HogaresRD',
          html: et.layout({
            title: 'Cuenta bloqueada temporalmente',
            subtitle: 'Medida de seguridad activada',
            preheader: 'Detectamos multiples intentos fallidos de inicio de sesion en tu cuenta HogaresRD',
            headerColor: '#b91c1c',
            body: `
              ${et.alertBox(`Detectamos <strong>${attempts} intentos fallidos</strong> de inicio de sesion. Tu cuenta ha sido bloqueada por 15 minutos como medida de seguridad.`, 'danger')}
              ${et.p('Si no fuiste tu, te recomendamos cambiar tu contrasena inmediatamente.')}
              ${et.button('Cambiar contrasena', BASE_URL + '/reset-password')}
              ${et.small('Si no reconoces esta actividad, contacta a soporte respondiendo a este correo.')}
            `,
          }),
        }).catch(err => console.error('Lockout email error:', err.message));
      }

      store.saveUser(user);
      logSec('login_failed', req, { email, reason: 'wrong_password', userId: user.id, attempts });
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    user.lastLoginAt      = new Date().toISOString();
    user.loginAttempts    = 0;
    user.loginLockedUntil = null;
    store.saveUser(user);

    // ── 2FA check ─────────────────────────────────────────
    if (user.twoFAEnabled) {
      const sessionId = crypto.randomUUID();
      const code = String(crypto.randomInt(100000, 999999));
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      store.saveTwoFASession({
        id: sessionId,
        userId: user.id,
        codeHash,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        attempts: 0,
        verified: false,
      });

      send2FAEmail(user, code);
      logSec('2fa_required', req, { userId: user.id });
      return res.json({ requires2FA: true, twoFASessionId: sessionId, method: user.twoFAMethod || 'email' });
    }

    logSec('login_success', req, { userId: user.id, role: user.role });
    trackLoginAndAlert(user, req);

    const token = signToken(user);

    // Set JWT in an httpOnly cookie — XSS-proof primary auth mechanism.
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   IS_PROD,      // HTTPS-only in production
      sameSite: 'lax',        // CSRF protection; still works with normal navigation
      maxAge:   14 * 24 * 60 * 60 * 1000, // 14 days — matches JWT expiry
    });

    // Also return the token in the body so mobile / API clients can store it.
    // Browsers should rely on the cookie; web pages can ignore data.token.
    res.json({ token, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Me ─────────────────────────────────────────────────────────────────────
router.get('/me', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(safeUser(user));
});

// ── Logout ─────────────────────────────────────────────────────────────────
// Revokes the current token (by jti) and clears the httpOnly cookie.
router.post('/logout', (req, res) => {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const token = cookieToken || headerToken;

  if (token) {
    try {
      const payload = verifyJWT(token);
      if (payload.jti) {
        store.revokeToken(payload.jti, payload.exp);
        logSec('logout', req, { userId: payload.sub });
      }
      // Clean up any pending 2FA sessions
      if (payload.sub) store.deleteTwoFASessionsByUser(payload.sub);
    } catch { /* token already invalid — nothing to revoke */ }
  }

  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: 'lax' });
  res.json({ success: true });
});

// ── Forgot password ────────────────────────────────────────────────────────
router.post('/forgot-password', resetLimiter, async (req, res) => {
  const { email } = req.body;

  // Always 200 — never reveal whether the email exists
  res.json({ success: true, message: 'Si ese correo está registrado, recibirás un enlace para restablecer tu contraseña.' });

  // Guard against header-injection via malformed email input.
  if (!validateEmail(email)) return;

  const user = store.getUserByEmail(email);
  if (!user) return;

  // Sprint 3: store a SHA-256 hash of the token — raw token only lives in the email link.
  // Even if users.json is read by an attacker, the tokens cannot be replayed.
  const rawToken   = crypto.randomBytes(32).toString('hex');
  const tokenHash  = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.resetToken       = tokenHash;  // hashed; never the raw value
  user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  store.saveUser(user);

  logSec('reset_requested', req, { userId: user.id });

  transporter.sendMail({
    department: 'soporte',
    to:      user.email,
    subject: 'Restablecer tu contrasena — HogaresRD',
    html: et.layout({
      title: 'Restablecer contrasena',
      subtitle: 'Solicitud recibida',
      preheader: 'Recibimos tu solicitud para restablecer la contrasena de tu cuenta HogaresRD',
      body: `
        ${et.p('Recibimos una solicitud para restablecer la contrasena de tu cuenta. Haz clic en el boton de abajo para crear una nueva contrasena.')}
        ${et.alertBox('Este enlace expira en <strong>1 hora</strong>.', 'info')}
        ${et.button('Restablecer contrasena', `${BASE_URL}/reset-password?token=${rawToken}`)}
        ${et.divider()}
        ${et.small('Si no solicitaste esto, ignora este correo. Tu contrasena no cambiara.')}
      `,
    }),
  }).catch(err => console.error('Reset email error:', err.message));
});

// ── Reset password ─────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'Token y contraseña son requeridos' });
    // Password reset is token-based — email validation removed (was referencing undefined variable)
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    // Sprint 3: compare the SHA-256 hash of the submitted token against the stored hash.
    // The raw token is never stored — even a DB breach can't reveal usable reset tokens.
    const submittedHash = crypto.createHash('sha256').update(token).digest('hex');

    const users = store.getUsers();
    const user  = users.find(u => u.resetToken === submittedHash);
    if (!user)
      return res.status(400).json({ error: 'Enlace inválido o ya utilizado' });
    if (new Date(user.resetTokenExpiry) < new Date())
      return res.status(400).json({ error: 'El enlace ha expirado. Solicita uno nuevo.' });

    user.passwordHash     = await bcrypt.hash(password, 12);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    store.saveUser(user);

    logSec('reset_used', req, { userId: user.id });
    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) { next(err); }
});

// ── Verify email ───────────────────────────────────────────────────────────
// The link in the email is a GET — verifies and redirects to the landing page.
const emailVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  message: { error: 'Demasiados intentos. Intenta más tarde.' },
  standardHeaders: true, legacyHeaders: false,
});

router.get('/verify-email', emailVerifyLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect(`${BASE_URL}/verify-email?status=invalid`);

  const submittedHash = crypto.createHash('sha256').update(token).digest('hex');
  const users = store.getUsers();
  const user  = users.find(u => u.emailVerifyToken === submittedHash);

  if (!user)
    return res.redirect(`${BASE_URL}/verify-email?status=invalid`);
  if (new Date(user.emailVerifyExpiry) < new Date())
    return res.redirect(`${BASE_URL}/verify-email?status=expired`);

  user.emailVerified     = true;
  user.emailVerifyToken  = null;
  user.emailVerifyExpiry = null;
  store.saveUser(user);

  logSec('email_verified', req, { userId: user.id });

  // ── Auto-login on successful verification ───────────────────────────────
  // Email ownership is proven at this point (they received and clicked the
  // link), so we sign them in by issuing the JWT cookie. This lets the
  // verify-email.html landing page check subscription status and route
  // paywalled pro users to /subscribe without a manual login step.
  try {
    const authToken = signToken(user);
    res.cookie(COOKIE_NAME, authToken, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: 'lax',
      maxAge:   14 * 24 * 60 * 60 * 1000,
    });
  } catch (e) {
    console.error('[verify-email] auto-login cookie error:', e.message);
  }

  res.redirect(`${BASE_URL}/verify-email?status=success`);
});

// ── Public resend — by email address (for post-registration page, user not yet logged in) ──
router.post('/resend-verification-public', resendLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Correo requerido' });
  try {
    const user = store.getUserByEmail(email.toLowerCase().trim());
    // Always respond 200 — never reveal whether the email exists
    if (!user || user.emailVerified) {
      return res.json({ success: true, message: user?.emailVerified
        ? 'Tu correo ya está verificado. Ya puedes iniciar sesión.'
        : 'Si el correo está registrado, recibirás un nuevo enlace en breve.' });
    }
    const rawToken = attachVerifyToken(user);
    store.saveUser(user);
    sendVerificationEmail(user, rawToken);
    res.json({ success: true, message: 'Correo enviado. Revisa tu bandeja de entrada (y la carpeta de spam).' });
  } catch { res.json({ success: true }); }
});

// ── Resend verification email ──────────────────────────────────────────────
router.post('/resend-verification', resendLimiter, userAuth, async (req, res, next) => {
  try {
    const user = store.getUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.emailVerified) return res.json({ success: true, message: 'Tu correo ya está verificado.' });

    const rawToken = attachVerifyToken(user);
    store.saveUser(user);
    const emailResult = await sendVerificationEmail(user, rawToken);
    if (!emailResult) {
      console.warn('[auth] Verification email could not be sent — no transport available');
      return res.status(503).json({ error: 'No se pudo enviar el correo. Intenta de nuevo más tarde.' });
    }
    logSec('verification_resent', req, { userId: user.id });
    res.json({ success: true, message: 'Correo de verificación enviado. Revisa tu bandeja de entrada.' });
  } catch (err) { next(err); }
});

// ── Register Admin ─────────────────────────────────────────────────────────
// Requires the x-admin-key header — only callable by the server operator.
// Creates a user with role 'admin' that can log in normally to get a JWT.
router.post('/register/admin', authLimiter, async (req, res, next) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY)
      return res.status(401).json({ error: 'No autorizado' });

    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email y password son requeridos' });

    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id:               `usr_${Date.now()}`,
      email:            email.toLowerCase().trim(),
      passwordHash,
      name:             name.trim(),
      phone:            '',
      createdAt:        new Date().toISOString(),
      lastLoginAt:      null,
      role:             'admin',
      favorites:        [],
      resetToken:        null,
      resetTokenExpiry:  null,
      emailVerified:     true, // admin accounts are pre-verified
    };

    store.saveUser(user);
    logSec('admin_registered', req, { userId: user.id, email: user.email });
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Register Secretary (via invitation) ───────────────────────────────────
router.post('/register/secretary', authLimiter, async (req, res, next) => {
  try {
    const { token: inviteToken, name, password, phone } = req.body;
    if (!inviteToken || !name || !password)
      return res.status(400).json({ error: 'Token, nombre y contraseña requeridos' });

    // Email comes from the stored invitation (line 1375), not from request body
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    // Find the inmobiliaria with this invite token
    const users = store.getUsers();
    let inmobiliaria = null;
    let invite = null;
    for (const u of users) {
      if ((u.role === 'inmobiliaria' || u.role === 'constructora') && Array.isArray(u.secretary_invites)) {
        const inv = u.secretary_invites.find(i => i.token === inviteToken && i.status === 'pending');
        if (inv) { inmobiliaria = u; invite = inv; break; }
      }
    }

    if (!inmobiliaria || !invite)
      return res.status(400).json({ error: 'Invitación inválida o expirada' });

    // Check email not already registered
    if (store.getUserByEmail(invite.email))
      return res.status(400).json({ error: 'No se pudo crear la cuenta. Verifica tus datos e intenta de nuevo.' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = {
      id: `usr_sec_${crypto.randomBytes(6).toString('hex')}`,
      email: invite.email,
      name,
      phone: phone || '',
      role: 'secretary',
      passwordHash: hashedPassword,
      inmobiliaria_id: inmobiliaria.id,
      inmobiliaria_name: inmobiliaria.agencyName || inmobiliaria.name,
      inmobiliaria_joined_at: new Date().toISOString(),
      invited_by: inmobiliaria.id,
      createdAt: new Date().toISOString(),
      emailVerified: true, // invited users are pre-verified
      favorites: [],
    };

    store.saveUser(user);

    // Mark invite as accepted
    invite.status = 'accepted';
    invite.acceptedAt = new Date().toISOString();
    invite.userId = user.id;
    store.saveUser(inmobiliaria);

    logSec('secretary_registered', req, { userId: user.id, inmobiliariaId: inmobiliaria.id });

    const jwtToken = signToken(user);
    res.cookie('hrdt', jwtToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 14 * 24 * 60 * 60 * 1000,
    });
    res.status(201).json({ token: jwtToken, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── 2FA: Verify code ──────────────────────────────────────────────────────
// Per-user 2FA attempt tracking (prevents brute-force across multiple sessions)
const _twoFAUserAttempts = new Map(); // userId → { count, lockedUntil }
const TWOFA_USER_MAX = 10;           // max attempts across ALL sessions
const TWOFA_USER_LOCKOUT_MS = 30 * 60 * 1000; // 30-minute lockout

router.post('/2fa/verify', twoFALimiter, (req, res) => {
  const { twoFASessionId, code } = req.body;
  if (!twoFASessionId || !code) return res.status(400).json({ error: 'Sesión y código requeridos' });

  const session = store.getTwoFASession(twoFASessionId);
  if (!session) return res.status(400).json({ error: 'Sesión de verificación inválida o expirada' });

  // Per-user global lockout check (across all sessions)
  const userTrack = _twoFAUserAttempts.get(session.userId);
  if (userTrack?.lockedUntil && Date.now() < userTrack.lockedUntil) {
    const remainMin = Math.ceil((userTrack.lockedUntil - Date.now()) / 60_000);
    return res.status(429).json({ error: `Cuenta bloqueada por demasiados intentos de verificación. Intenta en ${remainMin} minuto(s).` });
  }

  if (new Date(session.expiresAt) < new Date()) {
    store.deleteTwoFASession(twoFASessionId);
    return res.status(400).json({ error: 'Código expirado. Inicia sesión nuevamente.' });
  }
  if (session.attempts >= 5) {
    store.deleteTwoFASession(twoFASessionId);
    logSec('2fa_max_attempts', req, { userId: session.userId });
    return res.status(429).json({ error: 'Demasiados intentos. Inicia sesión nuevamente.' });
  }

  const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
  if (codeHash !== session.codeHash) {
    session.attempts++;
    store.saveTwoFASession(session);

    // Track per-user global attempts
    const track = _twoFAUserAttempts.get(session.userId) || { count: 0, lockedUntil: null };
    track.count++;
    if (track.count >= TWOFA_USER_MAX) {
      track.lockedUntil = Date.now() + TWOFA_USER_LOCKOUT_MS;
      logSec('2fa_user_locked', req, { userId: session.userId, attempts: track.count });
    }
    _twoFAUserAttempts.set(session.userId, track);

    logSec('2fa_failed', req, { userId: session.userId, attempts: session.attempts });
    return res.status(401).json({ error: 'Código incorrecto', attemptsRemaining: 5 - session.attempts });
  }

  // Success — issue token, clear per-user tracking
  store.deleteTwoFASession(twoFASessionId);
  _twoFAUserAttempts.delete(session.userId);
  const user = store.getUserById(session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  logSec('2fa_verified', req, { userId: user.id });
  trackLoginAndAlert(user, req);
  logSec('login_success', req, { userId: user.id, role: user.role, via: '2fa' });

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: IS_PROD, sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
  res.json({ token, user: safeUser(user) });
});

// ── 2FA: Resend code ──────────────────────────────────────────────────────
router.post('/2fa/resend', twoFALimiter, (req, res) => {
  const { twoFASessionId } = req.body;
  if (!twoFASessionId) return res.status(400).json({ error: 'Sesión requerida' });

  const session = store.getTwoFASession(twoFASessionId);
  if (!session) return res.status(400).json({ error: 'Sesión inválida o expirada' });
  if (new Date(session.expiresAt) < new Date()) {
    store.deleteTwoFASession(twoFASessionId);
    return res.status(400).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' });
  }

  // Enforce per-user global lockout (same check as /2fa/verify)
  const userTrack = _twoFAUserAttempts.get(session.userId);
  if (userTrack?.lockedUntil && Date.now() < userTrack.lockedUntil) {
    const remainMin = Math.ceil((userTrack.lockedUntil - Date.now()) / 60_000);
    return res.status(429).json({ error: `Cuenta bloqueada por demasiados intentos. Intenta en ${remainMin} minuto(s).` });
  }

  const user = store.getUserById(session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Generate new code — keep per-user attempt count (don't reset global counter)
  const code = String(crypto.randomInt(100000, 999999));
  session.codeHash = crypto.createHash('sha256').update(code).digest('hex');
  session.expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  session.attempts = 0; // Reset per-session counter (new code), global counter preserved
  store.saveTwoFASession(session);

  send2FAEmail(user, code);
  logSec('2fa_code_resent', req, { userId: user.id });
  res.json({ success: true, message: 'Código reenviado' });
});

// ── 2FA: Enable (requires auth) ──────────────────────────────────────────
router.post('/2fa/enable', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const sessionId = crypto.randomUUID();
  const code = String(crypto.randomInt(100000, 999999));
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  store.saveTwoFASession({
    id: sessionId,
    userId: user.id,
    codeHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    attempts: 0,
    purpose: 'enable',
  });

  send2FAEmail(user, code);
  logSec('2fa_enable_requested', req, { userId: user.id });
  res.json({ sessionId });
});

// ── 2FA: Confirm enable ──────────────────────────────────────────────────
router.post('/2fa/confirm-enable', userAuth, (req, res) => {
  const { sessionId, code } = req.body;
  if (!sessionId || !code) return res.status(400).json({ error: 'Sesión y código requeridos' });

  const session = store.getTwoFASession(sessionId);
  if (!session || session.userId !== req.user.sub) return res.status(400).json({ error: 'Sesión inválida' });
  if (new Date(session.expiresAt) < new Date()) {
    store.deleteTwoFASession(sessionId);
    return res.status(400).json({ error: 'Código expirado' });
  }

  const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
  if (codeHash !== session.codeHash) {
    session.attempts++;
    store.saveTwoFASession(session);
    return res.status(401).json({ error: 'Código incorrecto' });
  }

  store.deleteTwoFASession(sessionId);
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.twoFAEnabled = true;
  user.twoFAMethod = 'email';
  user.twoFAEnabledAt = new Date().toISOString();
  store.saveUser(user);

  logSec('2fa_enabled', req, { userId: user.id });
  res.json({ success: true, twoFAEnabled: true });
});

// ── 2FA: Disable (requires auth + password) ──────────────────────────────
router.post('/2fa/disable', userAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' });

  user.twoFAEnabled = false;
  user.twoFAMethod = null;
  store.saveUser(user);

  logSec('2fa_disabled', req, { userId: user.id });
  res.json({ success: true, twoFAEnabled: false });
});

// ── Biometric: Register token ────────────────────────────────────────────
router.post('/biometric/register', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const rawToken = crypto.randomBytes(64).toString('hex');
  user.biometricTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  store.saveUser(user);

  logSec('biometric_registered', req, { userId: user.id });
  res.json({ biometricToken: rawToken });
});

// ── Biometric: Login ─────────────────────────────────────────────────────
router.post('/biometric/login', authLimiter, async (req, res) => {
  const { email, biometricToken } = req.body;
  if (!email || !biometricToken) return res.status(400).json({ error: 'Email y token biométrico requeridos' });

  const user = store.getUserByEmail(email);
  if (!user || !user.biometricTokenHash) {
    logSec('biometric_login_failed', req, { email, reason: 'no_biometric' });
    return res.status(401).json({ error: 'Autenticación biométrica no disponible' });
  }

  const tokenHash = crypto.createHash('sha256').update(biometricToken).digest('hex');
  if (tokenHash !== user.biometricTokenHash) {
    logSec('biometric_login_failed', req, { email, reason: 'invalid_token' });
    return res.status(401).json({ error: 'Token biométrico inválido' });
  }

  // Account lockout check
  if (user.loginLockedUntil && new Date(user.loginLockedUntil) > new Date()) {
    return res.status(429).json({ error: 'Cuenta bloqueada temporalmente' });
  }

  user.lastLoginAt = new Date().toISOString();
  user.loginAttempts = 0;
  user.loginLockedUntil = null;
  store.saveUser(user);

  // If 2FA is enabled, still require it (biometric replaces password, not 2FA)
  if (user.twoFAEnabled) {
    const sessionId = crypto.randomUUID();
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    store.saveTwoFASession({
      id: sessionId, userId: user.id, codeHash,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      attempts: 0,
    });

    send2FAEmail(user, code);
    logSec('2fa_required', req, { userId: user.id, via: 'biometric' });
    return res.json({ requires2FA: true, twoFASessionId: sessionId, method: user.twoFAMethod || 'email' });
  }

  logSec('biometric_login_success', req, { userId: user.id });

  // Rotate biometric token on each successful login — old token becomes invalid
  const newRawToken = crypto.randomBytes(64).toString('hex');
  user.biometricTokenHash = crypto.createHash('sha256').update(newRawToken).digest('hex');
  store.saveUser(user);

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: IS_PROD, sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
  res.json({ token, user: safeUser(user), newBiometricToken: newRawToken });
});

// ── Biometric: Revoke ────────────────────────────────────────────────────
router.post('/biometric/revoke', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  user.biometricTokenHash = null;
  store.saveUser(user);

  logSec('biometric_revoked', req, { userId: user.id });
  res.json({ success: true });
});

// Optional auth — sets req.user if token present, but doesn't reject
// Mirrors userAuth's token-extraction order so cookie-authenticated browsers
// (which never send Authorization headers) still get their req.user populated.
function optionalAuth(req, res, next) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const token = cookieToken || headerToken;
  if (!token) { req.user = null; return next(); }
  try {
    const decoded = verifyJWT(token);
    if (decoded.jti && store.isTokenRevoked(decoded.jti)) { req.user = null; return next(); }
    req.user = decoded;
  } catch { req.user = null; }
  next();
}

// POST /auth/apple — Sign in with Apple
// Apple's identity token is a JWT signed by Apple. We verify it using Apple's public keys.
let _appleKeysCache = null;
let _appleKeysCacheTs = 0;

async function getApplePublicKeys() {
  const now = Date.now();
  if (_appleKeysCache && (now - _appleKeysCacheTs) < 3600000) return _appleKeysCache; // 1h cache
  // Fetch fresh JWKS. We deliberately throw on failure so callers can
  // 503 — there is no safe fallback for Apple Sign In.
  const res = await fetch('https://appleid.apple.com/auth/keys');
  if (!res.ok) throw new Error('Apple JWKS fetch failed: ' + res.status);
  _appleKeysCache = await res.json();
  _appleKeysCacheTs = now;
  return _appleKeysCache;
}

async function verifyAppleToken(identityToken) {
  const jwt = require('jsonwebtoken');

  // Verify with Apple's public keys. Any failure (JWKS unreachable, kid
  // missing, signature invalid) MUST throw — never fall back to an
  // unverified jwt.decode(), which accepts forged tokens.
  const jwks = await getApplePublicKeys();
  if (!jwks || !jwks.keys) {
    throw new Error('Apple JWKS unavailable');
  }
  const header = JSON.parse(Buffer.from(identityToken.split('.')[0], 'base64url').toString());
  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) {
    throw new Error('Apple JWKS does not contain a key for kid=' + header.kid);
  }
  const crypto = require('crypto');
  const pubKey = crypto.createPublicKey({ key, format: 'jwk' });
  const pem = pubKey.export({ type: 'spki', format: 'pem' });
  const decoded = jwt.verify(identityToken, pem, {
    algorithms: ['RS256'],
    issuer: 'https://appleid.apple.com',
    audience: ['com.josty.hogaresrd', 'com.josty.hogaresrd.web'],
  });
  return { verified: true, decoded };
}

router.post('/apple', authLimiter, async (req, res) => {
  try {
    const { identityToken, name, email } = req.body;
    if (!identityToken) {
      console.warn('[auth] Apple Sign In: missing identityToken');
      return res.status(400).json({ error: 'Missing identityToken' });
    }

    // Verify and decode the Apple identity token. verifyAppleToken throws
    // on any failure — there is no unsafe fallback path.
    let decoded;
    try {
      const result = await verifyAppleToken(identityToken);
      decoded = result.decoded;
    } catch (verifyErr) {
      // JWKS unavailable / signature invalid / kid missing — refuse.
      // 503 specifically when Apple's keys couldn't be fetched.
      const isJwksFailure = /JWKS/.test(verifyErr.message);
      console.error('[auth] Apple Sign In: token verification failed —', verifyErr.message);
      if (isJwksFailure) {
        return res.status(503).json({ error: 'No se pudo contactar a Apple para verificar el token. Intenta de nuevo en unos minutos.' });
      }
      return res.status(400).json({ error: 'No se pudo verificar el token de Apple. Intenta de nuevo.' });
    }
    if (!decoded || !decoded.sub) {
      console.warn('[auth] Apple Sign In: invalid token (no sub)');
      return res.status(400).json({ error: 'Invalid Apple token' });
    }

    const appleUserId = decoded.sub;
    const appleEmail = email || decoded.email || `apple_${appleUserId.substring(0, 8)}@hogaresrd.com`;
    const userName = name || (decoded.email ? decoded.email.split('@')[0] : `Usuario Apple`);

    console.log(`[auth] Apple Sign In attempt: sub=${appleUserId.substring(0,8)}…, email=${appleEmail}, verified=true`);

    // Check if user already exists with this Apple ID (stored in _extra)
    let user = store.getUsers().find(u => {
      const extra = typeof u._extra === 'string' ? _jsonParseSafe(u._extra) : (u._extra || {});
      return extra.appleUserId === appleUserId;
    });

    if (!user) {
      // Check by email
      user = store.getUserByEmail(appleEmail);
    }

    if (!user) {
      // Create new user
      const userId = 'usr_' + Date.now();
      user = {
        id: userId,
        name: userName,
        email: appleEmail,
        password: '',
        role: 'user',
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      // Store Apple ID in _extra via the hydration system
      const extra = { appleUserId, authProvider: 'apple' };
      user._extra = JSON.stringify(extra);
      store.saveUser(user);
      console.log(`[auth] New Apple Sign In user created: ${userId} (${appleEmail})`);
    } else {
      // Link Apple ID to existing account if not already linked
      const extra = typeof user._extra === 'string' ? _jsonParseSafe(user._extra) : (user._extra || {});
      if (!extra.appleUserId) {
        extra.appleUserId = appleUserId;
        extra.authProvider = extra.authProvider || 'apple';
        user._extra = JSON.stringify(extra);
        store.saveUser(user);
        console.log(`[auth] Linked Apple ID to existing user: ${user.id} (${user.email})`);
      }
    }

    // Generate JWT token
    const token = signToken(user);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('[auth] Apple Sign In error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: 'Error de autenticación con Apple. Intente de nuevo.' });
  }
});

function _jsonParseSafe(str) {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

// POST /auth/request-deletion — user requests data deletion (reviewed by admin)
router.post('/request-deletion', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Check for existing pending request
  const existing = store.getDeletionRequests().find(r => r.user_id === user.id && r.status === 'pending');
  if (existing) return res.json({ success: true, message: 'Ya tienes una solicitud pendiente.' });

  const crypto = require('crypto');
  const dr = {
    id:           'del_' + crypto.randomBytes(8).toString('hex'),
    user_id:      user.id,
    user_email:   user.email,
    user_name:    user.name,
    user_role:    user.role,
    reason:       (req.body.reason || '').slice(0, 500),
    status:       'pending',
    processed_at: null,
    processed_by: null,
    data_summary: {
      conversations: store.getConversations().filter(c => c.clientId === user.id || c.brokerId === user.id).length,
      tours:         store.getToursByClient(user.id).length,
      tasks:         store.getTasksByUser(user.id).length,
      savedSearches: store.getSavedSearchesByUser(user.id).length,
    },
    created_at:   new Date().toISOString(),
  };
  store.saveDeletionRequest(dr);
  logSec('deletion_requested', req, { userId: user.id });
  res.json({ success: true, message: 'Tu solicitud de eliminación ha sido registrada. Será procesada en las próximas 48 horas.' });
});

// DELETE /auth/delete-account — permanently delete user account and all associated data
router.delete('/delete-account', userAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const user = store.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Delete user and ALL associated data (conversations, tours, tasks, etc.)
    const summary = await store.deleteUserCascade(userId);

    console.log(`[auth] Account self-deleted: ${userId} (${user.email}) — ${JSON.stringify(summary)}`);
    res.json({ ok: true, message: 'Cuenta eliminada permanentemente' });
  } catch (err) {
    console.error('[auth] Delete account error:', err.message);
    res.status(500).json({ error: 'Error al eliminar la cuenta' });
  }
});

// POST /auth/apple-subscription — Sync Apple IAP subscription with user role
//
// TODO: Replace this client-trusted flow with server-side Apple receipt
// validation against the App Store Server API:
//   POST https://api.storekit.itunes.apple.com/inApps/v1/transactions/{transactionId}
// (sandbox host: api.storekit-sandbox.itunes.apple.com). Until then, we
// rely on (a) transactionID uniqueness across users, (b) a 1-year expiration
// cap, and (c) full security logging so abuse is visible.
router.post('/apple-subscription', authLimiter, userAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { productID, transactionID, originalTransactionID, role, expirationDate } = req.body;

    // Always log every call — this endpoint is client-trusted and abuse-prone.
    logSec('apple_iap_subscription_call', req, {
      userId, productID, transactionID, originalTransactionID, role, expirationDate,
    });

    if (!productID || !transactionID || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validRoles = ['broker', 'inmobiliaria', 'constructora'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid subscription role' });
    }

    const user = store.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ── Security: transactionID must be unique per user ──
    // If the same Apple transactionID appears on another account, this is
    // either a replay or a stolen receipt. Reject loudly.
    const txKey = String(transactionID);
    const collidingUser = store.getUsers().find(u => {
      if (u.id === user.id) return false;
      const extra = typeof u._extra === 'string' ? _jsonParseSafe(u._extra) : (u._extra || {});
      const sub = extra.appleSubscription;
      if (!sub) return false;
      return String(sub.transactionID) === txKey
          || String(sub.originalTransactionID || '') === txKey;
    });
    if (collidingUser) {
      logSec('apple_iap_transaction_collision', req, {
        userId, otherUserId: collidingUser.id, transactionID,
      });
      return res.status(409).json({ error: 'Esta transaccion ya esta asociada a otra cuenta.' });
    }

    // ── Security: cap expirationDate at 1 year from now ──
    // The client supplies this value; without a cap a malicious client
    // could pass year 2099 and bypass renewal forever.
    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const maxExpiry = new Date(Date.now() + ONE_YEAR_MS);
    let cappedExpiration = null;
    if (expirationDate) {
      const parsed = new Date(expirationDate);
      if (!isNaN(parsed.getTime())) {
        cappedExpiration = (parsed > maxExpiry ? maxExpiry : parsed).toISOString();
      }
    }
    if (!cappedExpiration) {
      cappedExpiration = maxExpiry.toISOString();
    }

    // ── Security: block upgrade to inmobiliaria/constructora if agent is linked to one ──
    // An agent (broker/agency) who is affiliated with an inmobiliaria must leave
    // that organization before upgrading to an org-level role. Otherwise they
    // could gain director-level visibility into their current org's data.
    const isUpgradingToOrg = ['inmobiliaria', 'constructora'].includes(role);
    const isLinkedToOrg    = user.inmobiliaria_id || user.inmobiliaria_join_status === 'pending';
    if (isUpgradingToOrg && isLinkedToOrg) {
      return res.status(400).json({
        error: 'Debes desvincularte de tu inmobiliaria actual antes de crear tu propia empresa. Ve a tu dashboard y sal de la organizacion primero.',
      });
    }

    // ── Security: block role changes that don't make sense ──
    // Admin/secretary cannot upgrade through IAP
    if (['admin', 'secretary'].includes(user.role)) {
      return res.status(400).json({ error: 'Este tipo de cuenta no puede cambiar de rol mediante suscripcion.' });
    }

    // ── Security: org-level users (inmobiliaria/constructora) cannot downgrade to agent ──
    // They may have team members, active applications, etc. Downgrade would orphan data.
    const isCurrentlyOrg = ['inmobiliaria', 'constructora'].includes(user.role);
    if (isCurrentlyOrg && !isUpgradingToOrg) {
      return res.status(400).json({
        error: 'Una cuenta de inmobiliaria o constructora no puede convertirse en agente individual. Contacta soporte si necesitas ayuda.',
      });
    }

    // Update user role
    const previousRole = user.role;
    user.role = role;

    // When upgrading to org-level role, initialize org fields
    if (['inmobiliaria', 'constructora'].includes(role) && !['inmobiliaria', 'constructora'].includes(previousRole)) {
      if (!Array.isArray(user.join_requests)) user.join_requests = [];
      // Clear any leftover agent-level affiliation fields
      user.inmobiliaria_id          = null;
      user.inmobiliaria_name        = null;
      user.inmobiliaria_join_status = null;
      user.inmobiliaria_pending_id  = null;
      user.inmobiliaria_pending_name = null;
      user.inmobiliaria_joined_at   = null;
      user.access_level             = null;
      user.team_title               = null;
    }

    // Apple IAP is a paid subscription — satisfies the paywall. Apple
    // handles trials on their side, so we mark as active.
    user.subscriptionStatus = 'active';
    user.paywallRequired    = false;

    // Store subscription info in _extra
    const extra = typeof user._extra === 'string' ? (function() { try { return JSON.parse(user._extra); } catch { return {}; } })() : (user._extra || {});
    extra.appleSubscription = {
      productID,
      transactionID,
      originalTransactionID,
      role,
      // expirationDate is capped server-side; client cannot push it past 1y.
      expirationDate: cappedExpiration,
      subscribedAt: new Date().toISOString(),
    };
    user._extra = JSON.stringify(extra);

    store.saveUser(user);

    console.log(`[auth] Apple subscription: ${userId} upgraded ${previousRole} → ${role} (product: ${productID})`);

    const token = signToken(user);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('[auth] Apple subscription error:', err.message);
    res.status(500).json({ error: 'Error processing subscription' });
  }
});

module.exports        = router;
module.exports.userAuth = userAuth;
module.exports.optionalAuth = optionalAuth;
module.exports.verifyJWT = verifyJWT;
