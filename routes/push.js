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
const crypto     = require('crypto');
const { createTransport } = require('./mailer');

const router = express.Router();

// Email fallback transport. Lazy-initialized so the mailer factory only
// runs once. Tests override via _setTransporter to capture sendMail
// calls without hitting the real Resend/Gmail backends.
let _emailTransporter = null;
function _getEmailTransporter() {
  if (_emailTransporter) return _emailTransporter;
  try { _emailTransporter = createTransport(); } catch { _emailTransporter = null; }
  return _emailTransporter;
}
function _setTransporter(t) { _emailTransporter = t; }

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
  NEW_AFFILIATION:    'new_affiliation',
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
async function sendApns(deviceToken, payload, opts = {}) {
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
    // Default to a foreground alert push. Silent/background pushes (e.g.
    // refreshBadge) override these via opts so iOS treats them as
    // background updates — no banner, no sound, just a state refresh.
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${token}`,
      'apns-topic': _apnsBundleId,
      'apns-push-type': opts.pushType || 'alert',
      'apns-priority': opts.priority || '10',
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

  // Clear sticky email-fallback flag — the user has just re-subscribed
  // so we can trust push delivery again until/unless it fails afresh.
  try {
    const u = store.getUserById(userId);
    if (u && u.pushFallbackToEmail === true) {
      u.pushFallbackToEmail = false;
      store.saveUser(u);
    }
  } catch (e) {
    console.error('[Push] Failed to clear pushFallbackToEmail:', e.message);
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

// ── Badge count: computed from actual unread state ───────────────────────
// The iOS app icon badge should reflect REAL unread items, not a counter
// of pushes sent. We re-derive it from the source of truth (unread
// conversations + actionable tasks) every time we send a push so it stays
// in sync even when the user clears items via the web (or another device).
const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];

function unreadConversationCount(userId, user) {
  // Mirror of /api/conversations/unread, kept in sync with that route.
  if (!user) return 0;

  if (user.role === 'user') {
    const convs = store.getConversationsByClient(userId);
    return convs.filter(c => !c.closed && !c.archived && (c.unreadClient || 0) > 0).length;
  }

  if (PRO_ROLES.includes(user.role)) {
    const seen = new Set();
    const convs = [];
    const push = (c) => { if (!seen.has(c.id)) { seen.add(c.id); convs.push(c); } };
    store.getConversationsForBroker(userId).forEach(push);
    store.getConversationsByClient(userId).forEach(push);

    // Org-scoped + orphaned conversations on this org's listings
    const inmId = ['inmobiliaria', 'constructora'].includes(user.role)
      ? user.id : user.inmobiliaria_id;
    if (inmId) {
      for (const c of store.getConversations()) {
        if (c.brokerId || seen.has(c.id)) continue;
        if (c.inmobiliariaId === inmId) { push(c); continue; }
        if (!c.inmobiliariaId && c.propertyId) {
          const listing = store.getListingById(c.propertyId);
          if (listing && (listing.creator_user_id === inmId ||
            (Array.isArray(listing.agencies) && listing.agencies.some(a => a.user_id === inmId)))) {
            push(c);
          }
        }
      }
    }

    return convs.filter(c => {
      if (c.closed || c.archived) return false;
      const isClientHere = c.clientId === userId;
      if (isClientHere) return (c.unreadClient || 0) > 0;
      return (c.unreadBroker || 0) > 0;
    }).length;
  }
  return 0;
}

function pendingTaskCount(userId, user) {
  // Mirror of /api/tasks/badge-count.
  if (!user) return 0;
  const userOrgId = ['inmobiliaria', 'constructora'].includes(user.role)
    ? user.id : user.inmobiliaria_id;

  let count = 0;
  for (const row of (store._tasks || [])) {
    const t = store.getTaskById(row.id);
    if (!t) continue;
    if (t.status === 'completada' || t.status === 'no_aplica') continue;

    if (userOrgId) {
      const creator = store.getUserById(t.assigned_by);
      const creatorOrgId = creator
        ? (['inmobiliaria', 'constructora'].includes(creator.role) ? creator.id : creator.inmobiliaria_id)
        : null;
      let inOrg = creatorOrgId === userOrgId;
      if (!inOrg && t.application_id) {
        const app = store.getApplicationById(t.application_id);
        inOrg = !!(app && app.inmobiliaria_id === userOrgId);
      }
      if (!inOrg) continue;
    }

    const approverId = t.approver_id || t.approverId || null;
    if (t.assigned_to === userId && (t.status === 'pendiente' || t.status === 'en_progreso')) {
      count++;
      continue;
    }
    if (approverId === userId && t.assigned_to !== userId && t.status === 'pending_review') {
      count++;
    }
  }
  return count;
}

function leadQueueCount(userId, user) {
  // Count active lead_queue items where the user is in the CURRENT tier
  // and the lead's inmobiliaria scope (if any) matches the user's org.
  // We lazy-require cascade-engine to avoid a circular import at module
  // load time — cascade-engine imports push for notifications.
  if (!user) return 0;
  let cascadeEngine;
  try { cascadeEngine = require('./cascade-engine'); } catch { return 0; }
  if (!cascadeEngine?.getTierAgents) return 0;
  const userOrgId = ['inmobiliaria', 'constructora'].includes(user.role)
    ? user.id : user.inmobiliaria_id;
  let count = 0;
  const active = store.getActiveLeadQueue ? store.getActiveLeadQueue() : [];
  for (const item of active) {
    // Read new column, fall back to legacy _extra field for unmigrated rows
    const scope = item.org_scope_id || item.inmobiliaria_scope || null;
    if (scope && scope !== userOrgId) continue;
    const listing = store.getListingById(item.listing_id);
    if (!listing) continue;
    const tiers = cascadeEngine.getTierAgents(listing, scope);
    const currentTierAgents = { 1: tiers.tier1, 2: tiers.tier2, 3: tiers.tier3 }[item.current_tier] || [];
    if (currentTierAgents.includes(userId)) count++;
  }
  return count;
}

function unreadNotificationCount(userId) {
  return store.getUnreadNotificationCount ? store.getUnreadNotificationCount(userId) : 0;
}

function computeBadgeCount(userId) {
  const user = store.getUserById(userId);
  if (!user) return 0;
  const total =
    unreadConversationCount(userId, user) +
    pendingTaskCount(userId, user) +
    leadQueueCount(userId, user) +
    unreadNotificationCount(userId);
  // iOS displays "99+" beyond 99; clamping prevents weird wide-digit badges.
  return Math.max(0, Math.min(99, total));
}

// ── Notification history persistence ──────────────────────────────────────
// Every notification we send via notify() is also written to a history
// row so the user has an inbox they can revisit. Unread rows count toward
// the badge, which makes the icon stay accurate even if pushes were
// silenced / lost — the next launch reads from the DB, not from APNs.
function persistNotification(userId, notification) {
  if (!userId || !notification) return null;
  if (!store.saveNotification) return null;
  const id = 'notif_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const row = {
    id,
    user_id:    userId,
    type:       notification.type || 'general',
    title:      notification.title || 'HogaresRD',
    body:       notification.body || '',
    url:        notification.url || '/',
    data:       notification.data || {},
    read_at:    null,
    created_at: new Date().toISOString(),
  };
  try { store.saveNotification(row); } catch (e) { console.error('[Push] persistNotification failed:', e.message); }
  return row;
}

// ── refreshBadge — silent APNs background push to update icon count ──────
// Call this after server-side state changes that affect a user's unread
// count but don't generate a user-facing notification (e.g. they read a
// conversation on web, completed a task, marked a notification read).
// Updates the icon while the app is closed without any banner/sound.
async function refreshBadge(userId) {
  try {
    if (!userId) return;
    const userSubs = store.getPushSubscriptionsByUser(userId);
    if (!userSubs?.ios?.length) return;
    const badgeValue = computeBadgeCount(userId);
    const apnsPayload = { aps: { 'content-available': 1, badge: badgeValue } };
    await Promise.allSettled(
      userSubs.ios.map(token => sendApns(token, apnsPayload, {
        pushType: 'background',
        priority: '5', // low-priority background, conserves battery + bypasses banner
      }))
    );
  } catch (e) {
    // Never throw — a failed badge refresh shouldn't break the calling flow.
    console.error('[Push] refreshBadge error:', e.message);
  }
}

// POST /badge-reset — kept for iOS-app backward compat; now a no-op since
// the badge count is recomputed from real state on every push. The iOS
// app calls UNUserNotificationCenter.setBadgeCount(0) locally on launch
// which is what actually clears the icon.
router.post('/badge-reset', userAuth, (_req, res) => {
  res.json({ ok: true });
});

// ── notify() — send a push notification to a user ─────────────────────────
// notification: { type: string, title: string, body: string, url?: string, data?: object }
// Never throws — errors are logged internally.
async function notify(userId, notification) {
  try {
    if (!userId || !notification) return;

    const userSubs = store.getPushSubscriptionsByUser(userId);
    const user = (typeof store.getUserById === 'function') ? store.getUserById(userId) : null;

    // Always honor the sticky fallback flag, even if push subs are empty.
    // (Spec E3: "even if there's a subscription on file" — the flag means
    // we don't trust push delivery for this user until they re-subscribe.)
    const fallbackToEmail = !!(user && user.pushFallbackToEmail === true);

    if (!userSubs) {
      console.log(`[Push] No subscriptions for user ${userId}`);
      if (fallbackToEmail) await _emailFallback(user, notification);
      return;
    }

    const iosCount = userSubs.ios?.length || 0;
    const webCount = userSubs.web?.length || 0;
    console.log(`[Push] notify(${userId}): type=${notification.type}, ios=${iosCount}, web=${webCount}, fallbackToEmail=${fallbackToEmail}`);

    // Check preferences — if the user has explicitly disabled this type, skip
    const prefs = { ...DEFAULT_PREFERENCES, ...(userSubs.preferences || {}) };
    if (notification.type && prefs[notification.type] === false) {
      console.log(`[Push] Skipped — user ${userId} disabled ${notification.type}`);
      return;
    }

    // Persist a notification-history row BEFORE sending the push so the
    // badge count (computed below) includes this notification.
    persistNotification(userId, notification);

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
            // Sticky flag: once a user's push has failed (subscription
            // gone), we can't trust push delivery for them until they
            // explicitly re-subscribe. notify() consults this flag and
            // forces an email fallback.
            try {
              const u = store.getUserById(userId);
              if (u && u.pushFallbackToEmail !== true) {
                u.pushFallbackToEmail = true;
                store.saveUser(u);
              }
            } catch (e) {
              console.error('[Push] Failed to set pushFallbackToEmail:', e.message);
            }
          } else {
            console.error(`[Push] Web push error for user ${userId}:`, err && err.message);
          }
        }
      }
    }

    // ── iOS APNs ──────────────────────────────────────────────────────────
    if (userSubs.ios && userSubs.ios.length > 0) {
      const badgeValue = computeBadgeCount(userId);
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

    // Email fallback. Triggered for users whose pushFallbackToEmail flag
    // is set (a previous web push returned 410/404). Sticky until the
    // user explicitly re-subscribes via POST /api/push/subscribe.
    if (fallbackToEmail) {
      await _emailFallback(user, notification);
    }
  } catch (err) {
    // notify() must never throw
    console.error('[Push] Unexpected error in notify():', err && err.message);
  }
}

// Build a minimal HTML email from a push notification payload and ship
// it via the central mailer. Never throws — failures are logged.
async function _emailFallback(user, notification) {
  try {
    if (!user || !user.email) return;
    const t = _getEmailTransporter();
    if (!t || typeof t.sendMail !== 'function') return;
    const safe = (s) => String(s || '').replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
    const subject = notification.title || 'HogaresRD';
    const body    = notification.body  || '';
    const url     = notification.url   || '/';
    const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#0038A8;">${safe(subject)}</h2>
      <p>${safe(body)}</p>
      <p><a href="${safe(url)}" style="display:inline-block;background:#0038A8;color:#fff;padding:0.6rem 1.1rem;border-radius:8px;text-decoration:none;">Abrir en HogaresRD</a></p>
      <hr style="border:none;border-top:1px solid #e6ecf5;margin-top:1.5rem;">
      <p style="color:#7a8aa3;font-size:0.78rem;">Recibes este correo porque las notificaciones push están temporalmente desactivadas para tu cuenta. Vuelve a habilitarlas desde tu panel para dejar de recibir estos correos.</p>
    </div>`;
    await t.sendMail({ to: user.email, subject, html, department: 'admin' });
  } catch (e) {
    console.error('[Push] Email fallback failed:', e && e.message);
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

module.exports = { router, notify, refreshBadge, computeBadgeCount, broadcastNewListing, NotificationType };

// Internal hook for tests — replace the email transport with a stub that
// captures sendMail calls. Not part of the public API.
module.exports.__test = {
  _setTransporter,
};
