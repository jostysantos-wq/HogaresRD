/**
 * email-templates.js — Shared email layout components
 *
 * All emails use a consistent professional template:
 *   - 560px max-width, table-based for email client compatibility
 *   - Navy header (#002D62), white body, light gray footer
 *   - No emojis, clean typography
 *   - Dominican flag colors: navy blue + red accent
 */

'use strict';

const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';

// Brand colors
const C = {
  navy:     '#002D62',
  navyDark: '#001A3A',
  blue:     '#0a4d8f',
  red:      '#CE1126',
  green:    '#16a34a',
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
 *
 * @param {object} opts
 * @param {string} opts.title     — Header title text
 * @param {string} opts.subtitle  — Optional subtitle below title
 * @param {string} opts.body      — HTML content for the body section
 * @param {string} [opts.headerColor] — Header background (default: navy)
 * @param {string} [opts.year]    — Copyright year
 */
function layout({ title, subtitle, body, headerColor }) {
  const hdrColor = headerColor || C.navy;
  const year = new Date().getFullYear();

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:40px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.surface};border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,45,98,0.08);">

<!-- Header -->
<tr><td style="background:${hdrColor};padding:32px 40px;">
  <div style="font-size:0.85rem;font-weight:700;color:rgba(255,255,255,0.7);letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">HogaresRD</div>
  <div style="font-size:1.35rem;font-weight:800;color:#fff;line-height:1.3;">${title}</div>
  ${subtitle ? `<div style="margin-top:6px;font-size:0.88rem;color:rgba(255,255,255,0.7);">${subtitle}</div>` : ''}
</td></tr>

<!-- Body -->
<tr><td style="padding:32px 40px;">
  ${body}
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 40px;background:${C.footerBg};border-top:1px solid ${C.border};">
  <p style="margin:0;font-size:0.72rem;color:${C.light};text-align:center;">
    &copy; ${year} HogaresRD &middot; Bienes raices en Republica Dominicana
  </p>
  <p style="margin:4px 0 0;font-size:0.68rem;color:${C.light};text-align:center;">
    <a href="${BASE_URL}" style="color:${C.light};text-decoration:none;">hogaresrd.com</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

/** Primary CTA button */
function button(label, url, color) {
  const bg = color || C.navy;
  return `<div style="text-align:center;margin:24px 0 8px;">
  <a href="${url}" style="display:inline-block;background:${bg};color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;">${label}</a>
</div>`;
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
  <div style="display:inline-block;background:${C.bg};border:1px solid ${C.border};border-radius:8px;padding:14px 32px;font-family:'Courier New',monospace;font-size:1.8rem;font-weight:800;color:${C.navy};letter-spacing:6px;">${code}</div>
</div>`;
}

/** Info row with label + value */
function infoRow(label, value) {
  return `<tr>
  <td style="padding:8px 0;border-bottom:1px solid ${C.bg};font-size:0.85rem;color:${C.muted};width:120px;vertical-align:top;">${label}</td>
  <td style="padding:8px 0;border-bottom:1px solid ${C.bg};font-size:0.85rem;color:${C.text};font-weight:600;">${value}</td>
</tr>`;
}

/** Info table wrapper */
function infoTable(rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">${rows}</table>`;
}

/** Feature bullet point */
function feature(text) {
  return `<tr><td style="padding:7px 0;font-size:0.88rem;color:${C.muted};line-height:1.5;"><span style="color:${C.navy};margin-right:8px;font-weight:700;">—</span>${text}</td></tr>`;
}

/** Feature list wrapper */
function featureList(items) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">${items.map(feature).join('')}</table>`;
}

/** Status badge */
function statusBadge(label, color) {
  const bg = color || C.navy;
  return `<span style="display:inline-block;background:${bg};color:#fff;padding:6px 16px;border-radius:20px;font-size:0.85rem;font-weight:700;">${label}</span>`;
}

/** Alert/warning box */
function alertBox(text, type) {
  const colors = {
    info:    { bg: '#eef3fa', border: C.navy, text: C.navy },
    warning: { bg: '#fff7ed', border: C.orange, text: C.orange },
    danger:  { bg: '#fef2f2', border: '#dc2626', text: '#dc2626' },
    success: { bg: '#f0fdf4', border: C.green, text: C.green },
  };
  const c = colors[type] || colors.info;
  return `<div style="margin:16px 0;padding:14px 18px;background:${c.bg};border-left:3px solid ${c.border};border-radius:4px;font-size:0.88rem;color:${c.text};line-height:1.5;">${text}</div>`;
}

/** Blockquote for message previews */
function quote(text) {
  return `<blockquote style="margin:14px 0;padding:12px 16px;background:${C.bg};border-left:3px solid ${C.navy};border-radius:4px;font-size:0.88rem;color:${C.text};font-style:italic;">${text}</blockquote>`;
}

/** Listing card for newsletters/alerts */
function listingCard(listing) {
  const price = listing.price ? `$${Number(listing.price).toLocaleString('en-US')}` : '';
  const img = listing.image || listing.images?.[0];
  const imgUrl = img ? (img.startsWith('http') ? img : `${BASE_URL}${img}`) : '';
  const url = `${BASE_URL}/listing/${listing.id}`;

  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;border:1px solid ${C.border};border-radius:8px;overflow:hidden;">
  ${imgUrl ? `<tr><td><img src="${imgUrl}" alt="" style="width:100%;height:140px;object-fit:cover;display:block;" /></td></tr>` : ''}
  <tr><td style="padding:14px 16px;">
    <div style="font-size:1rem;font-weight:800;color:${C.navy};margin-bottom:4px;">${price}</div>
    <div style="font-size:0.88rem;font-weight:700;color:${C.text};margin-bottom:4px;">${esc(listing.title)}</div>
    <div style="font-size:0.78rem;color:${C.muted};">${esc(listing.city || '')}${listing.province ? ', ' + esc(listing.province) : ''}</div>
    <div style="margin-top:10px;"><a href="${url}" style="font-size:0.82rem;font-weight:700;color:${C.navy};text-decoration:none;">Ver propiedad &rarr;</a></div>
  </td></tr>
</table>`;
}

/** Divider line */
function divider() {
  return `<hr style="border:none;border-top:1px solid ${C.border};margin:20px 0;" />`;
}

/** HTML-escape */
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  layout, button, buttonOutline, p, small, codeBlock,
  infoRow, infoTable, feature, featureList,
  statusBadge, alertBox, quote, listingCard, divider, esc,
  C, BASE_URL,
};
