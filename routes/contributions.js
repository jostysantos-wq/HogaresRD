// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Contribution Scores API
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const store   = require('./store');

// ── GET /api/contributions/:listingId — All scores for a listing ────────
router.get('/:listingId', (req, res) => {
  const scores = store.getContributionScoresForListing(req.params.listingId);

  const enriched = scores.map(s => {
    const user = store.getUserById(s.user_id);
    return {
      user_id:         s.user_id,
      user_name:       user?.name || '',
      agency_name:     user?.agency?.name || user?.inmobiliaria_name || '',
      role:            s.role,
      score:           s.score,
      score_breakdown: s.score_breakdown || {},
      avg_response_ms: s.avg_response_ms,
      response_count:  s.response_count || 0,
    };
  });

  // Sort by score descending
  enriched.sort((a, b) => b.score - a.score);

  res.json({ scores: enriched });
});

// ── GET /api/contributions/mine/:listingId — Current agent's score ──────
router.get('/mine/:listingId', (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const score = store.getContributionScore(userId, req.params.listingId);
  if (!score) return res.json({ score: null });

  res.json({
    score: {
      role: score.role,
      total: score.score,
      breakdown: score.score_breakdown || {},
      avg_response_ms: score.avg_response_ms,
      response_count: score.response_count || 0,
    },
  });
});

// ── POST /api/contributions/:listingId/share-click — Track share ────────
router.post('/:listingId/share-click', (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const cs = store.getContributionScore(userId, req.params.listingId);
  if (!cs) return res.status(404).json({ error: 'No estás afiliado a esta propiedad.' });

  const breakdown = cs.score_breakdown || {};
  const currentShareScore = breakdown.share_clicks || 0;
  const MAX_SHARE_SCORE = 25; // Cap: 5 clicks × 5 points each

  if (currentShareScore >= MAX_SHARE_SCORE) {
    return res.json({ score: cs.score, message: 'Límite de puntos por compartir alcanzado.' });
  }

  breakdown.share_clicks = Math.min(currentShareScore + 5, MAX_SHARE_SCORE);
  cs.score_breakdown = breakdown;
  cs.score = Object.values(breakdown).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  cs.updated_at = new Date().toISOString();

  store.saveContributionScore(cs);

  res.json({ score: cs.score, breakdown });
});

module.exports = { router };
