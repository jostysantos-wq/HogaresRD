/**
 * email-templates.js — Shared email layout components
 *
 * Dominican Republic flag colors throughout:
 *   Navy Blue #002D62 — headers, primary buttons, text
 *   Red #CE1126 — accents, badges, highlights
 *   White — backgrounds, text on dark
 *
 * Professional, no emojis, clean typography.
 */

'use strict';

const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';

// Dominican flag + brand colors
const C = {
  navy:     '#002D62',
  navyDark: '#001A3A',
  red:      '#CE1126',
  redLight: '#fef2f2',
  green:    '#1B7A3E',
  greenLt:  '#f0fdf4',
  orange:   '#b45309',
  text:     '#1a2b40',
  muted:    '#4d6a8a',
  light:    '#7a9bbf',
  border:   '#d0dcea',
  bg:       '#eef3fa',
  surface:  '#ffffff',
  footerBg: '#f0f4f9',
};

/**
 * Wrap email content in the standard HogaresRD layout.
 */
function layout({ title, subtitle, body, headerColor, preheader }) {
  const hdrColor = headerColor || C.navy;
  const year = new Date().getFullYear();
  // Preheader: hidden text shown in email client previews (Gmail, Apple Mail, Outlook)
  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}${'&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:'Segoe UI',Arial,sans-serif;">
${preheaderHtml}
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:40px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.surface};border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,45,98,0.08);">

<!-- Red accent stripe -->
<tr><td style="background:${C.red};height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>

<!-- Header -->
<tr><td style="background:${hdrColor};padding:28px 40px;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td>
        <div style="font-size:0.78rem;font-weight:800;color:rgba(255,255,255,0.55);letter-spacing:2px;text-transform:uppercase;">HOGARES<span style="color:${C.red};">RD</span></div>
      </td>
    </tr>
  </table>
  <div style="margin-top:14px;font-size:1.35rem;font-weight:800;color:#fff;line-height:1.3;">${esc(title)}</div>
  ${subtitle ? `<div style="margin-top:6px;font-size:0.88rem;color:rgba(255,255,255,0.7);">${esc(subtitle)}</div>` : ''}
</td></tr>

<!-- Body -->
<tr><td style="padding:32px 40px;">
  ${body}
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 40px;background:${C.footerBg};border-top:1px solid ${C.border};">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="text-align:center;">
      <div style="font-size:0.72rem;color:${C.light};">&copy; ${year} HogaresRD &middot; Bienes raices en Republica Dominicana</div>
      <div style="margin-top:6px;">
        <a href="${BASE_URL}" style="font-size:0.72rem;color:${C.navy};text-decoration:none;font-weight:600;">hogaresrd.com</a>
        <span style="color:${C.border};margin:0 6px;">|</span>
        <a href="${BASE_URL}/contacto" style="font-size:0.72rem;color:${C.muted};text-decoration:none;">Contacto</a>
        <span style="color:${C.border};margin:0 6px;">|</span>
        <a href="${BASE_URL}/terminos" style="font-size:0.72rem;color:${C.muted};text-decoration:none;">Terminos</a>
      </div>
    </td></tr>
  </table>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

/** Primary CTA button — DR blue with red hover feel */
function button(label, url, color) {
  const bg = color || C.navy;
  return `<div style="text-align:center;margin:24px 0 8px;">
  <a href="${url}" style="display:inline-block;background:${bg};color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;border-bottom:3px solid ${C.red};">${label}</a>
</div>`;
}

/** Red accent button (for urgent actions) */
function buttonRed(label, url) {
  return button(label, url, C.red);
}

/** Secondary outline button */
function buttonOutline(label, url) {
  return `<div style="text-align:center;margin:12px 0;">
  <a href="${url}" style="display:inline-block;border:2px solid ${C.navy};color:${C.navy};padding:10px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.88rem;">${label}</a>
</div>`;
}

/** Paragraph text */
function p(text) {
  return `<p style="margin:0 0 14px;font-size:0.95rem;color:${C.text};line-height:1.6;">${text}</p>`;
}

/** Muted small text */
function small(text) {
  return `<p style="margin:0 0 10px;font-size:0.82rem;color:${C.muted};line-height:1.5;">${text}</p>`;
}

/** Highlighted code/number display (for verification codes, tokens) */
function codeBlock(code) {
  return `<div style="margin:20px 0;text-align:center;">
  <div style="display:inline-block;background:${C.bg};border:2px solid ${C.navy};border-radius:10px;padding:16px 36px;font-family:'Courier New',monospace;font-size:2rem;font-weight:800;color:${C.navy};letter-spacing:8px;">${code}</div>
</div>`;
}

/** Info row with label + value */
function infoRow(label, value) {
  return `<tr>
  <td style="padding:9px 0;border-bottom:1px solid ${C.bg};font-size:0.85rem;color:${C.muted};width:130px;vertical-align:top;">${label}</td>
  <td style="padding:9px 0;border-bottom:1px solid ${C.bg};font-size:0.85rem;color:${C.text};font-weight:600;">${value}</td>
</tr>`;
}

/** Info table wrapper */
function infoTable(rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">${rows}</table>`;
}

/** Feature bullet point with red dash */
function feature(text) {
  return `<tr><td style="padding:8px 0;font-size:0.88rem;color:${C.text};line-height:1.5;"><span style="color:${C.red};margin-right:10px;font-weight:800;">—</span>${text}</td></tr>`;
}

/** Feature list wrapper */
function featureList(items) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">${items.map(feature).join('')}</table>`;
}

/** Status badge */
function statusBadge(label, color) {
  const bg = color || C.navy;
  return `<span style="display:inline-block;background:${bg};color:#fff;padding:6px 18px;border-radius:20px;font-size:0.85rem;font-weight:700;letter-spacing:0.3px;">${label}</span>`;
}

/** Alert/warning box */
function alertBox(text, type) {
  const colors = {
    info:    { bg: C.bg, border: C.navy, text: C.navy },
    warning: { bg: '#fff7ed', border: C.orange, text: C.orange },
    danger:  { bg: C.redLight, border: C.red, text: C.red },
    success: { bg: C.greenLt, border: C.green, text: C.green },
  };
  const c = colors[type] || colors.info;
  return `<div style="margin:16px 0;padding:14px 18px;background:${c.bg};border-left:4px solid ${c.border};border-radius:4px;font-size:0.88rem;color:${c.text};line-height:1.5;">${text}</div>`;
}

/** Blockquote for message previews */
function quote(text) {
  return `<blockquote style="margin:14px 0;padding:14px 18px;background:${C.bg};border-left:4px solid ${C.red};border-radius:4px;font-size:0.88rem;color:${C.text};font-style:italic;line-height:1.5;">${text}</blockquote>`;
}

/** Listing card for transactional emails (match alerts, saved-search results, etc.)
 *  — hero image with price overlay, spec pills, red CTA. Uses VML fallback so the
 *  image+overlay combo renders in Outlook 2007+.
 */
function listingCard(listing) {
  const priceNum = Number(listing.price);
  const formatted = !listing.price ? 'Consultar'
    : priceNum >= 1_000_000 ? '$' + (priceNum / 1_000_000).toFixed(priceNum % 1_000_000 === 0 ? 0 : 1) + 'M'
    : priceNum >= 1_000     ? '$' + Math.round(priceNum / 1_000) + 'K'
    : '$' + priceNum.toLocaleString('en-US');
  const price = formatted + (listing.type === 'alquiler' ? '/mes' : '');

  let img = null;
  if (Array.isArray(listing.images) && listing.images.length > 0) {
    img = typeof listing.images[0] === 'object' ? (listing.images[0].url || null) : listing.images[0];
  }
  if (!img) img = listing.image || listing.cover || null;
  const imgUrl = img ? (img.startsWith('http') ? img : `${BASE_URL}${img}`) : '';

  const typeInfo = listing.type === 'alquiler'
    ? { label: 'EN ALQUILER', color: '#0066cc' }
    : listing.type === 'venta_alquiler'
    ? { label: 'VENTA / ALQUILER', color: '#7c3aed' }
    : { label: 'EN VENTA', color: C.green };

  const url = `${BASE_URL}/listing/${listing.id}`;
  const location = [listing.sector, listing.city, listing.province].filter(Boolean).join(', ');

  const specs = [];
  if (listing.bedrooms)   specs.push(`🛏 ${listing.bedrooms} hab.`);
  if (listing.bathrooms)  specs.push(`🚿 ${listing.bathrooms} baños`);
  if (listing.area_const) specs.push(`📐 ${listing.area_const} m²`);
  const specRow = specs.length
    ? `<div style="margin-top:10px;font-size:12px;color:${C.muted};font-family:Arial,sans-serif;">${specs.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>`
    : '';

  const heroCell = imgUrl
    ? `<a href="${url}" style="text-decoration:none;display:block;">
         <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
           <tr>
             <td background="${imgUrl}" bgcolor="#0a1829" valign="bottom"
                 style="background:url('${imgUrl}') center/cover no-repeat;background-color:#0a1829;height:180px;border-radius:8px 8px 0 0;padding:14px;">
               <!--[if gte mso 9]>
               <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="mso-width-percent:1000;height:180px;">
                 <v:fill type="frame" src="${imgUrl}" color="#0a1829" />
                 <v:textbox inset="0,0,0,0">
               <![endif]-->
               <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                 <tr><td align="left" valign="top" style="padding-bottom:90px;">
                   <span style="display:inline-block;background:${typeInfo.color};color:#ffffff;font-size:10px;font-weight:800;letter-spacing:1px;padding:5px 11px;border-radius:20px;text-transform:uppercase;font-family:Arial,sans-serif;">${typeInfo.label}</span>
                 </td></tr>
                 <tr><td align="left" valign="bottom">
                   <div style="display:inline-block;background:rgba(0,0,0,0.72);padding:9px 14px;border-radius:8px;">
                     <div style="font-size:20px;font-weight:800;color:#ffffff;font-family:Arial,sans-serif;line-height:1;">${price}</div>
                   </div>
                 </td></tr>
               </table>
               <!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
             </td>
           </tr>
         </table>
       </a>`
    : `<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
         <tr><td bgcolor="${C.navy}" style="background:${C.navy};height:110px;border-radius:8px 8px 0 0;padding:24px;text-align:center;">
           <div style="display:inline-block;background:${typeInfo.color};color:#ffffff;font-size:10px;font-weight:800;letter-spacing:1px;padding:5px 11px;border-radius:20px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:8px;">${typeInfo.label}</div>
           <div style="font-size:22px;font-weight:800;color:#ffffff;font-family:Arial,sans-serif;">${price}</div>
         </td></tr>
       </table>`;

  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;border:1px solid ${C.border};border-radius:10px;overflow:hidden;background:#ffffff;">
  <tr><td style="padding:0;">${heroCell}</td></tr>
  <tr><td style="padding:14px 16px 16px;background:#ffffff;">
    <div style="font-size:15px;font-weight:800;color:${C.navy};margin-bottom:4px;line-height:1.3;font-family:Arial,sans-serif;">${esc(listing.title)}</div>
    <div style="font-size:12px;color:${C.muted};font-family:Arial,sans-serif;"><span style="color:${C.red};">📍</span> ${esc(location || 'República Dominicana')}</div>
    ${specRow}
    <div style="margin-top:14px;">
      <a href="${url}" style="display:inline-block;background:${C.navy};color:#ffffff;font-size:12px;font-weight:700;padding:9px 18px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;border-bottom:2px solid ${C.red};">Ver propiedad →</a>
    </div>
  </td></tr>
</table>`;
}

/** Divider line with red center accent */
function divider() {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
  <tr>
    <td style="border-top:1px solid ${C.border};"></td>
    <td style="width:40px;text-align:center;"><div style="width:20px;height:3px;background:${C.red};border-radius:2px;margin:0 auto;"></div></td>
    <td style="border-top:1px solid ${C.border};"></td>
  </tr>
</table>`;
}

/** HTML-escape */
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Standalone preheader for emails not using layout() */
function preheader(text) {
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(text)}${'&zwnj;&nbsp;'.repeat(30)}</div>`;
}

/** Standard footer with address for CAN-SPAM compliance */
function footer() {
  return `<p style="margin:0;font-size:0.72rem;color:#7a9bbf;text-align:center;line-height:1.7;">
    © ${new Date().getFullYear()} HogaresRD — Plataforma informativa de bienes raíces<br/>
    HogaresRD · Santo Domingo, República Dominicana<br/>
    <a href="${BASE_URL}/privacidad" style="color:#7a9bbf;">Privacidad</a> · <a href="${BASE_URL}/terminos" style="color:#7a9bbf;">Términos</a>
  </p>`;
}

module.exports = {
  layout, button, buttonRed, buttonOutline, p, small, codeBlock,
  infoRow, infoTable, feature, featureList,
  statusBadge, alertBox, quote, listingCard, divider, esc,
  preheader, footer,
  C, BASE_URL,
};
