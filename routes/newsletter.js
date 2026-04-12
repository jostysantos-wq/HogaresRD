const express    = require('express');
const crypto     = require('crypto');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store      = require('./store');

const router   = express.Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const UNSUB_SECRET = process.env.JWT_SECRET || 'hogaresrd-unsub';

function makeUnsubToken(userId) {
  const sig = crypto.createHmac('sha256', UNSUB_SECRET).update(userId).digest('hex').slice(0, 16);
  return Buffer.from(userId).toString('base64url') + '.' + sig;
}
function verifyUnsubToken(token) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const userId = Buffer.from(parts[0], 'base64url').toString();
  const expected = crypto.createHmac('sha256', UNSUB_SECRET).update(userId).digest('hex').slice(0, 16);
  return crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected)) ? userId : null;
}

const { createTransport } = require('./mailer');
const transporter = createTransport();

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPrice(p, type) {
  if (!p) return 'Consultar';
  const n = Number(p);
  let formatted;
  if (n >= 1_000_000) formatted = '$' + (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  else if (n >= 1000) formatted = '$' + Math.round(n / 1000) + 'K';
  else                 formatted = '$' + n.toLocaleString('es-DO');
  if (type === 'alquiler') formatted += '/mes';
  return formatted;
}

function typeBadge(type) {
  if (type === 'alquiler')       return { label: 'EN ALQUILER',     color: '#0066cc' };
  if (type === 'venta_alquiler') return { label: 'VENTA / ALQUILER', color: '#7c3aed' };
  return { label: 'EN VENTA', color: '#1a7a4a' };
}

/// Resolve a listing's primary photo to an absolute URL so mail clients
/// (Gmail, Outlook, Apple Mail) can actually fetch and display it.
function heroImageUrl(l) {
  let img = null;
  if (Array.isArray(l.images) && l.images.length > 0) {
    img = l.images[0];
    // Images may be stored as strings or objects like { url, label }
    if (typeof img === 'object') img = img.url || img.src || null;
  }
  if (!img) img = l.image || l.cover || null;
  if (!img) return null;
  return img.startsWith('http') ? img : `${BASE_URL}${img}`;
}

// ── Brand palette ───────────────────────────────────────────────────────────
const C = {
  navy:     '#002D62',
  navyDark: '#001A3A',
  navy2:    '#1a5fa8',
  red:      '#CE1126',
  green:    '#1a7a4a',
  blue:     '#0066cc',
  text:     '#1a2b40',
  muted:    '#4d6a8a',
  light:    '#7a9bbf',
  border:   '#dce8f5',
  bg:       '#eef3fa',
  surface:  '#ffffff',
  surface2: '#f5f8fd',
  // dark mode
  dText:    '#e8eef5',
  dMuted:   '#9ab0c8',
  dSurface: '#12253f',
  dSurface2:'#0a1829',
  dBorder:  '#1e3553',
};

// ── Listing card with hero image + price overlay ────────────────────────────
//
// Magazine style: full-width photo with dark gradient, price and badge
// overlaid at the bottom. Below the photo sits the title, location and
// a row of spec pills (beds / baths / area / parking) plus a red CTA.
function listingCard(l) {
  const price          = formatPrice(l.price, l.type);
  const { label, color } = typeBadge(l.type);
  const title          = esc(l.title || '');
  const location       = esc([l.sector, l.city, l.province].filter(Boolean).join(', '));
  const img            = heroImageUrl(l);
  const url            = `${BASE_URL}/listing/${l.id}`;

  // Placeholder if the listing has no photo — still renders cleanly
  const heroCell = img
    ? `<a href="${url}" style="text-decoration:none;display:block;">
         <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
           <tr>
             <td background="${img}" bgcolor="#0a1829" valign="bottom"
                 style="background:url('${img}') center/cover no-repeat;
                        background-color:#0a1829;height:220px;border-radius:14px 14px 0 0;padding:16px;">
               <!--[if gte mso 9]>
               <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false"
                       style="mso-width-percent:1000;height:220px;">
                 <v:fill type="frame" src="${img}" color="#0a1829" />
                 <v:textbox inset="0,0,0,0">
               <![endif]-->
               <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                 <tr>
                   <td align="left" valign="top" style="padding:0 0 120px 0;">
                     <span style="display:inline-block;background:${color};color:#ffffff;font-size:10px;font-weight:800;letter-spacing:1.2px;padding:6px 12px;border-radius:20px;text-transform:uppercase;font-family:Arial,sans-serif;">${label}</span>
                   </td>
                 </tr>
                 <tr>
                   <td align="left" valign="bottom">
                     <div style="display:inline-block;background:rgba(0,0,0,0.72);padding:10px 16px;border-radius:10px;backdrop-filter:blur(4px);">
                       <div style="font-size:22px;font-weight:800;color:#ffffff;font-family:Arial,sans-serif;line-height:1;">${price}</div>
                     </div>
                   </td>
                 </tr>
               </table>
               <!--[if gte mso 9]>
                 </v:textbox>
               </v:rect>
               <![endif]-->
             </td>
           </tr>
         </table>
       </a>`
    : `<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
         <tr>
           <td bgcolor="${C.navy}" style="background:${C.navy};height:140px;border-radius:14px 14px 0 0;padding:32px;text-align:center;vertical-align:middle;">
             <div style="display:inline-block;background:${color};color:#ffffff;font-size:10px;font-weight:800;letter-spacing:1.2px;padding:6px 12px;border-radius:20px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:10px;">${label}</div>
             <div style="font-size:26px;font-weight:800;color:#ffffff;font-family:Arial,sans-serif;">${price}</div>
           </td>
         </tr>
       </table>`;

  // Spec pills — shown as a responsive row of chips.
  const specs = [];
  if (l.bedrooms)   specs.push({ icon: '🛏', label: `${l.bedrooms} hab.` });
  if (l.bathrooms)  specs.push({ icon: '🚿', label: `${l.bathrooms} baños` });
  if (l.area_const) specs.push({ icon: '📐', label: `${l.area_const} m²` });
  if (l.parking)    specs.push({ icon: '🚗', label: `${l.parking} parqueo` });

  const specRow = specs.length
    ? `<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-top:14px;">
         <tr>${specs.map(s =>
           `<td style="padding-right:8px;">
              <table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
                <tr><td style="background:${C.bg};border-radius:100px;padding:7px 12px;font-size:12px;font-weight:700;color:${C.navy};font-family:Arial,sans-serif;white-space:nowrap;" class="spec-pill">
                  <span style="margin-right:4px;">${s.icon}</span>${s.label}
                </td></tr>
              </table>
            </td>`
         ).join('')}</tr>
       </table>`
    : '';

  return `
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" class="listing-card"
         style="margin:0 0 20px 0;border-collapse:separate;border-radius:14px;overflow:hidden;
                background:${C.surface};border:1px solid ${C.border};
                box-shadow:0 2px 12px rgba(0,45,98,0.06);">
    <tr><td style="padding:0;">
      ${heroCell}
    </td></tr>
    <tr><td class="card-body" style="padding:20px 22px 22px;background:${C.surface};">
      <div class="card-title" style="font-size:17px;font-weight:800;color:${C.navy};line-height:1.3;margin:0 0 6px;font-family:Arial,sans-serif;">${title}</div>
      <div class="card-location" style="font-size:13px;color:${C.muted};font-family:Arial,sans-serif;">
        <span style="color:${C.red};margin-right:4px;">📍</span>${location || 'República Dominicana'}
      </div>
      ${specRow}
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;">
        <tr>
          <td>
            <a href="${url}"
               style="display:inline-block;background:${C.navy};color:#ffffff;font-size:13px;font-weight:700;
                      padding:11px 22px;border-radius:8px;text-decoration:none;font-family:Arial,sans-serif;
                      border-bottom:3px solid ${C.red};">
              Ver propiedad →
            </a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}

// ── Build the full newsletter HTML ───────────────────────────────────────────

function buildNewsletterHTML(user, { trending, newest, stats }) {
  const firstName  = (user.name || 'amigo').split(' ')[0];
  const unsubToken = makeUnsubToken(user.id);
  const today      = new Date().toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' });
  const todayCap   = today.charAt(0).toUpperCase() + today.slice(1);

  const trendingCards = trending.map(listingCard).join('');
  const newestCards   = newest.map(listingCard).join('');

  // Optional hero image: reuse the first trending listing's cover as the
  // big banner image at the top of the email. Falls back to brand gradient.
  const heroListing = trending[0] || newest[0] || null;
  const heroImg     = heroListing ? heroImageUrl(heroListing) : null;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light dark"/>
  <meta name="supported-color-schemes" content="light dark"/>
  <title>HogaresRD — Novedades del día</title>
  <style>
    /* ── Base ─────────────────────────────────── */
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; border-collapse:collapse !important; }
    img { -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    body { margin:0 !important; padding:0 !important; width:100% !important; }

    /* ── Mobile ───────────────────────────────── */
    @media screen and (max-width:620px) {
      .email-wrap     { width:100% !important; padding:0 !important; }
      .email-card     { border-radius:0 !important; }
      .email-padded   { padding-left:22px !important; padding-right:22px !important; }
      .hero-title     { font-size:24px !important; line-height:1.25 !important; }
      .hero-sub       { font-size:14px !important; }
      .section-title  { font-size:18px !important; }
      .card-title     { font-size:16px !important; }
      .stats-cell     { padding:12px 4px !important; }
      .stats-num      { font-size:20px !important; }
      .hero-banner    { height:160px !important; }
    }

    /* ── Dark mode ────────────────────────────── */
    @media (prefers-color-scheme: dark) {
      body, .email-bg  { background:#0a1829 !important; }
      .email-card      { background:#12253f !important; border-color:#1e3553 !important; }
      .card-body       { background:#12253f !important; }
      .card-title      { color:#ffffff !important; }
      .card-location,
      .card-muted,
      .hero-sub-muted  { color:#9ab0c8 !important; }
      .intro-text      { color:#c9d6e6 !important; }
      .section-eyebrow { color:#9ab0c8 !important; }
      .section-title   { color:#ffffff !important; }
      .listing-card    { background:#12253f !important; border-color:#1e3553 !important; }
      .stats-box       { background:#0a1829 !important; }
      .stats-label     { color:#9ab0c8 !important; }
      .spec-pill       { background:#1e3553 !important; color:#c9d6e6 !important; }
      .footer-bg       { background:#0a1829 !important; border-color:#1e3553 !important; }
      .footer-text,
      .footer-link     { color:#9ab0c8 !important; }
      .divider-line    { border-color:#1e3553 !important; }
    }
    [data-ogsc] body, [data-ogsc] .email-bg      { background:#0a1829 !important; }
    [data-ogsc] .email-card, [data-ogsc] .card-body, [data-ogsc] .listing-card { background:#12253f !important; border-color:#1e3553 !important; }
    [data-ogsc] .card-title, [data-ogsc] .section-title { color:#ffffff !important; }
    [data-ogsc] .card-location, [data-ogsc] .intro-text, [data-ogsc] .stats-label, [data-ogsc] .footer-text { color:#9ab0c8 !important; }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

<!-- Pre-header (hidden) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">
  Hola ${esc(firstName)} — ${stats.total} propiedades, ${trending.length} en tendencia y los últimos listados del mercado dominicano.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-bg"
       style="background:${C.bg};padding:32px 16px;">
<tr><td align="center">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="email-wrap"
         style="width:600px;max-width:600px;">

    <!-- ═══ CARD ═══ -->
    <tr><td class="email-card"
            style="background:${C.surface};border-radius:20px;overflow:hidden;
                   box-shadow:0 8px 40px rgba(0,45,98,0.12);">

      <!-- ── HERO ─────────────────────────────────────────── -->
      ${heroImg ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td background="${heroImg}" bgcolor="${C.navyDark}"
              class="hero-banner"
              style="background:url('${heroImg}') center/cover no-repeat;
                     background-color:${C.navyDark};height:240px;padding:0;">
            <!--[if gte mso 9]>
            <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false"
                    style="mso-width-percent:1000;height:240px;">
              <v:fill type="frame" src="${heroImg}" color="${C.navyDark}" />
              <v:textbox inset="0,0,0,0">
            <![endif]-->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:240px;">
              <tr>
                <td align="left" valign="bottom"
                    style="background:linear-gradient(180deg,rgba(0,26,58,0.35) 0%,rgba(0,26,58,0.92) 100%);
                           padding:40px 40px 32px;">
                  <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,0.75);letter-spacing:2.5px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">
                    🏠 HOGARES<span style="color:${C.red};">RD</span>
                  </div>
                  <div class="hero-title" style="font-size:28px;font-weight:800;color:#ffffff;line-height:1.22;margin-bottom:8px;font-family:Arial,sans-serif;">
                    Hola ${esc(firstName)} 👋
                  </div>
                  <div class="hero-sub" style="font-size:15px;color:rgba(255,255,255,0.85);line-height:1.5;font-family:Arial,sans-serif;">
                    Tu resumen inmobiliario — ${todayCap}
                  </div>
                </td>
              </tr>
            </table>
            <!--[if gte mso 9]>
              </v:textbox>
            </v:rect>
            <![endif]-->
          </td>
        </tr>
      </table>
      ` : `
      <!-- Fallback hero (no image available) -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td bgcolor="${C.navy}"
                style="background:${C.navy};background-image:linear-gradient(135deg,${C.navy} 0%,${C.navy2} 100%);padding:44px 40px 38px;">
          <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,0.55);letter-spacing:2.5px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">
            🏠 HOGARES<span style="color:${C.red};">RD</span>
          </div>
          <div class="hero-title" style="font-size:28px;font-weight:800;color:#ffffff;line-height:1.22;margin-bottom:8px;font-family:Arial,sans-serif;">
            Hola ${esc(firstName)} 👋
          </div>
          <div class="hero-sub" style="font-size:15px;color:rgba(255,255,255,0.75);line-height:1.5;font-family:Arial,sans-serif;">
            Tu resumen inmobiliario — ${todayCap}
          </div>
        </td></tr>
      </table>
      `}

      <!-- Red accent stripe -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:${C.red};height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>

      <!-- ── INTRO ────────────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="email-padded" style="padding:32px 40px 8px;">
          <p class="intro-text" style="margin:0;font-size:15px;color:${C.text};line-height:1.7;font-family:Arial,sans-serif;">
            Tenemos novedades frescas del mercado inmobiliario dominicano. Desde propiedades que están causando sensación hasta los listados más recientes — aquí tienes todo en un solo lugar. ☕
          </p>
        </td></tr>
      </table>

      <!-- ── STATS STRIP ──────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="email-padded" style="padding:24px 40px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="stats-box"
                 style="background:${C.surface2};border-radius:14px;border:1px solid ${C.border};">
            <tr>
              <td class="stats-cell" style="padding:18px 4px;text-align:center;border-right:1px solid ${C.border};">
                <div class="stats-num" style="font-size:22px;font-weight:800;color:${C.navy};font-family:Arial,sans-serif;">${stats.total}</div>
                <div class="stats-label" style="font-size:10px;font-weight:700;color:${C.light};text-transform:uppercase;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">Propiedades</div>
              </td>
              <td class="stats-cell" style="padding:18px 4px;text-align:center;border-right:1px solid ${C.border};">
                <div class="stats-num" style="font-size:22px;font-weight:800;color:${C.green};font-family:Arial,sans-serif;">${stats.forSale}</div>
                <div class="stats-label" style="font-size:10px;font-weight:700;color:${C.light};text-transform:uppercase;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">En Venta</div>
              </td>
              <td class="stats-cell" style="padding:18px 4px;text-align:center;border-right:1px solid ${C.border};">
                <div class="stats-num" style="font-size:22px;font-weight:800;color:${C.blue};font-family:Arial,sans-serif;">${stats.forRent}</div>
                <div class="stats-label" style="font-size:10px;font-weight:700;color:${C.light};text-transform:uppercase;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">En Alquiler</div>
              </td>
              <td class="stats-cell" style="padding:18px 4px;text-align:center;">
                <div class="stats-num" style="font-size:22px;font-weight:800;color:${C.red};font-family:Arial,sans-serif;">${stats.cities}</div>
                <div class="stats-label" style="font-size:10px;font-weight:700;color:${C.light};text-transform:uppercase;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">Ciudades</div>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>

      <!-- ── TRENDING ─────────────────────────────────────── -->
      ${trendingCards ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="email-padded" style="padding:24px 40px 8px;">
          <div class="section-eyebrow" style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.red};margin-bottom:6px;font-family:Arial,sans-serif;">🔥 EN TENDENCIA</div>
          <div class="section-title" style="font-size:20px;font-weight:800;color:${C.text};line-height:1.25;margin-bottom:4px;font-family:Arial,sans-serif;">Lo que todo el mundo está mirando</div>
          <div class="card-muted" style="font-size:13px;color:${C.light};margin-bottom:20px;font-family:Arial,sans-serif;">Las propiedades más vistas en HogaresRD esta semana.</div>
          ${trendingCards}
        </td></tr>
      </table>` : ''}

      <!-- ── DIVIDER ──────────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="email-padded" style="padding:4px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td class="divider-line" style="border-top:1px solid ${C.border};"></td>
              <td style="width:40px;text-align:center;padding:0 8px;">
                <div style="width:20px;height:3px;background:${C.red};border-radius:2px;margin:0 auto;"></div>
              </td>
              <td class="divider-line" style="border-top:1px solid ${C.border};"></td>
            </tr>
          </table>
        </td></tr>
      </table>

      <!-- ── NEWEST ───────────────────────────────────────── -->
      ${newestCards ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="email-padded" style="padding:24px 40px 8px;">
          <div class="section-eyebrow" style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.green};margin-bottom:6px;font-family:Arial,sans-serif;">✨ RECIÉN LLEGADOS</div>
          <div class="section-title" style="font-size:20px;font-weight:800;color:${C.text};line-height:1.25;margin-bottom:4px;font-family:Arial,sans-serif;">Nuevas propiedades en el mercado</div>
          <div class="card-muted" style="font-size:13px;color:${C.light};margin-bottom:20px;font-family:Arial,sans-serif;">Estas acaban de entrar — sé de los primeros en verlas.</div>
          ${newestCards}
        </td></tr>
      </table>` : ''}

      <!-- ── MAIN CTA ─────────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="email-padded" style="padding:12px 40px 36px;text-align:center;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td>
              <a href="${BASE_URL}/comprar"
                 style="display:inline-block;background:${C.navy};color:#ffffff;font-size:15px;font-weight:700;
                        padding:16px 42px;border-radius:10px;text-decoration:none;letter-spacing:0.3px;
                        font-family:Arial,sans-serif;border-bottom:4px solid ${C.red};">
                Ver todas las propiedades →
              </a>
            </td></tr>
          </table>
          <div style="margin-top:16px;font-family:Arial,sans-serif;">
            <a href="${BASE_URL}/comprar" class="footer-link" style="font-size:13px;color:${C.muted};text-decoration:none;font-weight:600;">🏘 Comprar</a>
            <span style="color:${C.border};margin:0 10px;">·</span>
            <a href="${BASE_URL}/alquilar" class="footer-link" style="font-size:13px;color:${C.muted};text-decoration:none;font-weight:600;">🏠 Alquilar</a>
            <span style="color:${C.border};margin:0 10px;">·</span>
            <a href="${BASE_URL}/proyectos" class="footer-link" style="font-size:13px;color:${C.muted};text-decoration:none;font-weight:600;">🏗 Proyectos</a>
          </div>
        </td></tr>
      </table>

      <!-- ── FOOTER ───────────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td class="footer-bg email-padded"
                style="padding:24px 40px;background:${C.surface2};border-top:1px solid ${C.border};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="text-align:center;">
              <div class="footer-text" style="font-size:13px;font-weight:800;color:${C.navy};margin-bottom:6px;font-family:Arial,sans-serif;">
                HOGARES<span style="color:${C.red};">RD</span>
              </div>
              <div class="footer-text" style="font-size:11px;color:${C.light};line-height:1.65;font-family:Arial,sans-serif;">
                © ${new Date().getFullYear()} HogaresRD — Plataforma informativa de bienes raíces<br/>
                Recibes este correo porque te suscribiste a actualizaciones de HogaresRD.<br/>
                HogaresRD · Santo Domingo, República Dominicana
              </div>
              <div style="margin-top:12px;font-family:Arial,sans-serif;">
                <a href="${BASE_URL}/home" class="footer-link" style="font-size:11px;color:${C.muted};text-decoration:none;">hogaresrd.com</a>
                <span style="color:${C.border};margin:0 8px;">|</span>
                <a href="${BASE_URL}/unsubscribe?token=${unsubToken}" class="footer-link" style="font-size:11px;color:${C.muted};text-decoration:underline;">Cancelar suscripción</a>
              </div>
            </td></tr>
          </table>
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
    const unsubUrl = `${BASE_URL}/unsubscribe?token=${makeUnsubToken(user.id)}`;
    try {
      await transporter.sendMail({
        department: 'noreply',
        to:      user.email,
        subject: `🏠 Tu resumen del día — ${trending.length} propiedades en tendencia`,
        html,
        headers: {
          'List-Unsubscribe': `<mailto:unsubscribe@hogaresrd.com?subject=unsubscribe-${user.id}>, <${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
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

const { adminSessionAuth } = require('./admin-auth');

// POST /api/newsletter/send — manually trigger (admin session required)
router.post('/send', adminSessionAuth, async (req, res) => {
  try {
    const result = await sendNewsletter();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Newsletter send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/newsletter/preview — admin-only HTML preview so you can tweak the
// design without actually sending emails. Uses the current listings cache.
router.get('/preview', adminSessionAuth, (req, res) => {
  const allListings = store.getListings();
  const trending = [...allListings].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  const newest   = [...allListings].sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt)).slice(0, 3);
  const stats = {
    total:   allListings.length,
    forSale: allListings.filter(l => l.type === 'venta' || l.type === 'venta_alquiler').length,
    forRent: allListings.filter(l => l.type === 'alquiler' || l.type === 'venta_alquiler').length,
    cities:  new Set(allListings.map(l => l.city).filter(Boolean)).size,
  };
  const fakeUser = { id: 'preview', name: 'Vista Previa', email: 'preview@hogaresrd.com' };
  const html = buildNewsletterHTML(fakeUser, { trending, newest, stats });
  res.type('html').send(html);
});

// POST /api/newsletter/subscribe — public subscribe by email
const rateLimit = require('express-rate-limit');
const subLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Demasiadas solicitudes.' } });

router.post('/subscribe', subLimiter, (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email válido requerido' });

  const user = store.getUserByEmail(email.trim().toLowerCase());
  if (user) {
    if (user.marketingOptIn) return res.json({ success: true, message: 'Ya estás suscrito.' });
    user.marketingOptIn = true;
    store.saveUser(user);
    return res.json({ success: true, message: '¡Te has suscrito exitosamente!' });
  }
  // Non-registered email — for now just acknowledge (they'd need to register to get newsletters)
  res.json({ success: true, message: '¡Gracias! Crea una cuenta para recibir nuestro boletín.' });
});

// POST /api/newsletter/unsubscribe — one-click unsubscribe (RFC 8058)
router.post('/unsubscribe', (req, res) => {
  const token = req.body.token || req.query.token;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  const userId = verifyUnsubToken(token);
  if (!userId) return res.status(400).json({ error: 'Token inválido' });
  const user = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  user.marketingOptIn = false;
  store.saveUser(user);

  // Log for compliance (CAN-SPAM requires honoring within 10 business days)
  store.appendPrivacyLog({
    id:           'priv_' + require('crypto').randomBytes(8).toString('hex'),
    user_id:      user.id,
    user_email:   user.email,
    request_type: 'email_unsubscribe',
    status:       'completed',
    source:       'one_click',
    details:      { method: 'RFC8058_one_click' },
    created_at:   new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });

  console.log(`[newsletter] Unsubscribed: ${user.email} (one-click)`);
  res.json({ success: true });
});

module.exports = { router, sendNewsletter, verifyUnsubToken, makeUnsubToken };
