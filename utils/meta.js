// HogaresRD — Meta Conversions API (CAPI) + Lead Ads helpers
// Gracefully no-ops when META_PIXEL_ID / META_ACCESS_TOKEN are not set.
//
// All public functions are fire-and-forget safe:
//   setImmediate(async () => { await meta.trackLead({...}); });

'use strict';

const crypto = require('crypto');
const https  = require('https');

const PIXEL_ID     = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION  = 'v19.0';
const BASE_URL     = process.env.BASE_URL || 'https://hogaresrd.com';

// ── Helpers ───────────────────────────────────────────────────────────────

/** SHA-256 hash of a lowercase-trimmed string (required by Meta for PII). */
function _hash(val) {
  if (!val) return undefined;
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

/** POST JSON to the Meta Graph API. Returns parsed response body. */
function _post(payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const options = {
      hostname: 'graph.facebook.com',
      path:     `/${API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Core send ─────────────────────────────────────────────────────────────

/**
 * Send a single event to the Meta Conversions API.
 *
 * @param {object} opts
 * @param {string}  opts.eventName   Standard or custom event name.
 * @param {string}  [opts.eventId]   Deduplication ID (match the pixel eventID param).
 * @param {object}  [opts.userData]  { email, phone, firstName, lastName, ip, userAgent, fbc, fbp }
 * @param {object}  [opts.customData]
 * @param {string}  [opts.sourceUrl]
 */
async function sendEvent({ eventName, eventId, userData = {}, customData = {}, sourceUrl }) {
  if (!PIXEL_ID || !ACCESS_TOKEN) return;

  const ud = {};
  if (userData.email)     ud.em  = [_hash(userData.email)];
  if (userData.phone)     ud.ph  = [_hash(userData.phone)];
  if (userData.firstName) ud.fn  = [_hash(userData.firstName)];
  if (userData.lastName)  ud.ln  = [_hash(userData.lastName)];
  if (userData.ip)        ud.client_ip_address = userData.ip;
  if (userData.userAgent) ud.client_user_agent = userData.userAgent;
  if (userData.fbc)       ud.fbc = userData.fbc;
  if (userData.fbp)       ud.fbp = userData.fbp;

  const event = {
    event_name:        eventName,
    event_time:        Math.floor(Date.now() / 1000),
    event_id:          eventId || crypto.randomUUID(),
    action_source:     'website',
    event_source_url:  sourceUrl || BASE_URL,
    user_data:         ud,
    custom_data:       customData,
  };

  // Remove empty custom_data
  if (!Object.keys(customData).length) delete event.custom_data;

  try {
    const result = await _post({ data: [event] });
    if (result?.error) console.error('[Meta CAPI]', result.error.message);
  } catch (err) {
    console.error('[Meta CAPI]', err.message);
  }
}

// ── Named event helpers ───────────────────────────────────────────────────

/**
 * Lead — client submits application or contact form.
 */
async function trackLead({ email, phone, name, ip, userAgent, fbc, fbp, eventId, listingTitle, listingId }) {
  const parts     = (name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ');
  await sendEvent({
    eventName:  'Lead',
    eventId:    eventId || `lead_${Date.now()}`,
    userData:   { email, phone, firstName, lastName, ip, userAgent, fbc, fbp },
    customData: {
      content_name: listingTitle,
      ...(listingId ? { content_ids: [listingId] } : {}),
    },
    sourceUrl: listingId ? `${BASE_URL}/listing?id=${listingId}` : BASE_URL,
  });
}

/**
 * CompleteRegistration — new user account created.
 */
async function trackCompleteRegistration({ email, phone, name, ip, userAgent, eventId }) {
  const parts     = (name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ');
  await sendEvent({
    eventName:  'CompleteRegistration',
    eventId:    eventId || `reg_${Date.now()}`,
    userData:   { email, phone, firstName, lastName, ip, userAgent },
    customData: { status: 'registered' },
    sourceUrl:  `${BASE_URL}/register`,
  });
}

/**
 * Purchase — subscription payment succeeded.
 */
async function trackPurchase({ email, phone, name, ip, userAgent, eventId, value, currency = 'USD', planName }) {
  const parts     = (name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ');
  await sendEvent({
    eventName:  'Purchase',
    eventId:    eventId || `purch_${Date.now()}`,
    userData:   { email, phone, firstName, lastName, ip, userAgent },
    customData: { value: Number(value) || 0, currency, content_name: planName },
    sourceUrl:  `${BASE_URL}/subscribe`,
  });
}

/**
 * ViewContent — user views a listing detail page (server-side mirror of pixel event).
 */
async function trackViewContent({ ip, userAgent, fbc, fbp, eventId, listingTitle, listingId, price }) {
  await sendEvent({
    eventName:  'ViewContent',
    eventId:    eventId || `vc_${Date.now()}`,
    userData:   { ip, userAgent, fbc, fbp },
    customData: {
      content_type: 'product',
      content_name: listingTitle,
      ...(listingId ? { content_ids: [listingId] } : {}),
      ...(price ? { value: Number(price), currency: 'USD' } : {}),
    },
    sourceUrl: listingId ? `${BASE_URL}/listing?id=${listingId}` : BASE_URL,
  });
}

module.exports = {
  sendEvent,
  trackLead,
  trackCompleteRegistration,
  trackPurchase,
  trackViewContent,
  isConfigured: () => !!(PIXEL_ID && ACCESS_TOKEN),
};
