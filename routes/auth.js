const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const store      = require('./store');

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'hogaresrd-jwt-fallback-change-me';
const BASE_URL   = process.env.BASE_URL || 'http://localhost:3000';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function safeUser(user) {
  const { passwordHash, resetToken, resetTokenExpiry, ...safe } = user;
  return safe;
}

// ── Auth middleware (exported for other routes) ────────────────────────────
function userAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No autenticado' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ── Register ───────────────────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, marketingOptIn } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
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

    store.saveUser(user);

    // Welcome email (fire-and-forget)
    transporter.sendMail({
      from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
      to:      user.email,
      subject: '¡Bienvenido a HogaresRD! Tu cuenta está lista 🏠',
      html: `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#002D62 0%,#004aaa 100%);padding:36px 40px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-size:1.1rem;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">🏠 HogaresRD</div>
                <div style="margin-top:20px;">
                  <div style="font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.2;">¡Bienvenido, ${user.name.split(' ')[0]}!</div>
                  <div style="margin-top:6px;font-size:0.95rem;color:rgba(255,255,255,0.75);">Tu cuenta está lista para usar</div>
                </div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:36px 40px;">
          <p style="margin:0 0 16px;font-size:1rem;color:#1a2b40;line-height:1.6;">
            Gracias por unirte a <strong>HogaresRD</strong>, el portal de bienes raíces de la República Dominicana.
            Tu cuenta ya está activa y puedes empezar a explorar de inmediato.
          </p>

          <!-- Feature list -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
            <tr><td style="padding:10px 0;border-bottom:1px solid #eef3fa;">
              <span style="color:#002D62;font-size:1rem;margin-right:10px;">🔍</span>
              <span style="color:#4d6a8a;font-size:0.92rem;">Busca entre miles de propiedades en venta y alquiler</span>
            </td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid #eef3fa;">
              <span style="color:#002D62;font-size:1rem;margin-right:10px;">❤️</span>
              <span style="color:#4d6a8a;font-size:0.92rem;">Guarda tus propiedades favoritas y compáralas</span>
            </td></tr>
            <tr><td style="padding:10px 0;">
              <span style="color:#002D62;font-size:1rem;margin-right:10px;">✨</span>
              <span style="color:#4d6a8a;font-size:0.92rem;">Recibe recomendaciones personalizadas según tus preferencias</span>
            </td></tr>
          </table>

          <!-- CTA -->
          <div style="margin-top:32px;text-align:center;">
            <a href="${BASE_URL}/home" style="display:inline-block;background:#002D62;color:#ffffff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:0.97rem;letter-spacing:0.2px;">
              Explorar Propiedades →
            </a>
          </div>

          <p style="margin-top:32px;font-size:0.82rem;color:#7a9bbf;line-height:1.5;">
            Si no creaste esta cuenta, puedes ignorar este correo con seguridad.
            ${user.marketingOptIn ? 'Recibirás ocasionalmente ofertas y novedades de HogaresRD. Puedes cancelar en cualquier momento respondiendo a este correo.' : ''}
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 40px;background:#f0f4f9;border-top:1px solid #d0dcea;">
          <p style="margin:0;font-size:0.78rem;color:#7a9bbf;text-align:center;">
            © ${new Date().getFullYear()} HogaresRD &mdash; República Dominicana<br/>
            <a href="${BASE_URL}/home" style="color:#7a9bbf;text-decoration:underline;">hogaresrd.com</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`,
    }).catch(err => console.error('Welcome email error:', err.message));

    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Login ──────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Correo y contraseña requeridos' });

    const user = store.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });

    user.lastLoginAt = new Date().toISOString();
    store.saveUser(user);

    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Me ─────────────────────────────────────────────────────────────────────
router.get('/me', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(safeUser(user));
});

// ── Forgot password ────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  // Always 200 — never reveal whether the email exists
  res.json({ success: true, message: 'Si ese correo está registrado, recibirás un enlace para restablecer tu contraseña.' });

  const user = store.getUserByEmail(email);
  if (!user) return;

  const token = crypto.randomBytes(32).toString('hex');
  user.resetToken       = token;
  user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  store.saveUser(user);

  transporter.sendMail({
    from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
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
            <a href="${BASE_URL}/reset-password?token=${token}" style="background:#002D62;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
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
    if (password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    const users = store.getUsers();
    const user  = users.find(u => u.resetToken === token);
    if (!user)
      return res.status(400).json({ error: 'Enlace inválido o ya utilizado' });
    if (new Date(user.resetTokenExpiry) < new Date())
      return res.status(400).json({ error: 'El enlace ha expirado. Solicita uno nuevo.' });

    user.passwordHash     = await bcrypt.hash(password, 10);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    store.saveUser(user);

    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) { next(err); }
});

module.exports        = router;
module.exports.userAuth = userAuth;
