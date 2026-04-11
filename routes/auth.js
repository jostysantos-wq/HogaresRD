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
  const firstName = (user.name || '').split(' ')[0] || 'Usuario';
  try {
    await transporter.sendMail({
      to:      user.email,
      subject: 'Nuevo inicio de sesión en tu cuenta HogaresRD',
      html: `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table width="100%" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
  <tr><td style="background:linear-gradient(135deg,#002D62,#1a5fa8);padding:24px 32px;">
    <div style="font-size:1.1rem;font-weight:800;color:#fff;">Nuevo inicio de sesión detectado</div>
  </td></tr>
  <tr><td style="padding:24px 32px;">
    <p style="margin:0 0 12px;color:#1a2b40;">Hola <strong>${firstName}</strong>,</p>
    <p style="margin:0 0 16px;font-size:0.92rem;color:#4d6a8a;line-height:1.55;">
      Detectamos un inicio de sesión en tu cuenta desde un dispositivo o red nueva:
    </p>
    <table width="100%" style="background:#f0f6ff;border-radius:10px;padding:14px 18px;font-size:0.85rem;color:#1a2b40;margin-bottom:14px;">
      <tr><td style="padding:4px 0;color:#7a9bbf;">Fecha:</td><td style="padding:4px 0;"><strong>${when}</strong></td></tr>
      <tr><td style="padding:4px 0;color:#7a9bbf;">IP:</td><td style="padding:4px 0;"><strong>${ip}</strong></td></tr>
      <tr><td style="padding:4px 0;color:#7a9bbf;">Navegador:</td><td style="padding:4px 0;font-size:0.78rem;">${userAgent.slice(0, 120)}</td></tr>
    </table>
    <p style="margin:0;font-size:0.82rem;color:#7a9bbf;line-height:1.55;">
      ¿No fuiste tú? Cambia tu contraseña inmediatamente y revoca sesiones activas desde tu perfil.
    </p>
  </td></tr>
</table>
</td></tr></table></body></html>`,
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
  const firstName = user.name.split(' ')[0];
  return transporter.sendMail({
    to:         user.email,
    subject:    'Verifica tu correo — HogaresRD',
    department: 'soporte',
    html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:0 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <!-- Logo -->
  <tr><td style="padding:40px 0 32px;">
    <div style="font-size:1.4rem;font-weight:900;color:#002D62;letter-spacing:-0.5px;">HogaresRD</div>
  </td></tr>

  <!-- Headline -->
  <tr><td>
    <h1 style="margin:0 0 24px;font-size:1.75rem;font-weight:800;color:#1a1a1a;line-height:1.2;">Verifica tu correo electronico</h1>
  </td></tr>

  <!-- Body -->
  <tr><td>
    <p style="margin:0 0 24px;font-size:1rem;color:#333;line-height:1.7;">
      Hola ${firstName}, haz clic en el boton de abajo para verificar tu direccion de correo electronico y activar tu cuenta. Este enlace expira en <strong>24 horas</strong>.
    </p>
  </td></tr>

  <!-- Button -->
  <tr><td style="padding:8px 0 32px;">
    <a href="${verifyUrl}" style="display:inline-block;background:#002D62;color:#ffffff;padding:16px 40px;border-radius:6px;text-decoration:none;font-weight:700;font-size:1rem;">Verificar mi correo</a>
  </td></tr>

  <!-- Secondary -->
  <tr><td>
    <p style="margin:0 0 8px;font-size:0.85rem;color:#666;line-height:1.6;">
      Si no creaste esta cuenta, puedes ignorar este correo.
    </p>
    <p style="margin:0;font-size:0.8rem;color:#999;line-height:1.6;">
      Para mayor seguridad, no compartas este enlace con nadie.
    </p>
  </td></tr>

  <!-- Divider -->
  <tr><td style="padding:32px 0 0;">
    <div style="border-top:1px solid #e5e5e5;"></div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 0 40px;">
    <p style="margin:0 0 4px;font-size:0.75rem;color:#999;font-weight:600;">El equipo de HogaresRD</p>
    <p style="margin:0;font-size:0.72rem;color:#bbb;">Republica Dominicana · hogaresrd.com</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`,
  }).catch(err => console.error('Verification email error:', err.message));
}

function send2FAEmail(user, code) {
  const firstName = user.name.split(' ')[0];
  const codeSpaced = code.toString().split('').join(' ');
  return transporter.sendMail({
    to:         user.email,
    department: 'soporte',
    subject:    'Tu codigo de verificacion — HogaresRD',
    html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:0 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <!-- Logo -->
  <tr><td style="padding:40px 0 32px;">
    <div style="font-size:1.4rem;font-weight:900;color:#002D62;letter-spacing:-0.5px;">HogaresRD</div>
  </td></tr>

  <!-- Headline -->
  <tr><td>
    <h1 style="margin:0 0 24px;font-size:1.75rem;font-weight:800;color:#1a1a1a;line-height:1.2;">Ingresa este codigo para iniciar sesion</h1>
  </td></tr>

  <!-- Code -->
  <tr><td>
    <div style="font-size:2.5rem;font-weight:300;color:#1a1a1a;letter-spacing:0.15em;margin:0 0 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${codeSpaced}</div>
  </td></tr>

  <!-- Body -->
  <tr><td>
    <p style="margin:0 0 20px;font-size:1rem;color:#333;line-height:1.7;">
      Ingresa el codigo de arriba en tu dispositivo para iniciar sesion en HogaresRD. Este codigo expira en <strong>5 minutos</strong>.
    </p>
    <p style="margin:0 0 8px;font-size:0.85rem;color:#666;line-height:1.6;">
      Si no solicitaste este codigo, puedes ignorar este correo.
    </p>
    <p style="margin:0;font-size:0.8rem;color:#999;line-height:1.6;">
      Para mayor seguridad, no compartas este codigo con nadie.
    </p>
  </td></tr>

  <!-- Divider -->
  <tr><td style="padding:32px 0 0;">
    <div style="border-top:1px solid #e5e5e5;"></div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 0 40px;">
    <p style="margin:0 0 4px;font-size:0.75rem;color:#999;font-weight:600;">El equipo de HogaresRD</p>
    <p style="margin:0;font-size:0.72rem;color:#bbb;">Republica Dominicana · hogaresrd.com</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`,
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
    const allListings = store.getListings();
    const listingsArr = Array.isArray(allListings) ? allListings : (allListings.listings || []);
    const trending = listingsArr
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 3);

    // Reuse the shared hero-image listing card so the welcome email's
    // trending section shows actual property photos instead of a text-only
    // card. The helper ensures image URLs are absolute and handles Outlook's
    // VML fallback automatically.
    const { listingCard } = require('../utils/email-templates');

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

    transporter.sendMail({
      department: 'soporte',
      to:      user.email,
      subject: `¡Bienvenido a HogaresRD, ${user.name.split(' ')[0]}! Tu hogar ideal te espera 🏠`,
      html: `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#1a5fa8 100%);padding:40px 40px 36px;">
          <div style="font-size:1rem;font-weight:900;color:#ffffff;letter-spacing:-0.5px;margin-bottom:24px;">🏠 HogaresRD</div>
          <div style="font-size:1.75rem;font-weight:800;color:#ffffff;line-height:1.2;margin-bottom:8px;">
            ¡Hola, ${user.name.split(' ')[0]}! 👋
          </div>
          <div style="font-size:1rem;color:rgba(255,255,255,0.8);line-height:1.5;">
            Ya eres parte de la comunidad inmobiliaria más completa de la República Dominicana.
          </div>
        </td></tr>

        <!-- Intro -->
        <tr><td style="padding:36px 40px 24px;">
          <p style="margin:0 0 16px;font-size:1rem;color:#1a2b40;line-height:1.7;">
            Nos alegra tenerte aquí. En <strong>HogaresRD</strong> encontrarás desde acogedores apartamentos en Santo Domingo hasta villas frente al mar en Punta Cana — y todo lo que hay en el medio. 🌴
          </p>
          <p style="margin:0 0 24px;font-size:1rem;color:#1a2b40;line-height:1.7;">
            Con tu cuenta puedes guardar favoritos, contactar directamente a las inmobiliarias y recibir actualizaciones de las propiedades que te interesan. Básicamente, encontrar tu próximo hogar acaba de volverse mucho más fácil.
          </p>

          <!-- Features -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8fd;border-radius:12px;padding:4px 0;margin-bottom:28px;">
            <tr><td style="padding:12px 20px;border-bottom:1px solid #e0e8f5;">
              <span style="font-size:1rem;margin-right:10px;">🔍</span>
              <span style="font-size:0.9rem;color:#1a2b40;font-weight:600;">Busca por ciudad, precio, tipo y más filtros</span>
            </td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #e0e8f5;">
              <span style="font-size:1rem;margin-right:10px;">📍</span>
              <span style="font-size:0.9rem;color:#1a2b40;font-weight:600;">Explora propiedades en un mapa interactivo</span>
            </td></tr>
            <tr><td style="padding:12px 20px;">
              <span style="font-size:1rem;margin-right:10px;">💬</span>
              <span style="font-size:0.9rem;color:#1a2b40;font-weight:600;">Contacta inmobiliarias directamente desde cada anuncio</span>
            </td></tr>
          </table>

          <!-- Main CTA -->
          <div style="text-align:center;margin-bottom:8px;">
            <a href="${BASE_URL}/home" style="display:inline-block;background:#002D62;color:#ffffff;padding:15px 40px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;letter-spacing:0.3px;">
              Explorar propiedades →
            </a>
          </div>
        </td></tr>

        ${trendingHTML}

        <!-- Closing -->
        <tr><td style="padding:0 40px 36px;">
          <p style="margin:0;font-size:0.9rem;color:#4d6a8a;line-height:1.7;">
            Si tienes alguna pregunta, responde directamente a este correo y con gusto te ayudamos. 😊<br/><br/>
            Hasta pronto,<br/>
            <strong style="color:#002D62;">El equipo de HogaresRD</strong>
          </p>
          ${user.marketingOptIn ? `<p style="margin:16px 0 0;font-size:0.78rem;color:#a0b4cc;">Recibirás ocasionalmente novedades y propiedades destacadas. Puedes cancelar en cualquier momento respondiendo a este correo.</p>` : ''}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.75rem;color:#9ab0c8;text-align:center;line-height:1.6;">
            © ${new Date().getFullYear()} HogaresRD &mdash; República Dominicana<br/>
            <a href="${BASE_URL}/home" style="color:#9ab0c8;text-decoration:underline;">hogaresrd.com</a>
            &nbsp;·&nbsp;
            <a href="${BASE_URL}/ciudades" style="color:#9ab0c8;text-decoration:underline;">Explorar ciudades</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`,
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
      marketingOptIn:  true,
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
      department: 'soporte',
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
      marketingOptIn:  true,
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
          // Notify the inmobiliaria of the pending request
          transporter.sendMail({
            department: 'soporte',
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
      department: 'soporte',
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
      marketingOptIn:  true,
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
            department: 'soporte',
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
      marketingOptIn:  true,
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
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
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

    if (!validateEmail(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
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

  const user = store.getUserById(session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Generate new code
  const code = String(crypto.randomInt(100000, 999999));
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
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: IS_PROD, sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000,
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
  try {
    const res = await fetch('https://appleid.apple.com/auth/keys');
    if (!res.ok) throw new Error('Apple JWKS fetch failed: ' + res.status);
    _appleKeysCache = await res.json();
    _appleKeysCacheTs = now;
    return _appleKeysCache;
  } catch (err) {
    console.error('[auth] Failed to fetch Apple keys:', err.message);
    return _appleKeysCache; // Return stale cache if available
  }
}

async function verifyAppleToken(identityToken) {
  const jwt = require('jsonwebtoken');
  const jwksClient = require('jwks-rsa');

  // First try full verification with Apple's public keys
  try {
    const jwks = await getApplePublicKeys();
    if (jwks && jwks.keys) {
      const header = JSON.parse(Buffer.from(identityToken.split('.')[0], 'base64url').toString());
      const key = jwks.keys.find(k => k.kid === header.kid);
      if (key) {
        // Convert JWK to PEM
        const crypto = require('crypto');
        const pubKey = crypto.createPublicKey({ key, format: 'jwk' });
        const pem = pubKey.export({ type: 'spki', format: 'pem' });
        const decoded = jwt.verify(identityToken, pem, {
          algorithms: ['RS256'],
          issuer: 'https://appleid.apple.com',
        });
        return { verified: true, decoded };
      }
    }
  } catch (verifyErr) {
    console.warn('[auth] Apple token verification failed, falling back to decode:', verifyErr.message);
  }

  // Fallback: decode without verification (for dev/testing)
  const decoded = jwt.decode(identityToken);
  if (!decoded || !decoded.sub) return { verified: false, decoded: null };
  return { verified: false, decoded };
}

router.post('/apple', async (req, res) => {
  try {
    const { identityToken, name, email } = req.body;
    if (!identityToken) {
      console.warn('[auth] Apple Sign In: missing identityToken');
      return res.status(400).json({ error: 'Missing identityToken' });
    }

    // Verify and decode the Apple identity token
    const { verified, decoded } = await verifyAppleToken(identityToken);
    if (!decoded || !decoded.sub) {
      console.warn('[auth] Apple Sign In: invalid token (decode failed)');
      return res.status(400).json({ error: 'Invalid Apple token' });
    }

    if (!verified) {
      console.warn('[auth] Apple Sign In: token not cryptographically verified (using decoded sub)');
    }

    const appleUserId = decoded.sub;
    const appleEmail = email || decoded.email || `apple_${appleUserId.substring(0, 8)}@hogaresrd.com`;
    const userName = name || (decoded.email ? decoded.email.split('@')[0] : `Usuario Apple`);

    console.log(`[auth] Apple Sign In attempt: sub=${appleUserId.substring(0,8)}…, email=${appleEmail}, verified=${verified}`);

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

// DELETE /auth/delete-account — permanently delete user account and all associated data
router.delete('/delete-account', userAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const user = store.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Delete user data from database
    if (store.pool) {
      await store.pool.query('DELETE FROM conversations WHERE client_id = $1 OR broker_id = $1', [userId]);
      await store.pool.query('DELETE FROM tours WHERE client_id = $1 OR broker_id = $1', [userId]);
      await store.pool.query('DELETE FROM applications WHERE client_id = $1 OR broker_id = $1', [userId]);
      await store.pool.query('DELETE FROM push_subscriptions WHERE userId = $1', [userId]);
      await store.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }

    // Remove from in-memory cache
    store.deleteUser(userId);

    console.log(`[auth] Account deleted: ${userId} (${user.email})`);
    res.json({ ok: true, message: 'Cuenta eliminada permanentemente' });
  } catch (err) {
    console.error('[auth] Delete account error:', err.message);
    res.status(500).json({ error: 'Error al eliminar la cuenta' });
  }
});

// POST /auth/apple-subscription — Sync Apple IAP subscription with user role
router.post('/apple-subscription', userAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { productID, transactionID, originalTransactionID, role, expirationDate } = req.body;

    if (!productID || !transactionID || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validRoles = ['broker', 'inmobiliaria', 'constructora'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid subscription role' });
    }

    const user = store.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Update user role
    const previousRole = user.role;
    user.role = role;

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
      expirationDate: expirationDate || null,
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
