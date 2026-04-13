/**
 * mailer.js — Central email transport
 *
 * Transport priority:
 *   1. Gmail API (Google Workspace via service account — no SMTP ports needed)
 *   2. Resend HTTP API (fallback if Gmail API not configured)
 *   3. Google Workspace SMTP (only if SMTP_PRIMARY=1 and ports are open)
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
const path = require('path');
const fs = require('fs');
let Resend;
try { Resend = require('resend').Resend; } catch (_) {}

// Gmail API — cached with 1-hour TTL for the primary delegated user
let _gmailClient = null;
let _gmailClientExpiry = 0;
const GMAIL_CLIENT_TTL = 60 * 60 * 1000; // 1 hour

// ── Department email addresses ──────────────────────────────────────────
const EMAILS = {
  soporte: 'HogaresRD Soporte <soporte@hogaresrd.com>',
  legal:   'HogaresRD Legal <legal@hogaresrd.com>',
  admin:   'HogaresRD Admin <admin@hogaresrd.com>',
  ventas:  'HogaresRD Ventas <ventas@hogaresrd.com>',
  noreply: 'HogaresRD <noreply@hogaresrd.com>',
};

// Department sender addresses (just the email part)
// These are the "From:" display addresses used in email headers.
const DEPT_EMAILS = {
  soporte: 'soporte@hogaresrd.com',
  legal:   'legal@hogaresrd.com',
  admin:   'admin@hogaresrd.com',
  ventas:  'ventas@hogaresrd.com',
  noreply: 'noreply@hogaresrd.com',
};

// Note: Department aliases (soporte@, legal@, admin@, ventas@, noreply@) must
// be configured as "Send As" addresses in the primary Workspace user's Gmail
// settings for the From header to be respected by the Gmail API.

// All replies go to the main support inbox
const REPLY_TO = 'soporte@hogaresrd.com';

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

// ── Gmail API Transport ──────────────────────────────────────────────────

/**
 * Get a Gmail API client that impersonates the PRIMARY Workspace user.
 *
 * Important: We always impersonate the primary user (GOOGLE_DELEGATED_USER)
 * regardless of which department alias we're sending from. The actual "From:"
 * address is controlled by the raw RFC 2822 message, and Gmail respects it
 * as long as the alias is configured as a "Send As" address on the primary user.
 *
 * Previously we tried impersonating each alias directly, but if they're
 * aliases (not separate users), the JWT resolves to the primary user and
 * Gmail overrides the From header.
 */
async function getGmailClient() {
  // Return cached client if available and not expired
  if (_gmailClient && Date.now() < _gmailClientExpiry) return _gmailClient;
  _gmailClient = null; // Force re-creation on expiry

  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyEnv) return null;

  try {
    const { google } = require('googleapis');

    // Load key — either file path or inline JSON
    let key;
    if (keyEnv.startsWith('{')) {
      key = JSON.parse(keyEnv);
    } else {
      key = JSON.parse(fs.readFileSync(keyEnv, 'utf8'));
    }

    // Always impersonate the primary Workspace user
    const primaryUser = process.env.GOOGLE_DELEGATED_USER || 'soporte@hogaresrd.com';
    console.log(`[mailer] Gmail API authenticating as primary user: ${primaryUser}`);

    const auth = new google.auth.JWT({
      email:   key.client_email,
      key:     key.private_key,
      scopes:  ['https://www.googleapis.com/auth/gmail.send'],
      subject: primaryUser,
    });

    _gmailClient = google.gmail({ version: 'v1', auth });
    _gmailClientExpiry = Date.now() + GMAIL_CLIENT_TTL;
    return _gmailClient;
  } catch (err) {
    console.warn('[mailer] Gmail API init failed:', err.message);
    return null;
  }
}

/**
 * Send an email via Gmail API.
 * Constructs a raw RFC 2822 message and sends via users.messages.send.
 */
async function sendViaGmailAPI(opts) {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
  const boundary = '----=_Part_' + Date.now().toString(36);

  console.log(`[mailer] Gmail API sending from: ${opts.from} → to: ${toArray.join(', ')}`);

  // Build RFC 2822 message
  // Gmail respects the From header when the address is a "Send As" alias
  const messageParts = [
    `From: ${opts.from}`,
    `To: ${toArray.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject).toString('base64')}?=`,
    `Reply-To: ${REPLY_TO}`,
  ];
  // Inject custom headers (List-Unsubscribe, etc.)
  if (opts.headers && typeof opts.headers === 'object') {
    for (const [key, value] of Object.entries(opts.headers)) {
      if (value) messageParts.push(`${key}: ${value}`);
    }
  }
  messageParts.push(
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(opts.html).toString('base64'),
    `--${boundary}--`,
  );

  const raw = Buffer.from(messageParts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return result.data;
}

// ── Main Transport Factory ───────────────────────────────────────────────

function createTransport() {
  const wsUser = process.env.WS_EMAIL_USER;
  const wsPass = process.env.WS_EMAIL_PASS;
  const resendKey = process.env.RESEND_API_KEY;
  const hasGmailAPI = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  // Google Workspace SMTP transporter (only used when SMTP_PRIMARY=1)
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

  // Resend HTTP API
  const resend = (resendKey && Resend) ? new Resend(resendKey) : null;

  if (hasGmailAPI) console.log('[mailer] Gmail API configured as primary transport');
  else if (resend) console.log('[mailer] Resend HTTP API configured as primary transport');
  else if (smtp)   console.log('[mailer] SMTP configured as primary transport');
  else             console.warn('[mailer] No email transport configured!');

  return {
    /**
     * sendMail({ to, subject, html, department? })
     *
     * Priority: Gmail API → Resend → SMTP
     */
    async sendMail(opts) {
      const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
      // Sanitize subject — strip newlines to prevent header injection
      if (opts.subject) opts.subject = String(opts.subject).replace(/[\r\n]/g, ' ').slice(0, 200);
      const dept = opts.department || detectDepartment(opts.subject);
      const from = EMAILS[dept] || EMAILS.soporte;

      // ── 1. Gmail API (primary — works over HTTPS, no SMTP ports) ──
      if (hasGmailAPI) {
        try {
          return await sendViaGmailAPI({ ...opts, from, to: toArray, _dept: dept });
        } catch (gmailErr) {
          console.warn('[mailer] Gmail API failed:', gmailErr.message);
          // Fall through to Resend
        }
      }

      // ── 2. Resend HTTP API ────────────────────────────────────────
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
        }
      }

      // ── 3. SMTP fallback (only works if DO unblocks ports) ────────
      if (smtp) {
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
          console.warn('[mailer] SMTP failed:', smtpErr.message);
        }
      }

      // ── No transport available ──────────────────────────────────
      console.warn('[mailer] No email transport available — email skipped:', opts.subject);
      return undefined;
    },
  };
}

module.exports = { createTransport, EMAILS, REPLY_TO };
