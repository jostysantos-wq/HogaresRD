const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const rateLimit  = require('express-rate-limit');
const store      = require('./store');
const { logSec } = require('./security-log');

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET; // required — enforced at startup by server.js
const BASE_URL   = process.env.BASE_URL || 'http://localhost:3000';

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
  const jti = crypto.randomUUID();
  return jwt.sign({ sub: user.id, role: user.role, name: user.name, jti }, JWT_SECRET, { expiresIn: '30d' });
}

function safeUser(user) {
  const { passwordHash, resetToken, resetTokenExpiry, emailVerifyToken, emailVerifyExpiry, biometricTokenHash, ...safe } = user;
  return safe;
}

// Password must be 8+ chars with upper, lower, digit, and special character.
// Returns an error string, or null if valid.
function validatePassword(password) {
  if (!password || password.length < 8)
    return 'La contraseña debe tener al menos 8 caracteres';
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
  const et = require('../utils/email-templates');
  return transporter.sendMail({
    to:      user.email,
    subject: 'Verifica tu correo — HogaresRD',
    html: et.layout({
      title: 'Verifica tu correo electronico',
      body: et.p(`Hola <strong>${et.esc(user.name.split(' ')[0])}</strong>, gracias por registrarte en HogaresRD.`)
          + et.p('Para activar tu cuenta y acceder a todas las funciones, haz clic en el boton a continuacion. Este enlace expira en <strong>24 horas</strong>.')
          + et.button('Verificar mi correo', verifyUrl)
          + et.small(`Si no creaste esta cuenta, ignora este correo. Si el boton no funciona, copia este enlace: <a href="${verifyUrl}" style="color:#4d6a8a;word-break:break-all;">${verifyUrl}</a>`),
    }),
  }).catch(err => console.error('Verification email error:', err.message));
}

function send2FAEmail(user, code) {
  const et = require('../utils/email-templates');
  return transporter.sendMail({
    to: user.email,
    subject: 'Tu codigo de verificacion — HogaresRD',
    html: et.layout({
      title: 'Codigo de verificacion',
      body: et.p(`Hola <strong>${et.esc(user.name.split(' ')[0])}</strong>, tu codigo de verificacion es:`)
          + et.codeBlock(code)
          + et.small('Este codigo expira en <strong>5 minutos</strong>.')
          + et.small('Si no solicitaste este codigo, ignora este mensaje.'),
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
  const token = cookieToken || headerToken;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);

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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await bcrypt.hash(password, 10);
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
      marketingOptIn:    marketingOptIn !== false,
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
    const trending = store.getListings()
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 3);

    function formatPrice(p) {
      if (!p) return 'Consultar';
      const n = Number(p);
      if (n >= 1000000) return '$' + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
      if (n >= 1000)    return '$' + (n / 1000).toFixed(0) + 'K';
      return '$' + n.toLocaleString('es-DO');
    }

    function listingCard(l) {
      const price    = formatPrice(l.price);
      const location = [l.sector, l.city].filter(Boolean).join(', ');
      const badge    = l.type === 'alquiler' ? 'EN ALQUILER' : 'EN VENTA';
      const badgeClr = l.type === 'alquiler' ? '#0066cc' : '#1a7a4a';
      const specs    = [
        l.bedrooms  ? `🛏 ${l.bedrooms} hab.`  : '',
        l.bathrooms ? `🚿 ${l.bathrooms} baños` : '',
        l.area_const ? `📐 ${l.area_const} m²`  : '',
      ].filter(Boolean).join('&nbsp;&nbsp;');
      return `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:18px 20px;background:#ffffff;">
              <div style="margin-bottom:8px;">
                <span style="display:inline-block;background:${badgeClr};color:#fff;font-size:0.65rem;font-weight:700;letter-spacing:1px;padding:3px 10px;border-radius:20px;text-transform:uppercase;">${badge}</span>
              </div>
              <div style="font-size:1.15rem;font-weight:800;color:#002D62;margin-bottom:4px;">${price}</div>
              <div style="font-size:0.9rem;font-weight:600;color:#1a2b40;margin-bottom:6px;line-height:1.3;">${l.title}</div>
              <div style="font-size:0.8rem;color:#7a9bbf;margin-bottom:10px;">📍 ${location}</div>
              ${specs ? `<div style="font-size:0.78rem;color:#4d6a8a;margin-bottom:14px;">${specs}</div>` : ''}
              <a href="${BASE_URL}/listing/${l.id}" style="display:inline-block;background:#eef3fa;color:#002D62;font-size:0.82rem;font-weight:700;padding:8px 18px;border-radius:8px;text-decoration:none;">Ver propiedad →</a>
            </td>
          </tr>
        </table>`;
    }

    const trendingHTML = trending.length
      ? `
        <!-- Trending listings -->
        <tr><td style="padding:0 40px 32px;">
          <div style="margin-bottom:16px;">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7a9bbf;margin-bottom:6px;">🔥 LO MÁS VISTO AHORA</div>
            <div style="font-size:1.05rem;font-weight:800;color:#1a2b40;">Propiedades que están dando de qué hablar</div>
          </div>
          ${trending.map(listingCard).join('')}
          <div style="text-align:center;margin-top:8px;">
            <a href="${BASE_URL}/comprar" style="display:inline-block;border:2px solid #002D62;color:#002D62;font-size:0.85rem;font-weight:700;padding:10px 28px;border-radius:10px;text-decoration:none;">Ver todas las propiedades →</a>
          </div>
        </td></tr>`
      : '';

    const et = require('../utils/email-templates');
    transporter.sendMail({
      to:      user.email,
      subject: `Bienvenido a HogaresRD, ${user.name.split(' ')[0]}`,
      html: et.layout({
        title: `Hola, ${et.esc(user.name.split(' ')[0])}`,
        subtitle: 'Tu cuenta de cliente esta lista',
        body: et.p('Ya eres parte de la comunidad inmobiliaria de la Republica Dominicana. Con tu cuenta puedes explorar propiedades, guardar favoritas y contactar agentes directamente.')
            + et.divider()
            + et.p('<strong>Lo que puedes hacer con tu cuenta:</strong>')
            + et.featureList([
                'Explorar propiedades en venta, alquiler y nuevos proyectos',
                'Buscar por provincia, ciudad, tipo de propiedad y rango de precio',
                'Guardar propiedades favoritas sincronizadas entre web y app',
                'Ver propiedades en un mapa interactivo',
                'Usar la calculadora de hipoteca integrada',
                'Contactar agentes y chatear directamente sobre una propiedad',
                'Agendar visitas a propiedades con calendario de disponibilidad',
                'Aplicar a propiedades con un formulario completo',
                'Recibir alertas cuando nuevas propiedades coincidan con tus busquedas guardadas',
                'Acceder al Asistente IA para resolver dudas sobre el mercado dominicano',
              ])
            + et.button('Explorar Propiedades', `${BASE_URL}/home`)
            + (trendingHTML ? trendingHTML : '')
            + et.divider()
            + et.p('Si tienes preguntas, responde directamente a este correo.<br/><br/>Hasta pronto,<br/><strong>El equipo de HogaresRD</strong>')
            + (user.marketingOptIn ? et.small('Recibiras novedades y propiedades destacadas. Puedes cancelar en cualquier momento respondiendo a este correo.') : ''),
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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await bcrypt.hash(password, 10);
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
      marketingOptIn:  true,
      subscriptionStatus: 'trial',
      trialEndsAt:     new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
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
            from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
            to:      inm.email,
            subject: `Nueva solicitud de afiliación — ${user.name}`,
            html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
              <div style="background:#002D62;color:#fff;padding:1.5rem;border-radius:12px 12px 0 0;">
                <h2 style="margin:0;font-size:1.1rem;">Nueva Solicitud de Afiliación</h2>
              </div>
              <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px;">
                <p>El agente <strong>${user.name}</strong> (${user.email}) solicitó afiliarse a <strong>${inm.companyName || inm.name}</strong> al crear su cuenta.</p>
                ${user.licenseNumber ? `<p>Licencia: <strong>${user.licenseNumber}</strong></p>` : ''}
                <p>Ingresa a tu dashboard para aprobar o rechazar la solicitud.</p>
                <a href="${BASE_URL}/broker#team-requests" style="display:inline-block;background:#002D62;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver Solicitudes →</a>
              </div>
            </div>`,
          }).catch(e => console.error('Inm notify email error:', e.message));
        }
      } catch (e) {
        console.error('Join request creation error:', e.message);
      }
    }

    transporter.sendMail({
      from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
      to:      user.email,
      subject: '¡Bienvenido a HogaresRD! Tu cuenta de inmobiliaria está lista 🏢',
      html: `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#004aaa 100%);padding:36px 40px;">
          <div style="font-size:1rem;font-weight:900;color:#fff;">🏢 HogaresRD — Inmobiliarias</div>
          <div style="margin-top:16px;font-size:1.5rem;font-weight:800;color:#fff;">¡Bienvenido, ${name.split(' ')[0]}!</div>
          <div style="margin-top:4px;font-size:0.88rem;color:rgba(255,255,255,0.75);">${agencyName} · Cuenta verificada</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 16px;font-size:0.95rem;color:#1a2b40;line-height:1.6;">Tu cuenta de agente está activa. Aquí tienes lo que puedes hacer:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
            <tr><td style="padding:9px 0;border-bottom:1px solid #eef3fa;"><span style="margin-right:10px;">🔗</span><span style="color:#4d6a8a;font-size:0.9rem;"><strong>Genera enlaces afiliados</strong> para cada propiedad y envíalos a tus clientes</span></td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #eef3fa;"><span style="margin-right:10px;">📩</span><span style="color:#4d6a8a;font-size:0.9rem;">Clientes que usen tu enlace te contactan <strong>directamente a ti</strong></span></td></tr>
            <tr><td style="padding:9px 0;"><span style="margin-right:10px;">🏠</span><span style="color:#4d6a8a;font-size:0.9rem;">Publica propiedades y proyectos en el portal</span></td></tr>
          </table>
          <div style="background:#f0f4f9;border-radius:10px;padding:16px 20px;margin-top:8px;">
            <div style="font-size:0.75rem;font-weight:700;color:#4d6a8a;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Tu código de agente</div>
            <div style="font-size:1.05rem;font-weight:800;color:#002D62;letter-spacing:2px;font-family:monospace;">${refToken}</div>
            <div style="font-size:0.73rem;color:#7a9bbf;margin-top:4px;">Se incluye automáticamente en tus enlaces afiliados</div>
          </div>
          <div style="margin-top:28px;text-align:center;">
            <a href="${BASE_URL}/home" style="display:inline-block;background:#002D62;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:0.95rem;">Explorar Propiedades →</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.76rem;color:#7a9bbf;text-align:center;">© ${new Date().getFullYear()} HogaresRD · Lic. ${licenseNumber}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await bcrypt.hash(password, 10);
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
      marketingOptIn:  true,
      subscriptionStatus: 'trial',
      trialEndsAt:     new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
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
          // Notify the inmobiliaria of the pending request
          transporter.sendMail({
            from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
            to:      inm.email,
            subject: `Nueva solicitud de afiliación — ${user.name}`,
            html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
              <div style="background:#002D62;color:#fff;padding:1.5rem;border-radius:12px 12px 0 0;">
                <h2 style="margin:0;font-size:1.1rem;">Nueva Solicitud de Afiliación</h2>
              </div>
              <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px;">
                <p>El agente <strong>${user.name}</strong> (${user.email}) solicitó afiliarse a <strong>${inm.companyName || inm.name}</strong> al crear su cuenta.</p>
                ${user.licenseNumber ? `<p>Licencia: <strong>${user.licenseNumber}</strong></p>` : ''}
                <p>Ingresa a tu dashboard para aprobar o rechazar la solicitud.</p>
                <a href="${BASE_URL}/broker#team-requests" style="display:inline-block;background:#002D62;color:#fff;padding:.7rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver Solicitudes →</a>
              </div>
            </div>`,
          }).catch(e => console.error('Inm notify email error:', e.message));
        }
      } catch (e) {
        console.error('Join request creation error:', e.message);
      }
    }

    transporter.sendMail({
      from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
      to:      user.email,
      subject: '¡Bienvenido a HogaresRD! Tu cuenta de agente está lista 🏡',
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#1a5fa8 100%);padding:36px 40px;">
          <div style="font-size:1rem;font-weight:900;color:#fff;">🏠 HogaresRD — Agentes</div>
          <div style="margin-top:16px;font-size:1.5rem;font-weight:800;color:#fff;">¡Bienvenido, ${name.split(' ')[0]}!</div>
          <div style="margin-top:4px;font-size:0.88rem;color:rgba(255,255,255,0.75);">Agente Broker · Lic. ${licenseNumber}</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 16px;font-size:0.95rem;color:#1a2b40;line-height:1.6;">Tu cuenta de agente broker está activa. Desde tu dashboard puedes:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
            <tr><td style="padding:9px 0;border-bottom:1px solid #eef3fa;"><span style="margin-right:10px;">📋</span><span style="color:#4d6a8a;font-size:0.9rem;">Gestionar aplicaciones de clientes</span></td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #eef3fa;"><span style="margin-right:10px;">🏢</span><span style="color:#4d6a8a;font-size:0.9rem;">Afiliarte a una inmobiliaria</span></td></tr>
            <tr><td style="padding:9px 0;"><span style="margin-right:10px;">📊</span><span style="color:#4d6a8a;font-size:0.9rem;">Ver analíticas de tus ventas</span></td></tr>
          </table>
          <div style="margin-top:24px;text-align:center;">
            <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:0.95rem;">Ir a mi Dashboard →</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.76rem;color:#7a9bbf;text-align:center;">© ${new Date().getFullYear()} HogaresRD · Lic. ${licenseNumber}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await bcrypt.hash(password, 10);
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
      marketingOptIn:  true,
      subscriptionStatus: 'trial',
      trialEndsAt:     new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      stripeCustomerId:    null,
      stripeSubscriptionId: null,
      join_requests:   [],
    };

    const verifyRawToken = attachVerifyToken(user);
    store.saveUser(user);

    transporter.sendMail({
      from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
      to:      user.email,
      subject: `¡Bienvenido a HogaresRD! ${companyName} está registrada 🏢`,
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#0a4d8f 100%);padding:36px 40px;">
          <div style="font-size:1rem;font-weight:900;color:#fff;">🏢 HogaresRD — Inmobiliarias</div>
          <div style="margin-top:16px;font-size:1.5rem;font-weight:800;color:#fff;">${companyName}</div>
          <div style="margin-top:4px;font-size:0.88rem;color:rgba(255,255,255,0.75);">Cuenta registrada · Lic. ${licenseNumber}</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 16px;font-size:0.95rem;color:#1a2b40;line-height:1.6;">Hola <strong>${name.split(' ')[0]}</strong>, tu inmobiliaria ya está registrada en HogaresRD.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
            <tr><td style="padding:9px 0;border-bottom:1px solid #eef3fa;"><span style="margin-right:10px;">👥</span><span style="color:#4d6a8a;font-size:0.9rem;">Aprueba solicitudes de afiliación de agentes brokers</span></td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #eef3fa;"><span style="margin-right:10px;">📊</span><span style="color:#4d6a8a;font-size:0.9rem;">Supervisión total de todas las aplicaciones de tu equipo</span></td></tr>
            <tr><td style="padding:9px 0;"><span style="margin-right:10px;">💰</span><span style="color:#4d6a8a;font-size:0.9rem;">Gestión de planes de pagos y contabilidad consolidada</span></td></tr>
          </table>
          <div style="margin-top:24px;text-align:center;">
            <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:0.95rem;">Ir a mi Dashboard →</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.76rem;color:#7a9bbf;text-align:center;">© ${new Date().getFullYear()} HogaresRD · Lic. ${licenseNumber}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
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
            from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
            to:      agent.email,
            subject: `¡${companyName} ya está en HogaresRD! Conecta tu cuenta ahora 🔗`,
            html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#1a5fa8 100%);padding:36px 40px;">
          <div style="font-size:1rem;font-weight:900;color:#fff;">🔗 HogaresRD — Conexión de Equipo</div>
          <div style="margin-top:16px;font-size:1.5rem;font-weight:800;color:#fff;">¡Buenas noticias, ${agent.name.split(' ')[0]}!</div>
          <div style="margin-top:4px;font-size:0.88rem;color:rgba(255,255,255,0.75);">${companyName} acaba de registrarse</div>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 16px;font-size:0.95rem;color:#1a2b40;line-height:1.6;">
            <strong>${companyName}</strong>, la inmobiliaria que indicaste cuando creaste tu cuenta, acaba de registrarse en HogaresRD.
          </p>
          <p style="margin:0 0 24px;font-size:0.9rem;color:#4d6a8a;line-height:1.6;">
            Ahora puedes enviarles una solicitud de afiliación desde tu dashboard. Una vez que la aprueben, quedarás oficialmente vinculado a su equipo.
          </p>
          <div style="text-align:center;">
            <a href="${BASE_URL}/broker" style="display:inline-block;background:#002D62;color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:0.95rem;">Ir a mi Dashboard →</a>
          </div>
          <p style="margin:20px 0 0;font-size:0.75rem;color:#7a9bbf;text-align:center;">
            En tu dashboard encontrarás el botón "Buscar y solicitar" en la sección de afiliación.
          </p>
        </td></tr>
        <tr><td style="padding:16px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.76rem;color:#7a9bbf;text-align:center;">© ${new Date().getFullYear()} HogaresRD</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
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
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await bcrypt.hash(password, 10);
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
      marketingOptIn:  true,
      subscriptionStatus: 'trial',
      trialEndsAt:     new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
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
          from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
          to:      user.email,
          subject: '⚠️ Tu cuenta ha sido bloqueada temporalmente — HogaresRD',
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
        <tr><td style="background:#b91c1c;padding:32px 40px;">
          <div style="font-size:1rem;font-weight:900;color:#fff;margin-bottom:8px;">🏠 HogaresRD</div>
          <div style="font-size:1.4rem;font-weight:800;color:#fff;">Cuenta bloqueada temporalmente</div>
        </td></tr>
        <tr><td style="padding:28px 40px;">
          <p style="margin:0 0 16px;font-size:0.95rem;color:#1a2b40;line-height:1.6;">
            Hola <strong>${user.name}</strong>, detectamos <strong>${attempts} intentos fallidos de inicio de sesión</strong> en tu cuenta y la hemos bloqueado por 15 minutos como medida de seguridad.
          </p>
          <p style="margin:0 0 24px;font-size:0.9rem;color:#4d6a8a;line-height:1.6;">
            Si no fuiste tú quien intentó iniciar sesión, te recomendamos cambiar tu contraseña inmediatamente.
          </p>
          <div style="text-align:center;">
            <a href="${BASE_URL}/reset-password" style="display:inline-block;background:#002D62;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:0.9rem;">Cambiar contraseña →</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.76rem;color:#7a9bbf;text-align:center;">© ${new Date().getFullYear()} HogaresRD · Si no reconoces esta actividad, contacta soporte.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
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
      const code = String(Math.floor(100000 + Math.random() * 900000));
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

    const token = signToken(user);

    // Set JWT in an httpOnly cookie — XSS-proof primary auth mechanism.
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   IS_PROD,      // HTTPS-only in production
      sameSite: 'lax',        // CSRF protection; still works with normal navigation
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days in ms
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
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.jti) {
        store.revokeToken(payload.jti, payload.exp);
        logSec('logout', req, { userId: payload.sub });
      }
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
    from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
    to:      user.email,
    subject: 'Restablecer tu contraseña — HogaresRD',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
        <div style="background:#002D62;padding:28px 32px;">
          <h2 style="color:#fff;margin:0;font-size:1.3rem;">🔒 Restablecer Contraseña</h2>
        </div>
        <div style="padding:28px 32px;background:#fff;">
          <p style="color:#1a2b40;">Hola <strong>${user.name}</strong>,</p>
          <p style="color:#4d6a8a;line-height:1.6;">Recibimos una solicitud para restablecer la contraseña de tu cuenta en HogaresRD. Haz clic en el botón a continuación para crear una nueva contraseña.</p>
          <p style="color:#4d6a8a;"><strong>Este enlace expira en 1 hora.</strong></p>
          <div style="margin-top:24px;">
            <a href="${BASE_URL}/reset-password?token=${rawToken}" style="background:#002D62;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
              Restablecer Contraseña →
            </a>
          </div>
          <p style="margin-top:24px;font-size:0.85rem;color:#4d6a8a;">Si no solicitaste esto, ignora este correo. Tu contraseña no cambiará.</p>
        </div>
        <div style="padding:16px 32px;background:#f0f4f9;font-size:0.8rem;color:#4d6a8a;">
          HogaresRD · República Dominicana
        </div>
      </div>`,
  }).catch(err => console.error('Reset email error:', err.message));
});

// ── Reset password ─────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'Token y contraseña son requeridos' });
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

    user.passwordHash     = await bcrypt.hash(password, 10);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    store.saveUser(user);

    logSec('reset_used', req, { userId: user.id });
    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) { next(err); }
});

// ── Verify email ───────────────────────────────────────────────────────────
// The link in the email is a GET — verifies and redirects to the landing page.
router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect(`${BASE_URL}/verify-email?status=invalid`);

  const submittedHash = crypto.createHash('sha256').update(token).digest('hex');
  const users = store.getUsers();
  const user  = users.find(u => u.emailVerifyToken === submittedHash);

  if (!user) return res.redirect(`${BASE_URL}/verify-email?status=invalid`);
  if (new Date(user.emailVerifyExpiry) < new Date())
    return res.redirect(`${BASE_URL}/verify-email?status=expired`);

  user.emailVerified     = true;
  user.emailVerifyToken  = null;
  user.emailVerifyExpiry = null;
  store.saveUser(user);

  logSec('email_verified', req, { userId: user.id });
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
    sendVerificationEmail(user, rawToken);
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

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    if (store.getUserByEmail(email))
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await bcrypt.hash(password, 10);
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
      return res.status(400).json({ error: 'Este correo ya está registrado' });

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
      sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.status(201).json({ token: jwtToken, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── 2FA: Verify code ──────────────────────────────────────────────────────
router.post('/2fa/verify', twoFALimiter, (req, res) => {
  const { twoFASessionId, code } = req.body;
  if (!twoFASessionId || !code) return res.status(400).json({ error: 'Sesión y código requeridos' });

  const session = store.getTwoFASession(twoFASessionId);
  if (!session) return res.status(400).json({ error: 'Sesión de verificación inválida o expirada' });
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
    logSec('2fa_failed', req, { userId: session.userId, attempts: session.attempts });
    return res.status(401).json({ error: 'Código incorrecto', attemptsRemaining: 5 - session.attempts });
  }

  // Success — issue token
  store.deleteTwoFASession(twoFASessionId);
  const user = store.getUserById(session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  logSec('2fa_verified', req, { userId: user.id });
  logSec('login_success', req, { userId: user.id, role: user.role, via: '2fa' });

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: IS_PROD, sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
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

  const user = store.getUserById(session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Generate new code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  session.codeHash = crypto.createHash('sha256').update(code).digest('hex');
  session.expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  session.attempts = 0;
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
  const code = String(Math.floor(100000 + Math.random() * 900000));
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
    const code = String(Math.floor(100000 + Math.random() * 900000));
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
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: IS_PROD, sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ token, user: safeUser(user) });
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
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) { req.user = null; return next(); }
  try {
    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.jti && store.isTokenRevoked(decoded.jti)) { req.user = null; return next(); }
    req.user = decoded;
  } catch { req.user = null; }
  next();
}

module.exports        = router;
module.exports.userAuth = userAuth;
module.exports.optionalAuth = optionalAuth;
