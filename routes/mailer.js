/**
 * mailer.js — Central email transport (Resend HTTP API)
 *
 * All emails route through Resend with department-specific "from" addresses.
 * Replies forward to the main inbox (Jostysantos@hogaresrd.com).
 *
 * Departments (auto-detected from subject or manually set):
 *   soporte@hogaresrd.com  — Support, welcome, verification, general
 *   legal@hogaresrd.com    — Terms, privacy, legal notices
 *   admin@hogaresrd.com    — Admin alerts, listing approvals, system
 *   ventas@hogaresrd.com   — Sales, subscriptions, partnerships
 *   noreply@hogaresrd.com  — Automated notifications (status updates, newsletters)
 */

'use strict';

const { Resend } = require('resend');

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
 * Routes emails to the appropriate from address automatically.
 */
function detectDepartment(subject) {
  if (!subject) return 'soporte';
  const s = subject.toLowerCase();

  // Admin alerts — listing approvals, system notifications
  if (s.includes('acción requerida') || s.includes('accion requerida') ||
      s.includes('nueva propiedad para aprobar') || s.includes('solicitud de agencia') ||
      s.includes('bloqueada temporalmente')) return 'admin';

  // Sales — subscriptions, plans, payments
  if (s.includes('suscripción') || s.includes('suscripcion') || s.includes('plan') ||
      s.includes('pago') || s.includes('factura')) return 'ventas';

  // Legal — terms, privacy
  if (s.includes('legal') || s.includes('términos') || s.includes('terminos') ||
      s.includes('privacidad') || s.includes('eliminar mi cuenta')) return 'legal';

  // Automated notifications — status updates, newsletters, saved searches
  if (s.includes('tu aplicación') || s.includes('tu aplicacion') ||
      s.includes('resumen del día') || s.includes('resumen del dia') ||
      s.includes('nueva(s) propiedad') || s.includes('te respondió') ||
      s.includes('te respondio')) return 'noreply';

  // Default — welcome, verification, password reset, general support
  return 'soporte';
}

function createTransport() {
  const apiKey = process.env.RESEND_API_KEY;
  const client = apiKey ? new Resend(apiKey) : null;

  return {
    /**
     * sendMail({ from?, to, subject, html, department? })
     *
     * Compatible with nodemailer's transporter.sendMail() signature.
     * Optional `department` overrides auto-detection:
     *   'soporte' | 'legal' | 'admin' | 'ventas' | 'noreply'
     */
    sendMail(opts) {
      if (!client) {
        console.warn('[mailer] RESEND_API_KEY not set — email skipped:', opts && opts.subject);
        return Promise.resolve();
      }

      const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
      const dept = opts.department || detectDepartment(opts.subject);
      const from = EMAILS[dept] || EMAILS.soporte;

      return client.emails.send({
        from,
        to:       toArray,
        subject:  opts.subject,
        html:     opts.html,
        reply_to: REPLY_TO,
        headers:  opts.headers || {},
      }).then(result => {
        if (result.error) {
          throw Object.assign(new Error(result.error.message || 'Resend error'), result.error);
        }
        return result;
      });
    },
  };
}

module.exports = { createTransport, EMAILS, REPLY_TO };
