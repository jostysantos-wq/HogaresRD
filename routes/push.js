/**
 * push.js — Push notification service
 *
 * Transports:
 *   - Web Push (VAPID / web-push library)
 *   - iOS APNs (token-based .p8 authentication via HTTP/2)
 *
 * Env vars for APNs:
 *   APNS_KEY_PATH  — path to .p8 key file (from Apple Developer Console)
 *   APNS_KEY_ID    — Key ID shown when the key was created
 *   APNS_TEAM_ID   — Apple Team ID (10-char, from Membership page)
 *   APNS_BUNDLE_ID — App bundle ID (e.g., com.hogaresrd.app)
 *   APNS_PRODUCTION — set to "1" for production APNs (default: sandbox)
 */

'use strict';

const express    = require('express');
const webpush    = require('web-push');
const store      = require('./store');
const { userAuth } = require('./auth');
const http2      = require('http2');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');

const router = express.Router();

// ── Notification types ────────────────────────────────────────────────────
const NotificationType = Object.freeze({
  NEW_APPLICATION:    'new_application',
  STATUS_CHANGED:     'status_changed',
  NEW_MESSAGE:        'new_message',
  TOUR_UPDATE:        'tour_update',
  PAYMENT_APPROVED:   'payment_approved',
  LEAD_CASCADE:       'lead_cascade',
  DOCUMENT_REVIEWED:  'document_reviewed',
  SECRETARY_ACTION:   'secretary_action',
  SAVED_SEARCH_MATCH: 'saved_search_match',
  NEW_LISTING:        'new_listing',
});

// Default preferences — all enabled
const DEFAULT_PREFERENCES = Object.freeze(
  Object.values(NotificationType).reduce((acc, t) => { acc[t] = true; return acc; }, {})
);

// ── Configure VAPID ───────────────────────────────────────────────────────
function ensureVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      'mailto:contact@hogaresrd.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }
}
ensureVapid();

// ── APNs Configuration ───────────────────────────────────────────────────

let _apnsKey = null;
let _apnsKeyId  = process.env.APNS_KEY_ID  || null;
let _apnsTeamId = process.env.APNS_TEAM_ID || null;
let _apnsBundleId = process.env.APNS_BUNDLE_ID || 'com.hogaresrd.app';
let _apnsHost = process.env.APNS_PRODUCTION === '1'
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

// Load .p8 key
function loadApnsKey() {
  if (_apnsKey) return _apnsKey;
  const keyPath = process.env.APNS_KEY_PATH;
  if (!keyPath) return null;
  try {
    _apnsKey = fs.readFileSync(keyPath, 'utf8');
    console.log(`[Push] APNs key loaded from ${keyPath} (${_apnsHost})`);
    return _apnsKey;
  } catch (err) {
    console.warn('[Push] Failed to load APNs key:', err.message);
    return null;
  }
}

// Generate short-lived JWT for APNs (valid 1 hour, refresh every 50 min)
let _apnsJwt = null;
let _apnsJwtTime = 0;

function getApnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  // Refresh if older than 50 minutes
  if (_apnsJwt && (now - _apnsJwtTime) < 3000) return _apnsJwt;

  const key = loadApnsKey();
  if (!key || !_apnsKeyId || !_apnsTeamId) return null;

  _apnsJwt = jwt.sign(
    { iss: _apnsTeamId, iat: now },
    key,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: _apnsKeyId } }
  );
  _apnsJwtTime = now;
  return _apnsJwt;
}

/**
 * Send a push notification via APNs HTTP/2
 */
async function sendApns(deviceToken, payload) {
  const token = getApnsJwt();
  if (!token) {
    console.warn('[Push] APNs not configured — skipping iOS push');
    return null;
  }

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${_apnsHost}`);

    client.on('error', (err) => {
      console.error('[Push] APNs HTTP/2 connection error:', err.message);
      reject(err);
    });

    const body = JSON.stringify(payload);
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${token}`,
      'apns-topic': _apnsBundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };

    const req = client.request(headers);

    let responseData = '';
    let statusCode = 0;

    req.on('response', (headers) => {
      statusCode = headers[':status'];
    });

    req.on('data', (chunk) => {
      responseData += chunk;
    });

    req.on('end', () => {
      client.close();
      if (statusCode === 200) {
        resolve({ success: true, statusCode });
      } else {
        let reason = '';
        try { reason = JSON.parse(responseData).reason || responseData; } catch (_) { reason = responseData; }
        console.warn(`[Push] APNs error ${statusCode} for ${deviceToken.substring(0, 8)}...: ${reason}`);
        resolve({ success: false, statusCode, reason });
      }
    });

    req.on('error', (err) => {
      client.close();
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────

// GET /vapid-key — public, returns the VAPID public key
router.get('/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || null;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// POST /subscribe — save a push subscription (web or iOS)
router.post('/subscribe', userAuth, (req, res) => {
  const userId = req.user.sub;
  const { type, subscription, deviceToken } = req.body;

  // Get existing subscriptions to merge (don't overwrite)
  const existing = store.getPushSubscriptionsByUser(userId);

  if (type === 'web') {
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription object with endpoint' });
    }
    // Add web subscription if not already present
    if (!existing.web.some(s => s.endpoint === subscription.endpoint)) {
      existing.web.push(subscription);
    }
    store.savePushSubscription(userId, existing);
  } else if (type === 'ios') {
    if (!deviceToken) {
      return res.status(400).json({ error: 'Missing deviceToken' });
    }
    // Add iOS token if not already present
    if (!existing.ios.includes(deviceToken)) {
      existing.ios.push(deviceToken);
    }
    store.savePushSubscription(userId, existing);
  } else {
    return res.status(400).json({ error: 'type must be "web" or "ios"' });
  }

  console.log(`[Push] ${type} subscription saved for user ${userId}`);
  res.json({ ok: true });
});

// DELETE /subscribe — remove a push subscription
router.delete('/subscribe', userAuth, (req, res) => {
  const userId = req.user.sub;
  const { type, endpoint, deviceToken } = req.body;

  if (type === 'web' && endpoint) {
    store.removePushSubscription(userId, 'web', endpoint);
  } else if (type === 'ios' && deviceToken) {
    store.removePushSubscription(userId, 'ios', deviceToken);
  } else {
    return res.status(400).json({ error: 'Provide type ("web"/"ios") and endpoint or deviceToken' });
  }

  res.json({ ok: true });
});

// GET /preferences — get notification preferences
router.get('/preferences', userAuth, (req, res) => {
  const userId = req.user.sub;
  const prefs  = store.getPushPreferences(userId);
  res.json({ ...DEFAULT_PREFERENCES, ...prefs });
});

// PUT /preferences — update notification preferences
router.put('/preferences', userAuth, (req, res) => {
  const userId = req.user.sub;
  const prefs  = req.body;

  if (!prefs || typeof prefs !== 'object') {
    return res.status(400).json({ error: 'Body must be an object of preference flags' });
  }

  const sanitized = {};
  for (const key of Object.values(NotificationType)) {
    if (key in prefs) sanitized[key] = !!prefs[key];
  }

  store.savePushPreferences(userId, sanitized);
  res.json({ ...DEFAULT_PREFERENCES, ...sanitized });
});

// ── Per-user badge counter ────────────────────────────────────────────────
// Tracks the cumulative unread badge value for each user's iOS app icon.
// Incremented on every push, reset when the app calls POST /badge-reset.
const _badgeCounts = new Map();

function getBadgeCount(userId) {
  return _badgeCounts.get(userId) || 0;
}

function incrementBadge(userId) {
  const cur = _badgeCounts.get(userId) || 0;
  _badgeCounts.set(userId, cur + 1);
  return cur + 1;
}

function resetBadge(userId) {
  _badgeCounts.set(userId, 0);
}

// POST /badge-reset — iOS app calls this when it becomes active to sync
// the server-side badge counter to zero. This prevents stale badge values
// from being sent with the next push notification.
router.post('/badge-reset', userAuth, (req, res) => {
  resetBadge(req.user.sub);
  res.json({ ok: true });
});

// ── notify() — send a push notification to a user ─────────────────────────
// notification: { type: string, title: string, body: string, url?: string, data?: object }
// Never throws — errors are logged internally.
async function notify(userId, notification) {
  try {
    if (!userId || !notification) return;

    const userSubs = store.getPushSubscriptionsByUser(userId);
    if (!userSubs) {
      console.log(`[Push] No subscriptions for user ${userId}`);
      return;
    }

    const iosCount = userSubs.ios?.length || 0;
    const webCount = userSubs.web?.length || 0;
    console.log(`[Push] notify(${userId}): type=${notification.type}, ios=${iosCount}, web=${webCount}`);

    // Check preferences — if the user has explicitly disabled this type, skip
    const prefs = { ...DEFAULT_PREFERENCES, ...(userSubs.preferences || {}) };
    if (notification.type && prefs[notification.type] === false) {
      console.log(`[Push] Skipped — user ${userId} disabled ${notification.type}`);
      return;
    }

    const webPayload = JSON.stringify({
      title: notification.title || 'HogaresRD',
      body:  notification.body  || '',
      url:   notification.url   || '/',
      type:  notification.type  || 'general',
      data:  notification.data  || {},
    });

    // ── Web push ──────────────────────────────────────────────────────────
    if (userSubs.web && userSubs.web.length > 0) {
      ensureVapid();

      const results = await Promise.allSettled(
        userSubs.web.map(sub => webpush.sendNotification(sub, webPayload))
      );

      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].status === 'rejected') {
          const err = results[i].reason;
          const statusCode = err && err.statusCode;
          if (statusCode === 410 || statusCode === 404) {
            console.log(`[Push] Removing expired web subscription for user ${userId}`);
            store.removePushSubscription(userId, 'web', userSubs.web[i].endpoint);
          } else {
            console.error(`[Push] Web push error for user ${userId}:`, err && err.message);
          }
        }
      }
    }

    // ── iOS APNs ──────────────────────────────────────────────────────────
    if (userSubs.ios && userSubs.ios.length > 0) {
      const badgeValue = incrementBadge(userId);
      const apnsPayload = {
        aps: {
          alert: {
            title: notification.title || 'HogaresRD',
            body:  notification.body  || '',
          },
          sound: 'default',
          badge: badgeValue,
          'mutable-content': 1,
        },
        // Custom data for deep linking
        type: notification.type || 'general',
        url:  notification.url  || '/',
        ...(notification.data || {}),
      };

      console.log(`[Push] Sending APNs to ${userSubs.ios.length} iOS device(s) for user ${userId}`);
      const results = await Promise.allSettled(
        userSubs.ios.map(token => sendApns(token, apnsPayload))
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          const res = results[i].value;
          if (res === null) {
            console.warn(`[Push] APNs skipped — key not configured`);
          } else if (res.success) {
            console.log(`[Push] APNs sent OK to ${userSubs.ios[i].substring(0, 12)}...`);
          } else {
            console.warn(`[Push] APNs failed: ${res.statusCode} ${res.reason}`);
          }
        } else {
          console.error(`[Push] APNs exception:`, results[i].reason?.message);
        }
      }

      // Remove invalid tokens (BadDeviceToken, Unregistered)
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].status === 'fulfilled') {
          const res = results[i].value;
          if (res && !res.success && (res.reason === 'BadDeviceToken' || res.reason === 'Unregistered')) {
            console.log(`[Push] Removing invalid iOS token for user ${userId}`);
            store.removePushSubscription(userId, 'ios', userSubs.ios[i]);
          }
        }
      }
    }
  } catch (err) {
    // notify() must never throw
    console.error('[Push] Unexpected error in notify():', err && err.message);
  }
}

// Log APNs status on startup
if (process.env.APNS_KEY_PATH) {
  loadApnsKey();
  if (_apnsKey && _apnsKeyId && _apnsTeamId) {
    console.log(`[Push] APNs configured: team=${_apnsTeamId}, key=${_apnsKeyId}, bundle=${_apnsBundleId}, env=${_apnsHost}`);
  } else {
    console.warn('[Push] APNs partially configured — check APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID');
  }
} else {
  console.log('[Push] APNs not configured — iOS push disabled (set APNS_KEY_PATH to enable)');
}

/**
 * broadcastNewListing() — notify ALL subscribed users about a new listing.
 * Respects per-user preferences (users can disable 'new_listing' notifications).
 */
async function broadcastNewListing(listing) {
  try {
    const allSubs = store.getPushSubscriptions();
    if (!allSubs || !allSubs.length) return;

    const title = listing.title || 'Nueva propiedad';
    const price = listing.price ? `$${Number(listing.price).toLocaleString()}` : '';
    const city = listing.city || listing.province || '';
    const body = [price, city].filter(Boolean).join(' · ') || 'Nueva propiedad disponible en HogaresRD';

    let sent = 0;
    for (const sub of allSubs) {
      // Don't notify the listing owner about their own listing
      if (sub.userId === listing.userId) continue;

      await notify(sub.userId, {
        type: 'new_listing',
        title: `🏠 ${title}`,
        body,
        url: `/listing/${listing.id}`,
        data: { listingId: listing.id },
      });
      sent++;
    }
    console.log(`[Push] Broadcast new_listing to ${sent} users: ${listing.id} — ${title}`);
  } catch (err) {
    console.error('[Push] Broadcast error:', err.message);
  }
}

module.exports = { router, notify, broadcastNewListing, NotificationType };
