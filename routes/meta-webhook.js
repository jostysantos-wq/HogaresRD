// HogaresRD — Meta Lead Ads webhook
//
// Register this URL in Meta Business Manager → Webhooks → Page → leadgen field.
// GET  /api/webhooks/meta  — verification challenge
// POST /api/webhooks/meta  — lead notification

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const store   = require('./store');

const router = express.Router();

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const APP_SECRET   = process.env.META_APP_SECRET || '';

// Constant-time hex comparison. Returns false on any length mismatch
// (timingSafeEqual throws if buffers differ in length).
function _safeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// ── GET — Webhook verification (Meta sends hub.challenge) ─────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('[Meta Webhook] Verified successfully');
    return res.status(200).send(challenge);
  }
  console.warn('[Meta Webhook] Verification failed — token mismatch or missing');
  res.status(403).send('Forbidden');
});

// ── POST — Lead notification ───────────────────────────────────────────────
// We use express.raw here so we can compute the HMAC over the exact bytes
// Meta sent, then JSON.parse manually. Mounting express.json() before this
// would re-serialize the body and break signature verification.
router.post('/', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  // Refuse to process if the app secret isn't configured — without it we
  // cannot distinguish real Meta callbacks from forged ones.
  if (!APP_SECRET) {
    console.error('[Meta Webhook] META_APP_SECRET is not set — rejecting webhook.');
    return res.status(503).json({ error: 'webhook not configured' });
  }

  const sigHeader = req.headers['x-hub-signature-256'] || '';
  const expectedPrefix = 'sha256=';
  if (!sigHeader.startsWith(expectedPrefix)) {
    console.warn('[Meta Webhook] Missing or malformed X-Hub-Signature-256 header');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  const provided = sigHeader.slice(expectedPrefix.length);

  if (!_safeHexEqual(expected, provided)) {
    console.warn('[Meta Webhook] Signature mismatch — rejecting');
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Parse the JSON ourselves now that the signature has been validated.
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (err) {
    console.warn('[Meta Webhook] Invalid JSON payload:', err.message);
    return res.status(400).json({ error: 'invalid json' });
  }

  // Acknowledge immediately (Meta requires 200 within 5 s)
  res.status(200).send('EVENT_RECEIVED');

  if (!body || body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;

      const { leadgen_id, page_id, form_id, ad_id, ad_name } = change.value || {};
      if (!leadgen_id) continue;

      setImmediate(async () => {
        try {
          const lead = await _fetchLeadData(leadgen_id);
          if (!lead) return;

          // Parse field_data array into a plain object
          const fields = {};
          for (const f of lead.field_data || []) {
            fields[f.name] = f.values?.[0] || '';
          }

          const name    = fields['full_name']
                        || [fields['first_name'], fields['last_name']].filter(Boolean).join(' ')
                        || '';
          const email   = fields['email'] || '';
          const phone   = fields['phone_number'] || '';
          const message = fields['comments'] || fields['message']
                        || `Lead desde Meta Ads${ad_name ? ': ' + ad_name : ''}`;

          if (!email && !phone) {
            console.warn('[Meta Lead] Lead missing email and phone — skipping', leadgen_id);
            return;
          }

          // Match to existing user if possible
          const existingUser = email ? store.getUserByEmail(email) : null;

          const lead_record = {
            id:          `meta_${leadgen_id}`,
            source:      'meta_lead_ad',
            leadgenId:   leadgen_id,
            formId:      form_id    || null,
            pageId:      page_id    || null,
            adId:        ad_id      || null,
            adName:      ad_name    || null,
            clientId:    existingUser?.id || null,
            name,
            email,
            phone,
            message,
            fields,                    // all raw field_data
            createdAt:   new Date().toISOString(),
          };

          store.appendMetaLead(lead_record);
          console.log(`[Meta Lead] Saved — ${email || phone} (${ad_name || leadgen_id})`);

        } catch (err) {
          console.error('[Meta Lead Error]', err.message);
        }
      });
    }
  }
});

// ── Fetch lead detail from Graph API ─────────────────────────────────────
function _fetchLeadData(leadgenId) {
  if (!ACCESS_TOKEN) return Promise.resolve(null);
  return new Promise((resolve) => {
    const path = `/${leadgenId}?fields=field_data,created_time,ad_id,ad_name,form_id,page_id&access_token=${ACCESS_TOKEN}`;
    const options = { hostname: 'graph.facebook.com', path, method: 'GET' };
    let data = '';
    const req = https.request(options, (res) => {
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

module.exports = router;
