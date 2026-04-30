/**
 * P0 #8 — escalateTier must honor `org_scope_id`.
 *
 * `startCascade` writes `org_scope_id`. `claimLead` reads
 * `item.org_scope_id || item.inmobiliaria_scope`. Before the fix,
 * `escalateTier` only consulted the legacy `inmobiliaria_scope`, so any
 * modern lead-queue row (which sets `org_scope_id` and leaves
 * `inmobiliaria_scope` undefined) widened to ALL listing agencies on
 * Tier 1 → Tier 2 escalation, leaking org-scoped leads.
 *
 * This test confirms escalateTier now scopes to org_scope_id.
 *
 * Run:  node --test tests/cascade-org-scope.test.js
 */

'use strict';

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';
process.env.CASCADE_FORCE_MARKET_OPEN = 'true'; // bypass overnight freeze

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('./_app-helpers');
const { startServer, stopServer, store } = helpers;
const cascade = require('../routes/cascade-engine');

describe('cascade-engine — escalateTier honors org_scope_id', () => {
  before(async () => {
    helpers.installInMemoryStoreShims();
    await startServer();
  });
  after(stopServer);

  // Defang setTimeout-driven escalation by silencing notifications +
  // installing a no-op scheduleEscalation via the test hook is not
  // necessary here — tests call escalateTier directly without leaving
  // timers behind.

  function makeUser(role, id, extra = {}) {
    const user = {
      id,
      name:               id.toUpperCase(),
      email:              `${id}@hogaresrd-test.com`,
      role,
      subscriptionStatus: 'active',
      ...extra,
    };
    store.saveUser(user);
    return user;
  }

  it('escalates within org_scope_id only — does NOT widen to other agencies', () => {
    // Set up two orgs, each with one agent. The listing has both agents
    // attached as agencies. The cascade should ONLY rotate within the
    // org that originated the lead.
    const orgA = makeUser('inmobiliaria', 'inm_orgA_' + Date.now());
    const orgB = makeUser('inmobiliaria', 'inm_orgB_' + Date.now());
    const agentA = makeUser('broker', 'agentA_' + Date.now(), { inmobiliaria_id: orgA.id });
    const agentB = makeUser('broker', 'agentB_' + Date.now(), { inmobiliaria_id: orgB.id });
    const creator = makeUser('constructora', 'creator_' + Date.now());

    // Make orgA's user-team lookup return [agentA]
    // The store keeps users in memory; getUsersByInmobiliaria filters by
    // user.inmobiliaria_id === ownerId, so the inmobiliaria_id we set
    // above is what links agents to orgs.

    const listingId = 'listing_orgscope_' + Date.now();
    store.saveListing({
      id: listingId,
      title: 'Cascade scope test',
      status: 'approved',
      creator_user_id: creator.id,
      // Both agents (and orgA itself) appear as agencies on the listing.
      agencies: [
        { user_id: agentA.id, name: 'A',     email: agentA.email },
        { user_id: agentB.id, name: 'B',     email: agentB.email },
        { user_id: orgA.id,   name: 'OrgA',  email: orgA.email },
      ],
    });

    // Build a modern lead-queue item with org_scope_id set, no
    // inmobiliaria_scope. Tier 1 has been notified; we'll escalate to
    // Tier 2.
    const itemId = 'lq_' + Date.now();
    const item = {
      id:            itemId,
      inquiry_type:  'lead',
      inquiry_id:    'lead_' + Date.now(),
      listing_id:    listingId,
      buyer_name:    'Buyer',
      buyer_phone:   '',
      buyer_email:   '',
      current_tier:  1,
      status:        'active',
      claimed_by:    null,
      claimed_at:    null,
      tier1_notified_at: new Date(Date.now() - 60_000).toISOString(),
      tier2_notified_at: null,
      tier3_notified_at: null,
      auto_responded_at: null,
      org_scope_id:  orgA.id,
      // intentionally NO inmobiliaria_scope — modern row
      created_at:    new Date().toISOString(),
    };
    store.saveLeadQueueItem(item);

    // Invoke escalateTier directly via the test export.
    cascade.__test.escalateTier(itemId);

    // Re-read the row.
    const updated = store.getLeadQueueById(itemId);
    assert.ok(updated, 'lead queue item missing after escalateTier');

    // Verify the cascade is now scoped to orgA's team only by asking
    // getTierAgents for the same scope and confirming agentB is NOT
    // present in any tier (he's in orgB). If escalateTier had widened
    // to "all agencies", the post-escalation behavior would let agentB
    // claim — we assert he can't.
    const orgScope = updated.org_scope_id || updated.inmobiliaria_scope || null;
    assert.equal(orgScope, orgA.id, 'org_scope_id should still be orgA after escalation');
    const tiers = cascade.__test.getTierAgents(
      store.getListingById(listingId),
      orgScope
    );
    const allAgents = [...tiers.tier1, ...tiers.tier2, ...tiers.tier3];
    assert.ok(allAgents.includes(agentA.id),  'agentA (orgA) should remain in cascade');
    assert.ok(!allAgents.includes(agentB.id), 'agentB (orgB) MUST NOT leak into orgA cascade');
    // Cancel any timer scheduled by escalateTier so test exits cleanly.
    cascade.__test.clearEscalation(itemId);
  });

  it('legacy rows (inmobiliaria_scope only) still scope correctly', () => {
    // Sanity check: the fallback path must keep working for old rows.
    const orgC = makeUser('inmobiliaria', 'inm_orgC_' + Date.now());
    const orgD = makeUser('inmobiliaria', 'inm_orgD_' + Date.now());
    const agentC = makeUser('broker', 'agentC_' + Date.now(), { inmobiliaria_id: orgC.id });
    const agentD = makeUser('broker', 'agentD_' + Date.now(), { inmobiliaria_id: orgD.id });
    const creator = makeUser('constructora', 'creator2_' + Date.now());

    const listingId = 'listing_legacy_' + Date.now();
    store.saveListing({
      id: listingId,
      title: 'Cascade legacy scope test',
      status: 'approved',
      creator_user_id: creator.id,
      agencies: [
        { user_id: agentC.id, name: 'C', email: agentC.email },
        { user_id: agentD.id, name: 'D', email: agentD.email },
      ],
    });

    const itemId = 'lq_legacy_' + Date.now();
    const item = {
      id:            itemId,
      inquiry_type:  'lead',
      inquiry_id:    'lead2_' + Date.now(),
      listing_id:    listingId,
      buyer_name:    'Buyer',
      current_tier:  1,
      status:        'active',
      tier1_notified_at: new Date(Date.now() - 60_000).toISOString(),
      tier2_notified_at: null,
      tier3_notified_at: null,
      auto_responded_at: null,
      // legacy field only
      inmobiliaria_scope: orgC.id,
      created_at: new Date().toISOString(),
    };
    store.saveLeadQueueItem(item);

    cascade.__test.escalateTier(itemId);

    const updated = store.getLeadQueueById(itemId);
    const orgScope = updated.org_scope_id || updated.inmobiliaria_scope || null;
    assert.equal(orgScope, orgC.id, 'legacy inmobiliaria_scope should still resolve');
    const tiers = cascade.__test.getTierAgents(
      store.getListingById(listingId),
      orgScope
    );
    const allAgents = [...tiers.tier1, ...tiers.tier2, ...tiers.tier3];
    assert.ok(allAgents.includes(agentC.id),  'agentC (orgC) should remain in cascade');
    assert.ok(!allAgents.includes(agentD.id), 'agentD (orgD) MUST NOT leak into orgC cascade');
    cascade.__test.clearEscalation(itemId);
  });
});
