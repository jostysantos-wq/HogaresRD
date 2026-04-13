// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Cascading Priority Lead Distribution Engine
//
// 3-tier system with time-aware windows:
//   Tier 1: Listing creator (exclusive) — most time (highest priority agent)
//   Tier 2: Contributing affiliates (score >= 10) — less time
//   Tier 3: All remaining affiliates (first-to-claim) — least time (lead is getting cold)
//   Tier 4: Auto-response to buyer
//
// Cascade windows (8 AM – 11 PM AST):
//   Tier 1: 15 min  |  Tier 2: 10 min  |  Tier 3: 5 min  (30 min total)
//
// Overnight freeze (11 PM – 8 AM):
//   Cascade pauses. The lead stays with whatever tier it's currently in.
//   When business hours resume at 8 AM, the timer starts fresh for that
//   tier — like the stock market closing and reopening.
//
// Uses in-memory timers (setTimeout) with cron-based crash recovery.
// ══════════════════════════════════════════════════════════════════════════

const store = require('./store');
const et    = require('../utils/email-templates');
const { isSubscriptionActive } = require('../utils/subscription-gate');

const CONTRIB_THRESHOLD = 10;            // Minimum score for Tier 2

// ── Time-aware cascade windows (Dominican Republic, AST = UTC-4) ────────
const MARKET_OPEN  = 8;   // 8 AM — cascade timers start/resume
const MARKET_CLOSE = 23;  // 11 PM — cascade freezes overnight
const TZ_OFFSET_HOURS = -4; // AST (Atlantic Standard Time)

// Tier durations in milliseconds — higher tier = more time (they're more important)
const TIER_WINDOWS = { 1: 15 * 60_000, 2: 10 * 60_000, 3: 5 * 60_000 };

/** Get the current hour in Dominican Republic (0-23) */
function getLocalHour() {
  return (new Date().getUTCHours() + 24 + TZ_OFFSET_HOURS) % 24;
}

/** Returns true during active cascade hours (8 AM – 11 PM, any day) */
function isMarketOpen() {
  const h = getLocalHour();
  return h >= MARKET_OPEN && h < MARKET_CLOSE;
}

/**
 * Get the cascade window in ms for a given tier.
 * During market hours: returns the tier's configured window.
 * During overnight freeze: returns ms until 8 AM (timer sleeps until open).
 */
function getCascadeWindowMs(tier) {
  if (isMarketOpen()) {
    return TIER_WINDOWS[tier] || TIER_WINDOWS[3];
  }
  // Overnight: calculate ms until next 8 AM
  return msUntilMarketOpen();
}

/** Calculate milliseconds until the next 8 AM AST */
function msUntilMarketOpen() {
  const now = new Date();
  // Build a Date for 8 AM AST today (or tomorrow if past 8 AM)
  const target = new Date(now);
  // Set to 8 AM in UTC terms (8 AM AST = 12 PM UTC)
  target.setUTCHours(MARKET_OPEN - TZ_OFFSET_HOURS, 0, 0, 0);
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 1); // next day
  }
  return target.getTime() - now.getTime();
}

// Legacy constant for recovery calculations
const CASCADE_WINDOW_MS = 15 * 60 * 1000; // 15 min fallback (matches Tier 1)

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
 *
 * @param {object} listing — the listing object
 * @param {string|null} inmobiliariaScope — if set, restrict ALL tiers to
 *   agents belonging to this inmobiliaria. Used when leads arrive through
 *   an inmobiliaria's affiliate link: the cascade should only rotate among
 *   that inmobiliaria's team, not the listing's full agency set.
 */
function getTierAgents(listing, inmobiliariaScope = null) {
  const creatorId = listing.creator_user_id || null;
  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  let allAgentIds = agencies.map(a => a.user_id).filter(Boolean);

  // If scoped to an inmobiliaria, restrict to only that org's agents
  if (inmobiliariaScope) {
    const teamMembers = store.getUsersByInmobiliaria(inmobiliariaScope);
    const teamIds = new Set(teamMembers.map(u => u.id));
    // Also include the inmobiliaria owner themselves
    teamIds.add(inmobiliariaScope);
    allAgentIds = allAgentIds.filter(id => teamIds.has(id));
    // If none of the listing's agencies are in this inmobiliaria,
    // use the full team as the candidate pool instead
    if (allAgentIds.length === 0) {
      allAgentIds = [...teamIds];
    }
  }

  // Exclude agents without active subscriptions — they can't respond to leads
  allAgentIds = allAgentIds.filter(id => {
    const u = store.getUserById(id);
    return u && isSubscriptionActive(u);
  });

  // Tier 1: creator only (if in scope and subscribed)
  const tier1 = (creatorId && allAgentIds.includes(creatorId)) ? [creatorId] : [];

  // Tier 2: contributors with score >= threshold, excluding creator
  const scores = store.getContributionScoresForListing(listing.id);
  const tier2 = scores
    .filter(s => s.score >= CONTRIB_THRESHOLD && s.user_id !== creatorId && allAgentIds.includes(s.user_id))
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
      body: `${item.buyer_name || 'Un cliente'} está interesado en "${listing.title || 'una propiedad'}". ${isMarketOpen() ? `Tienes ${Math.round((TIER_WINDOWS[tierNum] || TIER_WINDOWS[3]) / 60_000)} minutos para responder.` : 'Responde cuando abras — el timer inicia a las 8 AM.'}`,
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
    subject: `Tu consulta sobre "${title}" - HogaresRD`,
    html: et.layout({
      title: 'Recibimos tu consulta',
      subtitle: title,
      preheader: `Recibimos tu consulta sobre ${title}. Un agente se comunicara contigo pronto.`,
      body: [
        et.p(`Hola ${et.esc(item.buyer_name || '')},`),
        et.p(`Recibimos tu consulta sobre <strong>${et.esc(title)}</strong>. Un agente de nuestro equipo se pondra en contacto contigo lo antes posible.`),
        et.divider(),
        et.p('Si necesitas atencion inmediata, puedes escribirnos directamente por WhatsApp:'),
        et.button('Contactar por WhatsApp', 'https://wa.me/18094440000'),
        et.small('Horario de atencion: lunes a sabado, 8:00 AM - 6:00 PM'),
      ].join('\n'),
    }),
  }).catch(err => console.error('[cascade] Auto-response email error:', err.message));
}

// ── Core cascade logic ──────────────────────────────────────────────────

/**
 * Start a new cascade for a buyer inquiry.
 * @param {'application'|'lead'|'conversation'} inquiryType
 * @param {string} inquiryId
 * @param {string} listingId
 * @param {{ name?: string, phone?: string, email?: string }} buyerInfo
 * @param {string|null} inmobiliariaScope — if set, restrict cascade to
 *   agents belonging to this inmobiliaria only. Used for inmobiliaria
 *   affiliate links where the lead should rotate within the org's team.
 * @returns {object|null} The created lead_queue item, or null if cascade not applicable
 */
function startCascade(inquiryType, inquiryId, listingId, buyerInfo = {}, inmobiliariaScope = null) {
  const listing = store.getListingById(listingId);
  if (!listing) {
    console.warn('[cascade] Listing not found:', listingId);
    return null;
  }

  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  if (agencies.length === 0 && !inmobiliariaScope) {
    console.log('[cascade] No agencies on listing, skipping cascade:', listingId);
    return null;
  }

  const { tier1, tier2, tier3 } = getTierAgents(listing, inmobiliariaScope);

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
    inmobiliaria_scope: inmobiliariaScope || null,
    created_at: now(),
  };

  store.saveLeadQueueItem(item);

  const agentsByTier = { 1: tier1, 2: tier2, 3: tier3 };

  if (isMarketOpen()) {
    // Market is open — start the cascade timer normally
    item[`tier${startTier}_notified_at`] = now();
    store.saveLeadQueueItem(item);
    notifyAgents(agentsByTier[startTier], item, listing, startTier);
    const windowMs = TIER_WINDOWS[startTier] || TIER_WINDOWS[3];
    scheduleEscalation(item.id, windowMs);
    console.log(`[cascade] Started: ${item.id} for ${inquiryType}/${inquiryId} → tier ${startTier} (${agentsByTier[startTier].length} agents, ${Math.round(windowMs / 60_000)}min)`);
  } else {
    // Market is closed — send push notification (agent might see it)
    // but DON'T start the timer. Timer will start at 8 AM.
    // tier_notified_at stays null so morning wake-up logic gives a fresh window.
    notifyAgents(agentsByTier[startTier], item, listing, startTier);
    const sleepMs = msUntilMarketOpen();
    scheduleEscalation(item.id, sleepMs);
    const sleepHrs = Math.round(sleepMs / 3_600_000 * 10) / 10;
    console.log(`[cascade] Started overnight: ${item.id} for ${inquiryType}/${inquiryId} → tier ${startTier} (frozen, timer starts in ${sleepHrs}h at 8 AM)`);
  }
  return item;
}

/**
 * Agent claims a lead from the queue.
 * @param {string} leadQueueId
 * @param {string} userId
 * @returns {{ success: boolean, error?: string }}
 */
async function claimLead(leadQueueId, userId) {
  // In-memory lock (single-process) + DB-level atomic update (cluster-safe)
  if (_claimLocks.has(leadQueueId)) {
    return { success: false, error: 'Este lead está siendo procesado.' };
  }
  _claimLocks.add(leadQueueId);

  try {
    // Atomic DB claim: only succeeds if status is still 'active'
    // This prevents double-claims even across multiple Node processes
    const dbResult = await store.pool.query(
      `UPDATE lead_queue SET status = 'claimed', claimed_by = $1, claimed_at = $2
       WHERE id = $3 AND status = 'active' RETURNING id`,
      [userId, now(), leadQueueId]
    ).catch(() => ({ rowCount: 0 }));

    if (!dbResult.rowCount) {
      return { success: false, error: 'Este lead ya fue reclamado.' };
    }

    const item = store.getLeadQueueById(leadQueueId);
    if (!item) return { success: false, error: 'Lead no encontrado.' };
    // Update in-memory cache to match DB
    item.status = 'claimed';
    item.claimed_by = userId;
    item.claimed_at = now();

    const listing = store.getListingById(item.listing_id);
    if (!listing) return { success: false, error: 'Propiedad no encontrada.' };

    // Validate agent is eligible for current tier (respecting inmobiliaria scope)
    const { tier1, tier2, tier3 } = getTierAgents(listing, item.inmobiliaria_scope || null);
    const currentTierAgents = { 1: tier1, 2: tier2, 3: tier3 }[item.current_tier] || [];

    if (!currentTierAgents.includes(userId)) {
      return { success: false, error: 'No tienes prioridad para reclamar este lead en la ronda actual.' };
    }

    // Sync in-memory cache (DB already updated atomically above)
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
 * If the market is closed (11 PM – 8 AM), the cascade freezes
 * in the current tier and re-schedules to fire at 8 AM.
 */
function escalateTier(leadQueueId) {
  const item = store.getLeadQueueById(leadQueueId);
  if (!item || item.status !== 'active') return;

  // Overnight freeze: if market is closed, don't advance — sleep until 8 AM
  if (!isMarketOpen()) {
    const sleepMs = msUntilMarketOpen();
    const sleepHrs = Math.round(sleepMs / 3_600_000 * 10) / 10;
    console.log(`[cascade] Frozen overnight: ${item.id} stays in tier ${item.current_tier}, resuming in ${sleepHrs}h at 8 AM`);
    // Reset the notification timestamp so the full tier window restarts at 8 AM
    item[`tier${item.current_tier}_notified_at`] = null;
    store.saveLeadQueueItem(item);
    scheduleEscalation(item.id, sleepMs);
    return;
  }

  const listing = store.getListingById(item.listing_id);
  if (!listing) return;

  const { tier1, tier2, tier3 } = getTierAgents(listing, item.inmobiliaria_scope || null);
  const allTiers = { 1: tier1, 2: tier2, 3: tier3 };

  // Morning wake-up: if tier_notified_at is null, this is resuming after
  // overnight freeze. Re-notify the CURRENT tier with a fresh timer.
  const currentTierField = `tier${item.current_tier}_notified_at`;
  if (!item[currentTierField]) {
    item[currentTierField] = now();
    store.saveLeadQueueItem(item);
    const agents = allTiers[item.current_tier] || [];
    if (agents.length) notifyAgents(agents, item, listing, item.current_tier);
    const windowMs = TIER_WINDOWS[item.current_tier] || TIER_WINDOWS[3];
    scheduleEscalation(item.id, windowMs);
    console.log(`[cascade] Morning resume: ${item.id} → tier ${item.current_tier} (${agents.length} agents, ${Math.round(windowMs / 60_000)}min)`);
    return;
  }

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

  // Schedule next escalation (time-aware window for this tier)
  const windowMs = getCascadeWindowMs(nextTier);
  scheduleEscalation(item.id, windowMs);

  const windowMin = Math.round(windowMs / 60_000);
  console.log(`[cascade] Escalated: ${item.id} → tier ${nextTier} (${allTiers[nextTier].length} agents, ${windowMin}min window)`);
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

    // If market is closed, freeze everything until 8 AM
    if (!isMarketOpen()) {
      const sleepMs = msUntilMarketOpen();
      scheduleEscalation(item.id, sleepMs);
      continue;
    }

    const tierField = `tier${item.current_tier}_notified_at`;
    const notifiedAt = item[tierField];
    if (!notifiedAt) {
      // No notification timestamp — morning wake-up or fresh start
      escalateTier(item.id);
      continue;
    }

    const elapsed = nowMs - new Date(notifiedAt).getTime();
    const tierWindow = TIER_WINDOWS[item.current_tier] || TIER_WINDOWS[3];
    const remaining = tierWindow - elapsed;

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
  TIER_WINDOWS,
  CONTRIB_THRESHOLD,
};
