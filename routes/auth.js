const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const store      = require('./store');

const router     = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
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
    const { name, email, password } = req.body;

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
    };

    store.saveUser(user);

    // Welcome email (fire-and-forget)
    transporter.sendMail({
      from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
      to:      user.email,
      subject: '¡Bienvenido a HogaresRD!',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #d0dcea;border-radius:12px;overflow:hidden;">
          <div style="background:#002D62;padding:28px 32px;">
            <h2 style="color:#fff;margin:0;font-size:1.4rem;">🏠 ¡Bienvenido a HogaresRD!</h2>
            <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:0.9rem;">Tu portal de bienes raíces en República Dominicana</p>
          </div>
          <div style="padding:28px 32px;background:#fff;">
            <p style="font-size:1rem;color:#1a2b40;">Hola <strong>${user.name}</strong>,</p>
            <p style="color:#4d6a8a;line-height:1.6;">Tu cuenta ha sido creada exitosamente. Ya puedes explorar propiedades, guardar tus favoritas y recibir recomendaciones personalizadas basadas en tus preferencias.</p>
            <div style="margin-top:28px;">
              <a href="${BASE_URL}/home" style="background:#002D62;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:0.95rem;">
                Explorar Propiedades →
              </a>
            </div>
            <p style="margin-top:28px;font-size:0.85rem;color:#4d6a8a;">Si no creaste esta cuenta, ignora este correo.</p>
          </div>
          <div style="padding:16px 32px;background:#f0f4f9;font-size:0.8rem;color:#4d6a8a;">
            HogaresRD · República Dominicana
          </div>
        </div>`,
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
