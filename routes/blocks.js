// ════════════════════════════════════════════════════════════════════════
// User blocks — App Store Review 1.2 / Apple UGC requirements
// ════════════════════════════════════════════════════════════════════════
// Lets a user hide all interaction surfaces for another user. Symmetric:
// when A blocks B, neither sees the other's conversations or reviews.
// State lives on user._extra.blocked_user_ids; see store.getBlockedUserIds.

const express = require('express');
const router  = express.Router();
const store   = require('./store');
const { userAuth } = require('./auth');

// GET /api/blocks — list the IDs (and lightweight names) of users the
// caller has blocked. Used by the iOS Profile screen so the user can
// review and unblock.
router.get('/', userAuth, (req, res) => {
  const ids = store.getBlockedUserIds(req.user.sub);
  const blocked = ids.map(id => {
    const u = store.getUserById(id);
    return {
      id,
      name:   u?.name  || 'Usuario eliminado',
      email:  u?.email || null,
      role:   u?.role  || null,
      avatar: u?.avatarUrl || null,
    };
  });
  res.json({ blocked });
});

// POST /api/blocks — body: { user_id }. Adds the relationship.
router.post('/', userAuth, (req, res) => {
  const targetId = (req.body?.user_id || '').toString().trim();
  if (!targetId) return res.status(400).json({ error: 'user_id requerido' });
  if (targetId === req.user.sub)
    return res.status(400).json({ error: 'No puedes bloquearte a ti mismo' });

  const target = store.getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

  const ok = store.addBlockedUser(req.user.sub, targetId);
  if (!ok) return res.status(500).json({ error: 'No se pudo registrar el bloqueo' });

  res.json({ success: true, blocked_id: targetId });
});

// DELETE /api/blocks/:userId — remove the relationship.
router.delete('/:userId', userAuth, (req, res) => {
  const targetId = (req.params.userId || '').toString().trim();
  if (!targetId) return res.status(400).json({ error: 'user_id requerido' });

  const ok = store.removeBlockedUser(req.user.sub, targetId);
  if (!ok) return res.status(500).json({ error: 'No se pudo quitar el bloqueo' });

  res.json({ success: true, unblocked_id: targetId });
});

module.exports = router;
