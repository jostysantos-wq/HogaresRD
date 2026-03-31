// HogaresRD — Meta Lead Ads webhook
//
// Register this URL in Meta Business Manager → Webhooks → Page → leadgen field.
// GET  /api/webhooks/meta  — verification challenge
// POST /api/webhooks/meta  — lead notification

'use strict';

const express = require('express');
const https   = require('https');
const store   = require('./store');

const router = express.Router();

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';

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
router.post('/', express.json(), (req, res) => {
  // Acknowledge immediately (Meta requires 200 within 5 s)
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
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
