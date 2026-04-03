const express    = require('express');
const nodemailer = require('nodemailer');
const store      = require('./store');

const router   = express.Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(p) {
  if (!p) return 'Consultar';
  const n = Number(p);
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000)    return '$' + Math.round(n / 1000) + 'K';
  return '$' + n.toLocaleString('es-DO');
}

function typeBadge(type) {
  if (type === 'alquiler')       return { label: 'EN ALQUILER', color: '#0066cc' };
  if (type === 'venta_alquiler') return { label: 'VENTA / ALQUILER', color: '#7c3aed' };
  return { label: 'EN VENTA', color: '#1a7a4a' };
}

function listingCard(l) {
  const price    = formatPrice(l.price);
  const location = [l.sector, l.city].filter(Boolean).join(', ');
  const { label, color } = typeBadge(l.type);
  const specs = [
    l.bedrooms   ? `🛏 ${l.bedrooms} hab.`   : '',
    l.bathrooms  ? `🚿 ${l.bathrooms} baños`  : '',
    l.area_const ? `📐 ${l.area_const} m²`    : '',
  ].filter(Boolean).join('&nbsp;&nbsp;&nbsp;');

  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;border-radius:12px;overflow:hidden;border:1px solid #dce8f5;">
    <tr>
      <td style="padding:20px 22px;background:#ffffff;">
        <span style="display:inline-block;background:${color};color:#fff;font-size:0.62rem;font-weight:800;letter-spacing:1.2px;padding:3px 10px;border-radius:20px;text-transform:uppercase;margin-bottom:10px;">${label}</span>
        <div style="font-size:1.2rem;font-weight:800;color:#002D62;margin-bottom:3px;">${price}</div>
        <div style="font-size:0.92rem;font-weight:600;color:#1a2b40;line-height:1.35;margin-bottom:6px;">${l.title}</div>
        <div style="font-size:0.8rem;color:#7a9bbf;margin-bottom:${specs ? '10px' : '14px'};">📍 ${location}</div>
        ${specs ? `<div style="font-size:0.78rem;color:#4d6a8a;margin-bottom:14px;">${specs}</div>` : ''}
        <a href="${BASE_URL}/listing/${l.id}" style="display:inline-block;background:#002D62;color:#ffffff;font-size:0.82rem;font-weight:700;padding:9px 20px;border-radius:8px;text-decoration:none;">Ver propiedad →</a>
      </td>
    </tr>
  </table>`;
}

// ── Build the full newsletter HTML ───────────────────────────────────────────

function buildNewsletterHTML(user, { trending, newest, stats }) {
  const firstName  = user.name.split(' ')[0];
  const unsubToken = Buffer.from(user.id).toString('base64');
  const today      = new Date().toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' });
  const todayCap   = today.charAt(0).toUpperCase() + today.slice(1);

  const trendingCards = trending.map(listingCard).join('');
  const newestCards   = newest.map(listingCard).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>HogaresRD — Novedades de la semana</title>
</head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <!-- Pre-header -->
  <tr><td style="font-size:0;line-height:0;color:#eef3fa;">
    Propiedades en tendencia, nuevos listados y más — todo lo que necesitas saber hoy en HogaresRD.
  </td></tr>

  <!-- Card wrapper -->
  <tr><td style="background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 4px 28px rgba(0,45,98,0.10);">

    <!-- Header -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="background:linear-gradient(135deg,#002D62 0%,#1a5fa8 100%);padding:36px 40px 32px;">
        <div style="font-size:0.9rem;font-weight:800;color:rgba(255,255,255,0.6);letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;">🏠 HogaresRD</div>
        <div style="font-size:1.6rem;font-weight:800;color:#ffffff;line-height:1.25;margin-bottom:8px;">
          ¡Hola, ${firstName}! 👋<br/>Tu resumen del día está aquí.
        </div>
        <div style="font-size:0.88rem;color:rgba(255,255,255,0.7);">${todayCap}</div>
      </td></tr>
    </table>

    <!-- Intro -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:32px 40px 0px;">
        <p style="margin:0;font-size:0.97rem;color:#1a2b40;line-height:1.75;">
          Tenemos novedades frescas del mercado inmobiliario dominicano. Desde propiedades que están causando sensación hasta los listados más recientes — aquí tienes todo en un solo lugar. ☕
        </p>
      </td></tr>
    </table>

    <!-- Market Stats Strip -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:24px 40px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6ff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:16px 0;text-align:center;border-right:1px solid #dce8f5;">
              <div style="font-size:1.4rem;font-weight:800;color:#002D62;">${stats.total}</div>
              <div style="font-size:0.72rem;font-weight:600;color:#7a9bbf;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Propiedades</div>
            </td>
            <td style="padding:16px 0;text-align:center;border-right:1px solid #dce8f5;">
              <div style="font-size:1.4rem;font-weight:800;color:#1a7a4a;">${stats.forSale}</div>
              <div style="font-size:0.72rem;font-weight:600;color:#7a9bbf;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">En Venta</div>
            </td>
            <td style="padding:16px 0;text-align:center;border-right:1px solid #dce8f5;">
              <div style="font-size:1.4rem;font-weight:800;color:#0066cc;">${stats.forRent}</div>
              <div style="font-size:0.72rem;font-weight:600;color:#7a9bbf;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">En Alquiler</div>
            </td>
            <td style="padding:16px 0;text-align:center;">
              <div style="font-size:1.4rem;font-weight:800;color:#002D62;">${stats.cities}</div>
              <div style="font-size:0.72rem;font-weight:600;color:#7a9bbf;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Ciudades</div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- Trending -->
    ${trendingCards ? `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 40px 24px;">
        <div style="margin-bottom:18px;">
          <div style="font-size:0.68rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7a9bbf;margin-bottom:5px;">🔥 EN TENDENCIA</div>
          <div style="font-size:1.1rem;font-weight:800;color:#1a2b40;">Lo que todo el mundo está mirando</div>
          <div style="font-size:0.85rem;color:#7a9bbf;margin-top:3px;">Las propiedades más vistas en HogaresRD ahora mismo.</div>
        </div>
        ${trendingCards}
      </td></tr>
    </table>` : ''}

    <!-- Divider -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:0 40px;">
        <hr style="border:none;border-top:1px solid #eef3fa;margin:0;"/>
      </td></tr>
    </table>

    <!-- Newest -->
    ${newestCards ? `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:28px 40px 24px;">
        <div style="margin-bottom:18px;">
          <div style="font-size:0.68rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7a9bbf;margin-bottom:5px;">✨ RECIÉN LLEGADOS</div>
          <div style="font-size:1.1rem;font-weight:800;color:#1a2b40;">Nuevas propiedades en el mercado</div>
          <div style="font-size:0.85rem;color:#7a9bbf;margin-top:3px;">Estas acaban de entrar — sé de los primeros en verlas.</div>
        </div>
        ${newestCards}
      </td></tr>
    </table>` : ''}

    <!-- Main CTA -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 40px 36px;text-align:center;">
        <a href="${BASE_URL}/comprar" style="display:inline-block;background:#002D62;color:#ffffff;font-size:0.97rem;font-weight:700;padding:15px 44px;border-radius:10px;text-decoration:none;letter-spacing:0.2px;">
          Ver todas las propiedades →
        </a>
        <div style="margin-top:14px;">
          <a href="${BASE_URL}/ciudades" style="font-size:0.82rem;color:#4d6a8a;text-decoration:underline;">Explorar por ciudad</a>
          &nbsp;·&nbsp;
          <a href="${BASE_URL}/alquilar" style="font-size:0.82rem;color:#4d6a8a;text-decoration:underline;">Ver alquileres</a>
        </div>
      </td></tr>
    </table>

    <!-- Footer -->
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:20px 40px;background:#f5f8fd;border-top:1px solid #dce8f5;">
        <p style="margin:0;font-size:0.75rem;color:#9ab0c8;text-align:center;line-height:1.7;">
          © ${new Date().getFullYear()} HogaresRD &mdash; República Dominicana<br/>
          Estás recibiendo este correo porque te suscribiste a actualizaciones de HogaresRD.<br/>
          <a href="${BASE_URL}/unsubscribe?token=${unsubToken}" style="color:#9ab0c8;text-decoration:underline;">Cancelar suscripción</a>
          &nbsp;·&nbsp;
          <a href="${BASE_URL}/home" style="color:#9ab0c8;text-decoration:underline;">hogaresrd.com</a>
        </p>
      </td></tr>
    </table>

  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Send newsletter to all opted-in users ────────────────────────────────────

async function sendNewsletter() {
  const allListings = store.getListings();
  if (!allListings.length) return { sent: 0, skipped: 0, reason: 'no listings' };

  // Top 3 trending by views
  const trending = [...allListings]
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, 3);

  // Top 3 newest by approvedAt/submittedAt
  const newest = [...allListings]
    .sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt))
    .slice(0, 3);

  // Stats
  const stats = {
    total:   allListings.length,
    forSale: allListings.filter(l => l.type === 'venta' || l.type === 'venta_alquiler').length,
    forRent: allListings.filter(l => l.type === 'alquiler' || l.type === 'venta_alquiler').length,
    cities:  new Set(allListings.map(l => l.city).filter(Boolean)).size,
  };

  const recipients = store.getUsers().filter(u => u.marketingOptIn && u.email && u.role !== 'agency');

  let sent = 0, failed = 0;
  for (const user of recipients) {
    const html = buildNewsletterHTML(user, { trending, newest, stats });
    try {
      await transporter.sendMail({
        from:    `"HogaresRD Soporte" <${process.env.EMAIL_USER}>`,
        to:      user.email,
        subject: `🏠 Tu resumen del día — ${trending.length} propiedades en tendencia`,
        html,
      });
      sent++;
    } catch (err) {
      console.error(`Newsletter failed for ${user.email}:`, err.message);
      failed++;
    }
  }

  console.log(`[Newsletter] Sent: ${sent}, Failed: ${failed}, Total recipients: ${recipients.length}`);
  return { sent, failed, total: recipients.length };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/newsletter/send — manually trigger (protected by ADMIN_KEY)
router.post('/send', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });

  try {
    const result = await sendNewsletter();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Newsletter send error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, sendNewsletter };
