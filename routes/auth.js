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

    transporter.sendMail({
      from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
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

    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) { next(err); }
});

// ── Register Agency ────────────────────────────────────────────────────────
router.post('/register/agency', async (req, res, next) => {
  try {
    const { name, email, password, agencyName, licenseNumber, phone } = req.body;

    if (!name || !email || !password || !agencyName || !licenseNumber || !phone)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    if (password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
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
      refToken,
      createdAt:       new Date().toISOString(),
      lastLoginAt:     null,
      role:            'agency',
      favorites:       [],
      resetToken:      null,
      resetTokenExpiry: null,
      marketingOptIn:  true,
    };

    store.saveUser(user);

    transporter.sendMail({
      from:    `"HogaresRD" <${process.env.EMAIL_USER}>`,
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
