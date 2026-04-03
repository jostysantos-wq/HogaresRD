/**
 * mailer.js — Central email transport
 *
 * Uses Resend (HTTP API) when RESEND_API_KEY is set.
 * Falls back to a no-op warning in production if the key is missing.
 *
 * All route files call createTransport() which returns an object with
 * a sendMail() method that matches the nodemailer API signature, so
 * no changes are needed in the calling routes.
 *
 * Setup:
 *   1. Sign up at https://resend.com (free: 3 000 emails/month)
 *   2. Add hogaresrd.com and copy the DKIM/SPF DNS records to Cloudflare
 *   3. Create an API key and add to .env:
 *        RESEND_API_KEY=re_xxxxxxxxxxxx
 *        RESEND_FROM="HogaresRD Soporte <support@hogaresrd.com>"
 *   4. pm2 restart hogaresrd
 */

'use strict';

const { Resend } = require('resend');

function createTransport() {
  const apiKey = process.env.RESEND_API_KEY;
  const client = apiKey ? new Resend(apiKey) : null;

  // The verified "from" address comes from env so swapping to
  // support@hogaresrd.com later only requires an .env change.
  const defaultFrom = process.env.RESEND_FROM
    || `"HogaresRD Soporte" <${process.env.EMAIL_USER || 'noreply@hogaresrd.com'}>`;

  return {
    /**
     * sendMail({ from?, to, subject, html })
     * Compatible with nodemailer's transporter.sendMail() signature.
     * Returns a Promise — use .catch() as before.
     */
    sendMail(opts) {
      if (!client) {
        console.warn('[mailer] RESEND_API_KEY not set — email skipped:', opts && opts.subject);
        return Promise.resolve();
      }

      const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];

      return client.emails.send({
        from:    defaultFrom,   // always use verified sender; ignore opts.from
        to:      toArray,
        subject: opts.subject,
        html:    opts.html,
      }).then(result => {
        if (result.error) {
          throw Object.assign(new Error(result.error.message || 'Resend error'), result.error);
        }
        return result;
      });
    },
  };
}

module.exports = { createTransport };
