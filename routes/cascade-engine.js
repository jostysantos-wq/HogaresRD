// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Cascading Priority Lead Distribution Engine
//
// 3-tier system:
//   Tier 1: Listing creator (5-min exclusive)
//   Tier 2: Contributing affiliates (score >= 10, 5-min)
//   Tier 3: All remaining affiliates (first-to-claim, 5-min)
//   Tier 4: Auto-response to buyer
//
// Uses in-memory timers (setTimeout) with cron-based crash recovery.
// ══════════════════════════════════════════════════════════════════════════

const store = require('./store');

const CASCADE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes per tier
const CONTRIB_THRESHOLD = 10;            // Minimum score for Tier 2

// Active cascade timers: leadQueueId → timeoutId
const _timers = new Map();

// Claim lock: prevents race conditions in claimLead (belt-and-suspenders with Node's single-thread)
const _claimLocks = new Set();

// ── Helpers ─────────────────────────────────────────────────────────────

function genId() { return 'lq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function now() { return new Date().toISOString(); }

/** Lazy-load push to avoid circular dependency (push.js requires store.js) */
function getPush() {
  try { return require('./push'); } catch { return null; }
}

/** Lazy-load mailer */
function getMailer() {
  try { return require('./mailer'); } catch { return null; }
}

// ── Tier identification ─────────────────────────────────────────────────

/**
 * Returns arrays of user_ids eligible for each tier on this listing.
 */
function getTierAgents(listing) {
  const creatorId = listing.creator_user_id || null;
  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  const allAgentIds = agencies.map(a => a.user_id).filter(Boolean);

  // Tier 1: creator only
  const tier1 = creatorId ? [creatorId] : [];

  // Tier 2: contributors with score >= threshold, excluding creator
  const scores = store.getContributionScoresForListing(listing.id);
  const tier2 = scores
    .filter(s => s.score >= CONTRIB_THRESHOLD && s.user_id !== creatorId)
    .map(s => s.user_id);

  // Tier 3: remaining agents not in tier 1 or 2
  const inUpperTiers = new Set([...tier1, ...tier2]);
  const tier3 = allAgentIds.filter(id => !inUpperTiers.has(id));

  return { tier1, tier2, tier3 };
}

// ── Notification ────────────────────────────────────────────────────────

function notifyAgents(agentIds, item, listing, tierNum) {
  const push = getPush();
  if (!push) return;

  const tierLabels = { 1: 'Exclusiva', 2: 'Prioritaria', 3: 'Abierta' };
  const tierLabel = tierLabels[tierNum] || '';

  for (const userId of agentIds) {
    push.notify(userId, {
      title: `🏠 Nueva consulta — ${tierLabel}`,
      body: `${item.buyer_name || 'Un cliente'} está interesado en "${listing.title || 'una propiedad'}". Tienes 10 minutos para responder.`,
      url: '/broker#lead-queue',
      type: 'lead_cascade',
      data: {
        leadQueueId: item.id,
        listingId: listing.id,
        tier: tierNum,
        buyerName: item.buyer_name,
      },
    }).catch(() => {});
  }
}

/** Send auto-response when no agent claims the lead */
function sendAutoResponse(item) {
  const mailer = getMailer();
  if (!mailer || !item.buyer_email) return;

  const listing = store.getListingById(item.listing_id);
  const title = listing?.title || 'la propiedad';

  mailer.sendMail({
    department: 'ventas',
    to: item.buyer_email,
    subject: `Tu consulta sobre "${title}" — HogaresRD`,
    html: `
      <p>Hola ${item.buyer_name || ''},</p>
      <p>Recibimos tu consulta sobre <strong>${title}</strong>. Un agente se pondrá en contacto contigo lo antes posible.</p>
      <p>Si necesitas atención inmediata, puedes escribirnos por WhatsApp al <a href="https://wa.me/18094440000">+1 (809) 444-0000</a>.</p>
      <p>— El equipo de HogaresRD</p>
    `,
  }).catch(err => console.error('[cascade] Auto-response email error:', err.message));
}

// ── Core cascade logic ──────────────────────────────────────────────────

/**
 * Start a new cascade for a buyer inquiry.
 * @param {'application'|'lead'|'conversation'} inquiryType
 * @param {string} inquiryId
 * @param {string} listingId
 * @param {{ name?: string, phone?: string, email?: string }} buyerInfo
 * @returns {object|null} The created lead_queue item, or null if cascade not applicable
 */
function startCascade(inquiryType, inquiryId, listingId, buyerInfo = {}) {
  const listing = store.getListingById(listingId);
  if (!listing) {
    console.warn('[cascade] Listing not found:', listingId);
    return null;
  }

  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  if (agencies.length === 0) {
    console.log('[cascade] No agencies on listing, skipping cascade:', listingId);
    return null;
  }

  const { tier1, tier2, tier3 } = getTierAgents(listing);

  // Determine starting tier (skip empty tiers)
  let startTier = 1;
  if (tier1.length === 0) startTier = 2;
  if (startTier === 2 && tier2.length === 0) startTier = 3;
  if (startTier === 3 && tier3.length === 0) {
    // No agents at all — shouldn't happen but handle gracefully
    console.warn('[cascade] No eligible agents for listing:', listingId);
    return null;
  }

  const item = {
    id: genId(),
    inquiry_type: inquiryType,
    inquiry_id: inquiryId,
    listing_id: listingId,
    buyer_name: buyerInfo.name || '',
    buyer_phone: buyerInfo.phone || '',
    buyer_email: buyerInfo.email || '',
    current_tier: startTier,
    status: 'active',
    claimed_by: null,
    claimed_at: null,
    tier1_notified_at: null,
    tier2_notified_at: null,
    tier3_notified_at: null,
    auto_responded_at: null,
    created_at: now(),
  };

  // Mark notification timestamp for starting tier
  item[`tier${startTier}_notified_at`] = now();

  store.saveLeadQueueItem(item);

  // Notify agents in starting tier
  const agentsByTier = { 1: tier1, 2: tier2, 3: tier3 };
  notifyAgents(agentsByTier[startTier], item, listing, startTier);

  // Schedule escalation timer
  scheduleEscalation(item.id, CASCADE_WINDOW_MS);

  console.log(`[cascade] Started: ${item.id} for ${inquiryType}/${inquiryId} → tier ${startTier} (${agentsByTier[startTier].length} agents)`);
  return item;
}

/**
 * Agent claims a lead from the queue.
 * @param {string} leadQueueId
 * @param {string} userId
 * @returns {{ success: boolean, error?: string }}
 */
function claimLead(leadQueueId, userId) {
  // Claim lock to prevent double-claims within the same tick
  if (_claimLocks.has(leadQueueId)) {
    return { success: false, error: 'Este lead está siendo procesado.' };
  }
  _claimLocks.add(leadQueueId);

  try {
    const item = store.getLeadQueueById(leadQueueId);
    if (!item) return { success: false, error: 'Lead no encontrado.' };
    if (item.status !== 'active') return { success: false, error: 'Este lead ya fue reclamado.' };

    const listing = store.getListingById(item.listing_id);
    if (!listing) return { success: false, error: 'Propiedad no encontrada.' };

    // Validate agent is eligible for current tier
    const { tier1, tier2, tier3 } = getTierAgents(listing);
    const currentTierAgents = { 1: tier1, 2: tier2, 3: tier3 }[item.current_tier] || [];

    if (!currentTierAgents.includes(userId)) {
      return { success: false, error: 'No tienes prioridad para reclamar este lead en la ronda actual.' };
    }

    // Claim it
    item.status = 'claimed';
    item.claimed_by = userId;
    item.claimed_at = now();
    store.saveLeadQueueItem(item);

    // Cancel timer
    clearEscalation(item.id);

    // Ensure contribution score exists for this agent (auto-create if missing)
    ensureContributionScore(userId, item.listing_id);

    // Record response time
    const tierNotifiedAt = item[`tier${item.current_tier}_notified_at`];
    if (tierNotifiedAt) {
      const responseMs = Date.now() - new Date(tierNotifiedAt).getTime();
      updateAgentResponseTime(userId, item.listing_id, responseMs);
    }

    // Update the underlying inquiry's broker field
    assignBrokerToInquiry(item, userId);

    console.log(`[cascade] Claimed: ${item.id} by ${userId} (tier ${item.current_tier})`);
    return { success: true };
  } finally {
    _claimLocks.delete(leadQueueId);
  }
}

/**
 * Escalate to the next tier. Called by timer or recovery.
 */
function escalateTier(leadQueueId) {
  const item = store.getLeadQueueById(leadQueueId);
  if (!item || item.status !== 'active') return;

  const listing = store.getListingById(item.listing_id);
  if (!listing) return;

  const { tier1, tier2, tier3 } = getTierAgents(listing);
  const allTiers = { 1: tier1, 2: tier2, 3: tier3 };

  // Find next non-empty tier
  let nextTier = item.current_tier + 1;
  while (nextTier <= 3 && (!allTiers[nextTier] || allTiers[nextTier].length === 0)) {
    nextTier++;
  }

  if (nextTier > 3) {
    // All tiers exhausted — auto-assign to first eligible agent as fallback
    const fallbackAgent = allTiers[1][0] || allTiers[2][0] || allTiers[3][0];
    if (fallbackAgent) {
      item.status = 'claimed';
      item.claimed_by = fallbackAgent;
      item.claimed_at = now();
      store.saveLeadQueueItem(item);
      ensureContributionScore(fallbackAgent, item.listing_id);
      assignBrokerToInquiry(item, fallbackAgent);
      console.log(`[cascade] Auto-assigned: ${item.id} → ${fallbackAgent} (fallback after all tiers expired)`);

      // Notify the auto-assigned agent
      const push = getPush();
      if (push) {
        push.notify(fallbackAgent, {
          title: '📋 Lead asignado automáticamente',
          body: `${item.buyer_name || 'Un cliente'} fue asignado a ti porque nadie reclamó a tiempo.`,
          url: '/broker',
          type: 'lead_cascade',
          data: { leadQueueId: item.id, listingId: item.listing_id, autoAssigned: true },
        }).catch(() => {});
      }
      return;
    }

    // Truly no agents available — auto-respond to buyer
    item.status = 'auto_responded';
    item.auto_responded_at = now();
    store.saveLeadQueueItem(item);
    sendAutoResponse(item);
    console.log(`[cascade] Auto-responded: ${item.id} — no agents available`);
    return;
  }

  // Advance to next tier
  item.current_tier = nextTier;
  item[`tier${nextTier}_notified_at`] = now();
  store.saveLeadQueueItem(item);

  // Notify
  notifyAgents(allTiers[nextTier], item, listing, nextTier);

  // Schedule next escalation
  scheduleEscalation(item.id, CASCADE_WINDOW_MS);

  console.log(`[cascade] Escalated: ${item.id} → tier ${nextTier} (${allTiers[nextTier].length} agents)`);
}

// ── Timer management ────────────────────────────────────────────────────

function scheduleEscalation(leadQueueId, delayMs) {
  clearEscalation(leadQueueId);
  const timerId = setTimeout(() => {
    _timers.delete(leadQueueId);
    escalateTier(leadQueueId);
  }, delayMs);
  _timers.set(leadQueueId, timerId);
}

function clearEscalation(leadQueueId) {
  const timerId = _timers.get(leadQueueId);
  if (timerId) {
    clearTimeout(timerId);
    _timers.delete(leadQueueId);
  }
}

/**
 * Recovery function — called on startup and every 30s.
 * Reschedules timers for active cascades whose timers were lost.
 */
function recoverStaleCascades() {
  const active = store.getActiveLeadQueue();
  const nowMs = Date.now();

  for (const item of active) {
    if (_timers.has(item.id)) continue; // Timer already running

    const tierField = `tier${item.current_tier}_notified_at`;
    const notifiedAt = item[tierField];
    if (!notifiedAt) {
      // No notification timestamp — escalate immediately
      escalateTier(item.id);
      continue;
    }

    const elapsed = nowMs - new Date(notifiedAt).getTime();
    const remaining = CASCADE_WINDOW_MS - elapsed;

    if (remaining <= 0) {
      // Window has passed — escalate now
      escalateTier(item.id);
    } else {
      // Window still open — reschedule remaining time
      scheduleEscalation(item.id, remaining);
    }
  }
}

// ── Broker assignment helpers ───────────────────────────────────────────

function assignBrokerToInquiry(item, userId) {
  const user = store.getUserById(userId);
  if (!user) return;

  const brokerObj = {
    user_id: userId,
    name: user.name || '',
    agency_name: user.agency?.name || user.inmobiliaria_name || '',
    email: user.email || '',
    phone: user.phone || '',
  };

  if (item.inquiry_type === 'application') {
    const app = store.getApplicationById(item.inquiry_id);
    if (app) {
      app.broker = brokerObj;
      app.broker_id = userId;
      app.inmobiliaria_id = user.inmobiliaria_id || null;
      store.saveApplication(app);
    }
  } else if (item.inquiry_type === 'conversation') {
    const conv = store.getConversationById(item.inquiry_id);
    if (conv) {
      conv.brokerId = userId;
      conv.brokerName = user.name || '';
      // Notify the client that an agent has been assigned
      const crypto = require('crypto');
      conv.messages.push({
        id:         'msg_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        senderId:   'system',
        senderRole: 'system',
        senderName: 'HogaresRD',
        text:       `${user.name || 'Un agente'} ha sido asignado a tu consulta y te responderá pronto.`,
        timestamp:  new Date().toISOString(),
      });
      conv.updatedAt = new Date().toISOString();
      store.saveConversation(conv);
    }
  } else if (item.inquiry_type === 'lead') {
    // Leads table doesn't have a broker column — update via direct SQL
    store.pool.query(
      `UPDATE leads SET status = 'en_proceso', _extra = jsonb_set(COALESCE(_extra, '{}'), '{claimed_by}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ user_id: userId, name: user.name, email: user.email, phone: user.phone }), item.inquiry_id]
    ).catch(err => console.error('[cascade] Lead update error:', err.message));
  }
}

/**
 * Ensure a contribution score record exists for an agent on a listing.
 * Auto-creates with score 0 if missing (handles late affiliations, post-backfill agents).
 */
function ensureContributionScore(userId, listingId) {
  if (store.getContributionScore(userId, listingId)) return;
  store.saveContributionScore({
    id: 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    user_id: userId,
    listing_id: listingId,
    role: 'affiliate',
    score: 0,
    score_breakdown: {},
    avg_response_ms: null,
    response_count: 0,
    created_at: now(),
    updated_at: now(),
    _extra: {},
  });
}

function updateAgentResponseTime(userId, listingId, responseMs) {
  const cs = store.getContributionScore(userId, listingId);
  if (!cs) return;

  const count = (cs.response_count || 0) + 1;
  const prevAvg = cs.avg_response_ms || responseMs;
  const newAvg = Math.round(((prevAvg * (count - 1)) + responseMs) / count);

  cs.avg_response_ms = newAvg;
  cs.response_count = count;
  cs.updated_at = now();

  // Bonus: fast responder gets +10 if avg < 2 min
  const breakdown = cs.score_breakdown || {};
  if (newAvg < 120000 && !breakdown.fast_responder) {
    breakdown.fast_responder = 10;
    cs.score = Object.values(breakdown).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    cs.score_breakdown = breakdown;
  }

  store.saveContributionScore(cs);
}

// ── Feature flag ────────────────────────────────────────────────────────

function isEnabled() {
  return process.env.ENABLE_CASCADE === 'true' || process.env.ENABLE_CASCADE === '1';
}

module.exports = {
  startCascade,
  claimLead,
  escalateTier,
  recoverStaleCascades,
  getTierAgents,
  isEnabled,
  CASCADE_WINDOW_MS,
  CONTRIB_THRESHOLD,
};
