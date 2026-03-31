// HogaresRD — Twilio SMS & WhatsApp notifications
// Gracefully no-ops when credentials are missing — never breaks the app.

const SID    = process.env.TWILIO_ACCOUNT_SID;
const TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM   = process.env.TWILIO_FROM_NUMBER;    // e.g. +18295550001 (SMS)
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886

const client = (SID && TOKEN) ? require('twilio')(SID, TOKEN) : null;

// ── Rate limiting: max 1 notification per conversation per 5 minutes ──────
const _lastSent = new Map();
function _throttle(key) {
  const now  = Date.now();
  const last = _lastSent.get(key) || 0;
  if (now - last < 5 * 60 * 1000) return true; // throttled
  _lastSent.set(key, now);
  return false;
}

// ── Normalise a DR phone number to E.164 ──────────────────────────────────
function _e164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;       // local: 8091234567
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.startsWith('+')) return phone.replace(/\s/g, '');
  return '+' + digits;
}

// ── Internal send helpers ─────────────────────────────────────────────────
async function _sms(to, body) {
  if (!client || !FROM) return;
  const num = _e164(to);
  if (!num) return;
  try {
    await client.messages.create({ from: FROM, to: num, body });
  } catch (err) {
    console.error('[Twilio SMS]', err.message);
  }
}

async function _whatsapp(to, body) {
  if (!client || !WA_FROM) return;
  const num = _e164(to);
  if (!num) return;
  try {
    await client.messages.create({
      from: WA_FROM,
      to:   'whatsapp:' + num,
      body,
    });
  } catch (err) {
    console.error('[Twilio WhatsApp]', err.message);
  }
}

// ── Public notification helpers ───────────────────────────────────────────

/**
 * Notify broker (WhatsApp) when a client sends a new chat message.
 */
async function notifyBrokerNewMessage({ brokerPhone, clientName, propertyTitle, messagePreview, convId }) {
  if (_throttle('broker-msg-' + convId)) return;
  const preview = messagePreview?.slice(0, 80) + (messagePreview?.length > 80 ? '…' : '');
  const body = `🏠 *HogaresRD* — Nuevo mensaje\n\n*${clientName}* te escribió sobre *${propertyTitle}*:\n"${preview}"\n\nResponde en: https://hogaresrd.com/broker`;
  await _whatsapp(brokerPhone, body);
}

/**
 * Notify client (SMS) when a broker replies to their message.
 */
async function notifyClientBrokerReply({ clientPhone, brokerName, propertyTitle, messagePreview, convId }) {
  if (_throttle('client-msg-' + convId)) return;
  const preview = messagePreview?.slice(0, 80) + (messagePreview?.length > 80 ? '…' : '');
  const body = `HogaresRD: ${brokerName} respondio sobre "${propertyTitle}": "${preview}". Ver: https://hogaresrd.com/mensajes?conv=${convId}`;
  await _sms(clientPhone, body);
}

/**
 * Notify broker (WhatsApp) when a new application is submitted for their listing.
 */
async function notifyBrokerNewApplication({ brokerPhone, clientName, propertyTitle, appId }) {
  if (_throttle('broker-app-' + appId)) return;
  const body = `📋 *HogaresRD* — Nueva aplicación\n\n*${clientName}* aplicó para *${propertyTitle}*.\n\nRevisa en: https://hogaresrd.com/broker`;
  await _whatsapp(brokerPhone, body);
}

/**
 * Notify client (SMS) when their application status changes.
 */
async function notifyClientStatusChange({ clientPhone, propertyTitle, newStatus, appId }) {
  const STATUS_LABELS = {
    aplicado:   'recibida',
    revisando:  'en revisión',
    aprobado:   '✅ aprobada',
    rechazado:  '❌ rechazada',
    cerrado:    'cerrada',
  };
  const label = STATUS_LABELS[newStatus] || newStatus;
  const body  = `HogaresRD: Tu aplicacion para "${propertyTitle}" fue actualizada a: ${label}. Ver: https://hogaresrd.com/my-applications`;
  await _sms(clientPhone, body);
}

/**
 * Send a verification SMS with a code (for phone number confirmation).
 */
async function sendVerificationSMS(phone, code) {
  const body = `Tu codigo de verificacion de HogaresRD es: ${code}. Valido por 10 minutos.`;
  await _sms(phone, body);
}

module.exports = {
  notifyBrokerNewMessage,
  notifyClientBrokerReply,
  notifyBrokerNewApplication,
  notifyClientStatusChange,
  sendVerificationSMS,
  isConfigured: () => !!(client && FROM),
};
