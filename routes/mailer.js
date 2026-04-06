/**
 * mailer.js — Central email transport
 *
 * Primary: Google Workspace SMTP (no daily limit, professional @hogaresrd.com)
 * Fallback: Resend HTTP API (if SMTP fails due to port blocks)
 *
 * Department routing:
 *   soporte@hogaresrd.com  — Support, welcome, verification, general
 *   legal@hogaresrd.com    — Terms, privacy, legal notices
 *   admin@hogaresrd.com    — Admin alerts, listing approvals, system
 *   ventas@hogaresrd.com   — Sales, subscriptions, partnerships
 *   noreply@hogaresrd.com  — Automated notifications (status updates, newsletters)
 */

'use strict';

const nodemailer = require('nodemailer');
let Resend;
try { Resend = require('resend').Resend; } catch (_) {}

// ── Department email addresses ──────────────────────────────────────────
const EMAILS = {
  soporte: 'HogaresRD Soporte <soporte@hogaresrd.com>',
  legal:   'HogaresRD Legal <legal@hogaresrd.com>',
  admin:   'HogaresRD Admin <admin@hogaresrd.com>',
  ventas:  'HogaresRD Ventas <ventas@hogaresrd.com>',
  noreply: 'HogaresRD <noreply@hogaresrd.com>',
};

// All replies go to the main workspace inbox
const REPLY_TO = 'Jostysantos@hogaresrd.com';

/**
 * Auto-detect the department based on email subject keywords.
 */
function detectDepartment(subject) {
  if (!subject) return 'soporte';
  const s = subject.toLowerCase();

  if (s.includes('acción requerida') || s.includes('accion requerida') ||
      s.includes('nueva propiedad para aprobar') || s.includes('solicitud de agencia') ||
      s.includes('bloqueada temporalmente')) return 'admin';

  if (s.includes('suscripción') || s.includes('suscripcion') || s.includes('plan') ||
      s.includes('pago') || s.includes('factura')) return 'ventas';

  if (s.includes('legal') || s.includes('términos') || s.includes('terminos') ||
      s.includes('privacidad') || s.includes('eliminar mi cuenta')) return 'legal';

  if (s.includes('tu aplicación') || s.includes('tu aplicacion') ||
      s.includes('resumen del día') || s.includes('resumen del dia') ||
      s.includes('nueva(s) propiedad') || s.includes('te respondió') ||
      s.includes('te respondio')) return 'noreply';

  return 'soporte';
}

function createTransport() {
  const wsUser = process.env.WS_EMAIL_USER;
  const wsPass = process.env.WS_EMAIL_PASS;
  const resendKey = process.env.RESEND_API_KEY;

  // Google Workspace SMTP transporter
  // Force IPv4 + short timeouts — the droplet has no IPv6 route to Google's
  // SMTP, so without this we hang ~30s before falling back to Resend.
  const smtp = (wsUser && wsPass) ? nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4,
    auth: { user: wsUser, pass: wsPass },
    connectionTimeout: 8000,
    greetingTimeout:   8000,
    socketTimeout:     10000,
  }) : null;

  // Resend HTTP API fallback
  const resend = (resendKey && Resend) ? new Resend(resendKey) : null;

  return {
    /**
     * sendMail({ to, subject, html, department? })
     *
     * Tries Workspace SMTP first, falls back to Resend if SMTP fails.
     */
    async sendMail(opts) {
      const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
      const dept = opts.department || detectDepartment(opts.subject);
      const from = EMAILS[dept] || EMAILS.soporte;

      // ── Primary: Resend HTTP API (always works, no port blocks) ──
      // DigitalOcean blocks SMTP ports 465/587. Until they unblock,
      // Resend is the primary transport. When DO opens the ports, set
      // SMTP_PRIMARY=1 in .env to swap SMTP back to primary.
      const smtpFirst = process.env.SMTP_PRIMARY === '1';

      if (smtpFirst && smtp) {
        try {
          return await smtp.sendMail({
            from,
            to:       toArray.join(', '),
            subject:  opts.subject,
            html:     opts.html,
            replyTo:  REPLY_TO,
            headers:  opts.headers || {},
          });
        } catch (smtpErr) {
          console.warn('[mailer] SMTP failed, trying Resend fallback:', smtpErr.message);
        }
      }

      // ── Resend HTTP API (primary while SMTP is blocked) ─────────
      if (resend) {
        try {
          const result = await resend.emails.send({
            from,
            to:       toArray,
            subject:  opts.subject,
            html:     opts.html,
            reply_to: REPLY_TO,
            headers:  opts.headers || {},
          });
          if (result.error) {
            throw Object.assign(new Error(result.error.message || 'Resend error'), result.error);
          }
          return result;
        } catch (resendErr) {
          console.warn('[mailer] Resend failed:', resendErr.message);
          // Fall through to SMTP fallback if Resend is primary
        }
      }

      // ── Fallback: try SMTP if it wasn't the primary ────────────
      if (!smtpFirst && smtp) {
        try {
          return await smtp.sendMail({
            from,
            to:       toArray.join(', '),
            subject:  opts.subject,
            html:     opts.html,
            replyTo:  REPLY_TO,
            headers:  opts.headers || {},
          });
        } catch (smtpErr) {
          console.warn('[mailer] SMTP fallback also failed:', smtpErr.message);
        }
      }

      // ── No transport available ──────────────────────────────────
      console.warn('[mailer] No email transport available — email skipped:', opts.subject);
      return undefined;
    },
  };
}

module.exports = { createTransport, EMAILS, REPLY_TO };
