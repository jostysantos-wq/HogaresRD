const express    = require('express');
const webpush    = require('web-push');
const store      = require('./store');
const { userAuth } = require('./auth');

const router = express.Router();

// ── Notification types ────────────────────────────────────────────────────
const NotificationType = Object.freeze({
  NEW_APPLICATION:    'new_application',
  STATUS_CHANGED:     'status_changed',
  NEW_MESSAGE:        'new_message',
  TOUR_UPDATE:        'tour_update',
  PAYMENT_APPROVED:   'payment_approved',
  DOCUMENT_REVIEWED:  'document_reviewed',
  SECRETARY_ACTION:   'secretary_action',
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

  if (type === 'web') {
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription object with endpoint' });
    }
    store.savePushSubscription(userId, { type: 'web', subscription });
  } else if (type === 'ios') {
    if (!deviceToken) {
      return res.status(400).json({ error: 'Missing deviceToken' });
    }
    store.savePushSubscription(userId, { type: 'ios', deviceToken });
  } else {
    return res.status(400).json({ error: 'type must be "web" or "ios"' });
  }

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
  // Merge with defaults so new types are always present
  res.json({ ...DEFAULT_PREFERENCES, ...prefs });
});

// PUT /preferences — update notification preferences
router.put('/preferences', userAuth, (req, res) => {
  const userId = req.user.sub;
  const prefs  = req.body;

  if (!prefs || typeof prefs !== 'object') {
    return res.status(400).json({ error: 'Body must be an object of preference flags' });
  }

  // Only accept known notification types
  const sanitized = {};
  for (const key of Object.values(NotificationType)) {
    if (key in prefs) sanitized[key] = !!prefs[key];
  }

  store.savePushPreferences(userId, sanitized);
  res.json({ ...DEFAULT_PREFERENCES, ...sanitized });
});

// ── notify() — send a push notification to a user ─────────────────────────
// notification: { type: string, title: string, body: string, url?: string, data?: object }
// Never throws — errors are logged internally.
async function notify(userId, notification) {
  try {
    if (!userId || !notification) return;

    const userSubs = store.getPushSubscriptionsByUser(userId);
    if (!userSubs) return;

    // Check preferences — if the user has explicitly disabled this type, skip
    const prefs = { ...DEFAULT_PREFERENCES, ...(userSubs.preferences || {}) };
    if (notification.type && prefs[notification.type] === false) return;

    const payload = JSON.stringify({
      title: notification.title || 'HogaresRD',
      body:  notification.body  || '',
      url:   notification.url   || '/',
      type:  notification.type  || 'general',
      data:  notification.data  || {},
    });

    // ── Web push ──────────────────────────────────────────────────────────
    if (userSubs.web && userSubs.web.length > 0) {
      // Ensure VAPID is configured
      ensureVapid();

      const results = await Promise.allSettled(
        userSubs.web.map(sub => webpush.sendNotification(sub, payload))
      );

      // Remove expired/invalid subscriptions (410 Gone or 404 Not Found)
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

    // ── iOS APNs (stub) ───────────────────────────────────────────────────
    if (userSubs.ios && userSubs.ios.length > 0) {
      for (const deviceToken of userSubs.ios) {
        // TODO: Implement APNs HTTP/2 push
        // This is structured for future implementation with an APNs provider
        console.log(`[Push] APNs stub — would send to device ${deviceToken.substring(0, 8)}... for user ${userId}:`, {
          title: notification.title,
          body:  notification.body,
          type:  notification.type,
        });
      }
    }
  } catch (err) {
    // notify() must never throw
    console.error('[Push] Unexpected error in notify():', err && err.message);
  }
}

module.exports = { router, notify, NotificationType };
