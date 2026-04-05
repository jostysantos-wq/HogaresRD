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

// TOTP settings — 30-second window, ±1 step drift tolerance.
// otplib v13: pass options on each verify call, not as a global setter.
const TOTP_OPTIONS = { window: 1 };

const router = express.Router();
const mailer = createTransport();

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

// ── Exported middleware ───────────────────────────────────────────────────────

function adminSessionAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    jwt.verify(token, process.env.ADMIN_SESSION_SECRET);
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
    jwt.verify(token, process.env.ADMIN_SESSION_SECRET);
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
  console.warn(`[admin-auth] 🔑 OTP for ${adminEmail} (IP ${ip}): ${otp}`);

  try {
    await mailer.sendMail({
      to:      adminEmail,
      subject: '🔐 HogaresRD Admin — Código de acceso',
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="100%" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">
  <tr><td style="background:linear-gradient(135deg,#002D62,#1a5fa8);padding:24px 32px;">
    <div style="font-size:1.1rem;font-weight:800;color:#fff;">Código de Acceso Admin</div>
    <div style="font-size:0.82rem;color:rgba(255,255,255,0.7);margin-top:4px;">HogaresRD — Panel de Administración</div>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    <p style="margin:0 0 20px;font-size:0.92rem;color:#1a2b40;">Ingresa este código en el portal. Expira en <strong>10 minutos</strong>.</p>
    <div style="background:#f0f6ff;border:2px solid #002D62;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;">
      <div style="font-size:2.8rem;font-weight:900;letter-spacing:10px;color:#002D62;font-family:monospace;">${otp}</div>
    </div>
    <p style="margin:0;font-size:0.78rem;color:#9ab0c8;line-height:1.6;">
      Si no solicitaste este código, alguien tiene tus credenciales. Cambia tu contraseña inmediatamente.<br/>
      IP de origen registrada: <strong>${ip}</strong>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`,
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
