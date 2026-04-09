#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Backfill creator_user_id and contribution_scores
//
// Run once after deploying the cascade system:
//   node scripts/backfill-creators.js
//
// Safe to re-run — skips entries that already exist.
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const store = require('../routes/store');

async function waitForCache(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // Check if cache is populated (users array has entries means cache loaded)
    if (store.getUsers().length > 0 || store.getAllSubmissions().length > 0) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function backfill() {
  console.log('[backfill] Waiting for cache to load...');
  const ready = await waitForCache();
  if (!ready) {
    console.error('[backfill] Cache did not load within 30s. Check DATABASE_URL.');
    process.exit(1);
  }

  const submissions = store.getAllSubmissions();
  const users = store.getUsers();

  console.log(`[backfill] Processing ${submissions.length} submissions, ${users.length} users`);

  let creatorsFilled = 0;
  let scoresCreated = 0;

  for (const sub of submissions) {
    if (sub.status !== 'approved') continue;

    // ── 1. Backfill creator_user_id ────────────────────────────────
    if (!sub.creator_user_id) {
      // Strategy: Match submitter email → user email
      const submitterEmail = (sub.email || '').toLowerCase().trim();
      let creatorId = null;

      if (submitterEmail) {
        const matchedUser = users.find(u => u.email && u.email.toLowerCase().trim() === submitterEmail);
        if (matchedUser) creatorId = matchedUser.id;
      }

      // Fallback: first agency's user_id
      if (!creatorId) {
        const agencies = Array.isArray(sub.agencies) ? sub.agencies : [];
        if (agencies.length > 0 && agencies[0].user_id) {
          creatorId = agencies[0].user_id;
        }
      }

      if (creatorId) {
        sub.creator_user_id = creatorId;
        store.saveListing(sub);
        creatorsFilled++;
      }
    }

    // ── 2. Create contribution_scores ──────────────────────────────
    const creatorId = sub.creator_user_id;
    const nowIso = new Date().toISOString();

    // Creator score
    if (creatorId && !store.getContributionScore(creatorId, sub.id)) {
      store.saveContributionScore({
        id: 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
        user_id: creatorId,
        listing_id: sub.id,
        role: 'creator',
        score: 50,
        score_breakdown: { created_listing: 50 },
        avg_response_ms: null,
        response_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
        _extra: {},
      });
      scoresCreated++;
    }

    // Affiliate scores
    const agencies = Array.isArray(sub.agencies) ? sub.agencies : [];
    for (const agency of agencies) {
      const agentId = agency.user_id;
      if (!agentId || agentId === creatorId) continue;
      if (!store.getContributionScore(agentId, sub.id)) {
        store.saveContributionScore({
          id: 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
          user_id: agentId,
          listing_id: sub.id,
          role: 'affiliate',
          score: 0,
          score_breakdown: {},
          avg_response_ms: null,
          response_count: 0,
          created_at: nowIso,
          updated_at: nowIso,
          _extra: {},
        });
        scoresCreated++;
      }
    }
  }

  console.log(`[backfill] Done: ${creatorsFilled} creators filled, ${scoresCreated} scores created`);
  console.log('[backfill] Waiting for async PG writes to flush...');
  await new Promise(r => setTimeout(r, 3000));
  process.exit(0);
}

backfill().catch(err => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
