// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Notifications inbox API
//
// Notifications are persisted by routes/push.js whenever notify() fires,
// so this router just exposes the read/list/mark-read surface. Marking a
// notification read triggers a silent badge refresh on iOS.
// ══════════════════════════════════════════════════════════════════════════

'use strict';

const express  = require('express');
const router   = express.Router();
const store    = require('./store');
const { userAuth } = require('./auth');
const { refreshBadge } = require('./push');

// ── GET /api/notifications — list current user's notifications ────────────
// Query params:
//   ?limit=N       (default 50, max 200)
//   ?unreadOnly=1  to filter to unread
router.get('/', userAuth, (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const unreadOnly = req.query.unreadOnly === '1' || req.query.unreadOnly === 'true';
  const items = store.getNotificationsByUser(userId, { limit, unreadOnly });
  const unreadCount = store.getUnreadNotificationCount(userId);
  res.json({ notifications: items, unreadCount });
});

// ── GET /api/notifications/unread-count — quick count for nav badges ──────
router.get('/unread-count', userAuth, (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });
  res.json({ count: store.getUnreadNotificationCount(userId) });
});

// ── POST /api/notifications/:id/read — mark a single notification read ───
router.post('/:id/read', userAuth, (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const ok = store.markNotificationRead(req.params.id, userId);
  if (!ok) return res.status(404).json({ error: 'Notificación no encontrada.' });
  // Fire-and-forget: refresh the icon badge while the app is closed
  refreshBadge(userId).catch(() => {});
  res.json({ ok: true, unreadCount: store.getUnreadNotificationCount(userId) });
});

// ── POST /api/notifications/mark-all-read — clear the inbox ───────────────
router.post('/mark-all-read', userAuth, (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const touched = store.markAllNotificationsRead(userId);
  if (touched > 0) refreshBadge(userId).catch(() => {});
  res.json({ ok: true, marked: touched });
});

// ── DELETE /api/notifications/:id — remove a notification from history ────
router.delete('/:id', userAuth, (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const ok = store.deleteNotification(req.params.id, userId);
  if (!ok) return res.status(404).json({ error: 'Notificación no encontrada.' });
  refreshBadge(userId).catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
