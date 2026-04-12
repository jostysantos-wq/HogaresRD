// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Lead Queue API (agent-facing)
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const store   = require('./store');
const cascade = require('./cascade-engine');

// Auth middleware — imported from auth.js at mount time via server.js
// All routes here require authentication (broker/agency/inmobiliaria roles)

// ── GET /api/lead-queue — Leads claimable by current agent ──────────────
router.get('/', (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const user = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

  const activeQueue = store.getActiveLeadQueue();
  const claimable = [];

  for (const item of activeQueue) {
    const listing = store.getListingById(item.listing_id);
    if (!listing) continue;

    // Hydrate the full item to get _extra fields (like inmobiliaria_scope)
    const fullItem = store.getLeadQueueById(item.id) || item;

    // Respect inmobiliaria scope — only show leads to agents in the scoped org
    const { tier1, tier2, tier3 } = cascade.getTierAgents(listing, fullItem.inmobiliaria_scope || null);
    const currentTierAgents = { 1: tier1, 2: tier2, 3: tier3 }[fullItem.current_tier] || [];

    if (currentTierAgents.includes(userId)) {
      // Calculate time remaining using tier-specific window (not hardcoded constant)
      const tierField = `tier${fullItem.current_tier}_notified_at`;
      const notifiedAt = fullItem[tierField] ? new Date(fullItem[tierField]).getTime() : Date.now();
      const tierWindow = cascade.TIER_WINDOWS?.[fullItem.current_tier] || cascade.CASCADE_WINDOW_MS;
      const remainingMs = Math.max(0, tierWindow - (Date.now() - notifiedAt));

      claimable.push({
        id: item.id,
        inquiry_type: item.inquiry_type,
        listing_id: item.listing_id,
        listing_title: listing.title || '',
        listing_price: listing.price || '',
        listing_city: listing.city || '',
        listing_image: Array.isArray(listing.images) && listing.images[0]
          ? (listing.images[0].url || listing.images[0]) : null,
        buyer_name: item.current_tier <= 2 ? item.buyer_name : (item.buyer_name || '').split(' ')[0] + '…',
        tier: item.current_tier,
        remaining_ms: remainingMs,
        created_at: item.created_at,
      });
    }
  }

  res.json({ leads: claimable });
});

// ── POST /api/lead-queue/:id/claim — Claim a lead ──────────────────────
router.post('/:id/claim', (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  if (!cascade.isEnabled()) {
    return res.status(400).json({ error: 'El sistema de cascada no está habilitado.' });
  }

  const result = cascade.claimLead(req.params.id, userId);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  // Get updated info to return
  const item = store.getLeadQueueById(req.params.id);
  res.json({
    success: true,
    inquiry_type: item?.inquiry_type,
    inquiry_id: item?.inquiry_id,
    listing_id: item?.listing_id,
  });
});

// ── GET /api/lead-queue/stats — Agent response time stats ──────────────
router.get('/stats', (req, res) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'No autenticado.' });

  const allScores = store.getContributionScores().filter(c => c.user_id === userId);

  const totalResponses = allScores.reduce((sum, c) => sum + (c.response_count || 0), 0);
  const avgResponseMs = totalResponses > 0
    ? Math.round(allScores.reduce((sum, c) => sum + (c.avg_response_ms || 0) * (c.response_count || 0), 0) / totalResponses)
    : null;

  const totalScore = allScores.reduce((sum, c) => sum + (c.score || 0), 0);
  const listingCount = allScores.length;

  // Recent claims (only items with status 'claimed')
  const recentClaims = store.getLeadQueue()
    .filter(q => q.claimed_by === userId && q.status === 'claimed')
    .sort((a, b) => (b.claimed_at || '').localeCompare(a.claimed_at || ''))
    .slice(0, 10)
    .map(q => ({
      id: q.id,
      listing_id: q.listing_id,
      inquiry_type: q.inquiry_type,
      tier: q.current_tier,
      claimed_at: q.claimed_at,
    }));

  res.json({
    total_score: totalScore,
    listing_count: listingCount,
    total_responses: totalResponses,
    avg_response_ms: avgResponseMs,
    avg_response_min: avgResponseMs ? (avgResponseMs / 60000).toFixed(1) : null,
    recent_claims: recentClaims,
  });
});

module.exports = { router };
