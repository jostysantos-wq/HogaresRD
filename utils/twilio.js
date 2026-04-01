// HogaresRD — Twilio WhatsApp notifications (brokers only)
// SMS removed — too expensive for DR numbers ($0.10/msg).
// Client notifications are handled via email instead.
//
// Gracefully no-ops when credentials are missing — never breaks the app.

'use strict';

const SID     = process.env.TWILIO_ACCOUNT_SID;
const TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886

const client = (SID && TOKEN) ? require('twilio')(SID, TOKEN) : null;

// ── Rate limiting: max 1 notification per key per 5 minutes ──────────────
const _lastSent = new Map();
function _throttle(key) {
  const now  = Date.now();
  const last = _lastSent.get(key) || 0;
  if (now - last < 5 * 60 * 1000) return true; // throttled
  _lastSent.set(key, now);
  return false;
}

// ── E.164 normalisation for DR numbers ───────────────────────────────────
function _e164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (phone.startsWith('+')) return phone.replace(/\s/g, '');
  return '+' + digits;
}

// ── WhatsApp send ─────────────────────────────────────────────────────────
async function _whatsapp(to, body) {
  if (!client || !WA_FROM) return;
  const num = _e164(to);
  if (!num) return;
  try {
    await client.messages.create({ from: WA_FROM, to: 'whatsapp:' + num, body });
  } catch (err) {
    console.error('[Twilio WhatsApp]', err.message);
  }
}

// ── Public helpers (brokers only, via WhatsApp) ───────────────────────────

/**
 * Notify broker when a client sends a new chat message.
 */
async function notifyBrokerNewMessage({ brokerPhone, clientName, propertyTitle, messagePreview, convId }) {
  if (_throttle('broker-msg-' + convId)) return;
  const preview = (messagePreview || '').slice(0, 80) + ((messagePreview || '').length > 80 ? '…' : '');
  const body = `🏠 *HogaresRD* — Nuevo mensaje\n\n*${clientName}* te escribió sobre *${propertyTitle}*:\n"${preview}"\n\nResponde en: https://hogaresrd.com/broker`;
  await _whatsapp(brokerPhone, body);
}

/**
 * Notify broker when a new application is submitted for their listing.
 */
async function notifyBrokerNewApplication({ brokerPhone, clientName, propertyTitle, appId }) {
  if (_throttle('broker-app-' + appId)) return;
  const body = `📋 *HogaresRD* — Nueva aplicación\n\n*${clientName}* aplicó para *${propertyTitle}*.\n\nRevisa en: https://hogaresrd.com/broker`;
  await _whatsapp(brokerPhone, body);
}

module.exports = {
  notifyBrokerNewMessage,
  notifyBrokerNewApplication,
  isConfigured: () => !!(client && WA_FROM),
};
