/**
 * utils/sanitize.js
 *
 * Defense-in-depth input sanitizers for user-supplied text. Originally
 * lived inline in server.js for the /submit handler (audit fix H-1);
 * promoted here so listing edits, leads, profile updates, and any
 * future ingest path can reuse the same rules.
 *
 * Policy:
 *   - Strip ASCII control chars (0x00–0x1F, 0x7F). Long-text variant
 *     keeps \n (0x0A) and \t (0x09) so descriptions can wrap lines.
 *   - Strip < and > (the HTML parser delimiters). The remaining text
 *     is harmless even when an output renderer forgets escapeHtml().
 *   - Length-clamp every field. Caller passes maxLen so we don't
 *     define a single one-size-fits-all cap.
 *
 * Renderers MUST still call escapeHtml() on output. This module is
 * the second wall, not the first.
 */

'use strict';

function sanitizeShortText(v, maxLen) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7F) continue;
    if (c === 0x3C || c === 0x3E) continue; // < >
    out += v[i];
    if (out.length >= maxLen) break;
  }
  return out;
}

function sanitizeLongText(v, maxLen) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 && c !== 0x0A && c !== 0x09) continue;
    if (c === 0x7F) continue;
    if (c === 0x3C || c === 0x3E) continue;
    out += v[i];
    if (out.length >= maxLen) break;
  }
  return out;
}

function sanitizeAgencies(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 10).map(a => ({
    name:  sanitizeShortText(a && a.name,  120),
    agent: sanitizeShortText(a && a.agent, 120),
    phone: sanitizeShortText(a && a.phone,  40),
    email: sanitizeShortText(a && a.email, 120),
  }));
}

/**
 * Reject obviously dangerous URL schemes when a value will be rendered
 * into an `src=` or `href=` attribute. Allows http(s):// and same-origin
 * absolute paths (`/uploads/...`). Returns '' for anything else so the
 * renderer falls through to a safe placeholder.
 */
function sanitizeUrl(v) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (!trimmed) return '';
  if (/^(https?:\/\/|\/)/i.test(trimmed)) return trimmed.slice(0, 2048);
  return '';
}

module.exports = {
  sanitizeShortText,
  sanitizeLongText,
  sanitizeAgencies,
  sanitizeUrl,
};
