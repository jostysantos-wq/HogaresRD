/**
 * Admin authentication — Option C
 *   Step 1 : POST /login   → username + password → sends OTP email
 *   Step 2 : POST /verify  → OTP → issues httpOnly session cookie
 *   Logout : POST /logout  → clears cookie
 *
 * Middleware exported: adminSessionAuth
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { createTransport } = require('./mailer');
const et = require('../utils/email-templates');

// TOTP settings — 30-second window, ±1 step drift tolerance.
// otplib v13: pass options on each verify call, not as a global setter.
const TOTP_OPTIONS = { window: 1 };

const router = express.Router();
const mailer = createTransport();

// ── Startup validation ───────────────────────────────────────────────────────
if (process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.length < 32) {
  console.warn('[admin-auth] WARNING: ADMIN_SESSION_SECRET is shorter than 32 characters — consider using a stronger secret');
}

// ── Constants ─────────────────────────────────────────────────────────────────
const RATE_WINDOW  = 15 * 60 * 1000;   // 15 min window for login attempts
const MAX_ATTEMPTS = 5;                 // max password attempts per window
const OTP_TTL      = 10 * 60 * 1000;   // OTP valid for 10 minutes
const MAX_OTP_TRIES = 3;               // wrong OTP attempts before invalidation
const SESSION_TTL  = 8 * 60 * 60;      // session cookie lifetime (seconds)
const COOKIE_NAME  = 'admin_sess';

// ── In-memory stores (reset on server restart — acceptable for admin) ─────────
const _loginAttempts = new Map(); // ip → { count, windowStart }
const _otpStore      = new Map(); // tempToken → { otp, expiresAt, attempts }

// ── Helpers ───────────────────────────────────────────────────────────────────

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = _loginAttempts.get(ip) || { count: 0, windowStart: now };

  if (now - rec.windowStart > RATE_WINDOW) {
    _loginAttempts.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (rec.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((RATE_WINDOW - (now - rec.windowStart)) / 1000);
    return { allowed: false, retryAfter };
  }

  rec.count++;
  _loginAttempts.set(ip, rec);
  return { allowed: true };
}

function issueSessionCookie(res) {
  const token = jwt.sign(
    { admin: true },
    process.env.ADMIN_SESSION_SECRET,
    { expiresIn: SESSION_TTL }
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   SESSION_TTL * 1000,
    path:     '/',
  });
}

// Verify admin session JWT with rotation grace. Tries the current secret
// first; if that fails AND ADMIN_SESSION_SECRET_PREV is configured, tries
// the previous secret. Mirrors routes/auth.js JWT_SECRET_PREV pattern.
function _verifyAdminToken(token) {
  try {
    return jwt.verify(token, process.env.ADMIN_SESSION_SECRET);
  } catch (err) {
    if (process.env.ADMIN_SESSION_SECRET_PREV) {
      try { return jwt.verify(token, process.env.ADMIN_SESSION_SECRET_PREV); } catch (_) { /* fall through */ }
    }
    throw err;
  }
}

// ── Exported middleware ───────────────────────────────────────────────────────

function adminSessionAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    _verifyAdminToken(token);
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.status(401).json({ error: 'Sesión expirada' });
  }
}

// Same as above but redirects to login page instead of JSON (for page routes)
function adminSessionPage(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const loginPath = `/${process.env.ADMIN_PATH}/login`;
  if (!token) return res.redirect(loginPath);
  try {
    _verifyAdminToken(token);
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect(loginPath);
  }
}

// ── Step 1: POST /login ───────────────────────────────────────────────────────
// Accepts username + password. On success sends OTP to admin email.

router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    const mins = Math.ceil(rl.retryAfter / 60);
    return res.status(429).json({
      error: `Demasiados intentos. Espera ${mins} minuto${mins !== 1 ? 's' : ''} e intenta de nuevo.`
    });
  }

  const { username, password } = req.body || {};

  // Constant-time comparison to avoid user enumeration
  const validUser = typeof username === 'string' &&
    username.toLowerCase() === (process.env.ADMIN_USERNAME || '').toLowerCase();
  const hash = process.env.ADMIN_PASSWORD_HASH || '$2b$12$invalidhashplaceholder000000000000000000000000000000000';
  const validPass = await bcrypt.compare(password || '', hash);

  if (!validUser || !validPass) {
    console.warn(`[admin-auth] Failed login attempt from ${ip}`);
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  // Generate OTP + temp token
  const otp       = String(crypto.randomInt(100000, 999999));
  const tempToken = crypto.randomBytes(32).toString('hex');

  _otpStore.set(tempToken, {
    otp,
    expiresAt: Date.now() + OTP_TTL,
    attempts:  0,
  });

  // Purge expired OTPs
  for (const [k, v] of _otpStore) {
    if (Date.now() > v.expiresAt) _otpStore.delete(k);
  }

  const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;

  // Fallback: log OTP to server console so admin can recover even if
  // email delivery breaks.
  // OTP code intentionally NOT logged in production — sent via email only
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[admin-auth] OTP for ${adminEmail} (IP ${ip}): ${otp}`);
  } else {
    console.log(`[admin-auth] OTP sent to ${adminEmail} (IP ${ip})`);
  }

  try {
    await mailer.sendMail({
      to:      adminEmail,
      subject: 'Codigo de acceso — HogaresRD Admin',
      html: et.layout({
        title: 'Codigo de Acceso Admin',
        subtitle: 'HogaresRD — Panel de Administracion',
        preheader: 'Codigo de acceso al panel de administracion',
        body:
          et.p('Ingresa este codigo en el portal. Expira en <strong>10 minutos</strong>.')
          + et.codeBlock(otp)
          + et.small('Si no solicitaste este codigo, alguien tiene tus credenciales. Cambia tu contrasena inmediatamente.<br/>IP de origen registrada: <strong>' + ip + '</strong>'),
      }),
    });
    console.log(`[admin-auth] OTP emailed to ${adminEmail} (IP ${ip})`);
  } catch (e) {
    console.error(`[admin-auth] OTP email failed:`, e.message);
    // Keep the OTP valid — admin can recover it from server logs above.
    // Don't fail the request, since email can be flaky.
  }

  _loginAttempts.delete(ip);
  res.json({ step: 2, token: tempToken });
});

// ── Step 2: POST /verify ──────────────────────────────────────────────────────
// Accepts tempToken + code. Code can be either:
//   (a) the 6-digit email OTP we just sent, OR
//   (b) a valid TOTP (Google/Authy/1Password) if ADMIN_TOTP_SECRET is set
// TOTP is checked first — once enrolled, admin never needs to wait for email.

router.post('/verify', (req, res) => {
  const { token, otp } = req.body || {};
  if (!token || !otp) return res.status(400).json({ error: 'Datos incompletos' });

  const record = _otpStore.get(token);
  if (!record) return res.status(401).json({ error: 'Código inválido o expirado. Inicia sesión nuevamente.' });

  if (Date.now() > record.expiresAt) {
    _otpStore.delete(token);
    return res.status(401).json({ error: 'El código ha expirado. Inicia sesión nuevamente.' });
  }

  record.attempts++;
  const submitted = String(otp).trim();

  // Accept TOTP if configured
  const totpSecret = process.env.ADMIN_TOTP_SECRET;
  let okTotp = false;
  if (totpSecret) {
    try {
      // verify with drift tolerance (±1 step = ±30s)
      const { totp } = require('otplib');
      totp.options = TOTP_OPTIONS;
      okTotp = totp.check(submitted, totpSecret);
    } catch {}
  }
  const okEmail = submitted === record.otp;

  if (!okTotp && !okEmail) {
    if (record.attempts >= MAX_OTP_TRIES) {
      _otpStore.delete(token);
      return res.status(401).json({ error: 'Demasiados intentos incorrectos. Inicia sesión nuevamente.' });
    }
    const left = MAX_OTP_TRIES - record.attempts;
    return res.status(401).json({ error: `Código incorrecto. ${left} intento${left !== 1 ? 's' : ''} restante${left !== 1 ? 's' : ''}.` });
  }

  // ✓ Success
  _otpStore.delete(token);
  issueSessionCookie(res);
  _loginAttempts.delete(clientIp(req));
  console.log(`[admin-auth] Successful admin login from ${clientIp(req)} (${okTotp ? 'TOTP' : 'email'})`);
  res.json({ success: true });
});

// ── POST /totp-setup ──────────────────────────────────────────────────────────
// Generates a fresh TOTP secret + otpauth:// URI for QR-code enrollment.
// Admin copies the secret into .env as ADMIN_TOTP_SECRET and restarts PM2.
// Requires a valid admin session.
router.post('/totp-setup', adminSessionAuth, (req, res) => {
  const secret = authenticator.generateSecret();
  const issuer  = 'HogaresRD';
  const account = process.env.ADMIN_USERNAME || 'admin';
  const otpauth = authenticator.keyuri(account, issuer, secret);
  res.json({
    secret,
    otpauth,
    instructions:
      'Escanea el otpauth:// URL con Google Authenticator / Authy / 1Password. ' +
      'Luego añade ADMIN_TOTP_SECRET=' + secret + ' a .env y reinicia pm2. ' +
      'A partir de entonces puedes usar el código de 6 dígitos del app en vez de esperar el correo.',
  });
});

// ── POST /logout ──────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  console.log(`[admin-auth] Admin logout from ${clientIp(req)}`);
  res.json({ success: true });
});

module.exports = { router, adminSessionAuth, adminSessionPage };
