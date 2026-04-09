#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Cascade System Integration Test
//
// Seeds test users + listing, then exercises the full cascade flow.
// Run: node scripts/test-cascade.js
//
// NOTE: Runs against the in-memory cache only (no PG needed).
//       Sets ENABLE_CASCADE=true for the test.
// ══════════════════════════════════════════════════════════════════════════

process.env.ENABLE_CASCADE = 'true';

const store = require('../routes/store');
const cascade = require('../routes/cascade-engine');

// ── Test helpers ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function section(title) { console.log(`\n══ ${title} ══`); }

// ── Seed data ───────────────────────────────────────────────────────────

const CREATOR_ID   = 'test_creator_001';
const CONTRIB_ID   = 'test_contrib_002';
const AFFILIATE_ID = 'test_affiliate_003';
const BUYER_ID     = 'test_buyer_004';
const LISTING_ID   = 'test_listing_001';

function seedTestData() {
  section('SEEDING TEST DATA');

  // Create users
  store.saveUser({
    id: CREATOR_ID,
    email: 'creator@test.com',
    name: 'Maria Creator',
    phone: '8091111111',
    role: 'agency',
    agency: { name: 'Inmobiliaria MC', license: 'L001', phone: '8091111111' },
    passwordHash: 'test',
    createdAt: new Date().toISOString(),
  });
  console.log('  → Seeded user: Maria Creator (listing creator)');

  store.saveUser({
    id: CONTRIB_ID,
    email: 'contributor@test.com',
    name: 'Juan Contributor',
    phone: '8092222222',
    role: 'broker',
    agency: { name: 'RE/MAX Test', license: 'L002', phone: '8092222222' },
    passwordHash: 'test',
    createdAt: new Date().toISOString(),
  });
  console.log('  → Seeded user: Juan Contributor (contributing affiliate)');

  store.saveUser({
    id: AFFILIATE_ID,
    email: 'affiliate@test.com',
    name: 'Ana Affiliate',
    phone: '8093333333',
    role: 'agency',
    agency: { name: 'Century Test', license: 'L003', phone: '8093333333' },
    passwordHash: 'test',
    createdAt: new Date().toISOString(),
  });
  console.log('  → Seeded user: Ana Affiliate (tagged affiliate)');

  store.saveUser({
    id: BUYER_ID,
    email: 'buyer@test.com',
    name: 'Carlos Buyer',
    phone: '8094444444',
    role: 'user',
    passwordHash: 'test',
    createdAt: new Date().toISOString(),
  });
  console.log('  → Seeded user: Carlos Buyer');

  // Create listing with creator + 2 affiliates
  store.saveListing({
    id: LISTING_ID,
    title: 'Test Villa con Piscina',
    type: 'Villa',
    condition: 'Excelente estado',
    description: 'Villa de prueba para test cascade.',
    price: '500000',
    province: 'Samaná',
    city: 'Las Terrenas',
    status: 'approved',
    creator_user_id: CREATOR_ID,
    agencies: [
      { user_id: CREATOR_ID, name: 'Inmobiliaria MC', email: 'creator@test.com', phone: '8091111111' },
      { user_id: CONTRIB_ID, name: 'RE/MAX Test', email: 'contributor@test.com', phone: '8092222222' },
      { user_id: AFFILIATE_ID, name: 'Century Test', email: 'affiliate@test.com', phone: '8093333333' },
    ],
    submittedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  });
  console.log('  → Seeded listing: Test Villa con Piscina');

  // Create contribution scores
  const nowIso = new Date().toISOString();

  store.saveContributionScore({
    id: 'cs_test_creator',
    user_id: CREATOR_ID,
    listing_id: LISTING_ID,
    role: 'creator',
    score: 50,
    score_breakdown: { created_listing: 50 },
    avg_response_ms: null,
    response_count: 0,
    created_at: nowIso,
    updated_at: nowIso,
    _extra: {},
  });

  store.saveContributionScore({
    id: 'cs_test_contrib',
    user_id: CONTRIB_ID,
    listing_id: LISTING_ID,
    role: 'contributor',
    score: 15,
    score_breakdown: { shared_listing: 15 },
    avg_response_ms: null,
    response_count: 0,
    created_at: nowIso,
    updated_at: nowIso,
    _extra: {},
  });

  store.saveContributionScore({
    id: 'cs_test_affiliate',
    user_id: AFFILIATE_ID,
    listing_id: LISTING_ID,
    role: 'affiliate',
    score: 0,
    score_breakdown: {},
    avg_response_ms: null,
    response_count: 0,
    created_at: nowIso,
    updated_at: nowIso,
    _extra: {},
  });

  console.log('  → Seeded contribution scores: Creator=50, Contributor=15, Affiliate=0');
}

// ── Tests ───────────────────────────────────────────────────────────────

function testFeatureFlag() {
  section('TEST 1: Feature Flag');
  assert(cascade.isEnabled() === true, 'isEnabled() returns true when ENABLE_CASCADE=true');

  process.env.ENABLE_CASCADE = 'false';
  assert(cascade.isEnabled() === false, 'isEnabled() returns false when ENABLE_CASCADE=false');

  process.env.ENABLE_CASCADE = 'true';
  assert(cascade.isEnabled() === true, 'isEnabled() restored to true');
}

function testTierIdentification() {
  section('TEST 2: Tier Identification');

  const listing = store.getListingById(LISTING_ID);
  assert(listing !== null, 'Test listing exists in cache');
  assert(listing.creator_user_id === CREATOR_ID, 'Listing has correct creator_user_id');

  const { tier1, tier2, tier3 } = cascade.getTierAgents(listing);

  assert(tier1.length === 1, `Tier 1 has 1 agent (creator): ${tier1.join(', ')}`);
  assert(tier1[0] === CREATOR_ID, 'Tier 1 contains the creator');

  assert(tier2.length === 1, `Tier 2 has 1 agent (contributor with score >= 10): ${tier2.join(', ')}`);
  assert(tier2[0] === CONTRIB_ID, 'Tier 2 contains the contributor');

  assert(tier3.length === 1, `Tier 3 has 1 agent (remaining affiliate): ${tier3.join(', ')}`);
  assert(tier3[0] === AFFILIATE_ID, 'Tier 3 contains the affiliate');
}

function testStartCascade() {
  section('TEST 3: Start Cascade');

  const item = cascade.startCascade('lead', 'test_lead_001', LISTING_ID, {
    name: 'Carlos Buyer',
    phone: '8094444444',
    email: 'buyer@test.com',
  });

  assert(item !== null, 'startCascade returns a lead_queue item');
  assert(item.current_tier === 1, 'Cascade starts at tier 1');
  assert(item.status === 'active', 'Status is active');
  assert(item.tier1_notified_at !== null, 'Tier 1 notification timestamp set');
  assert(item.buyer_name === 'Carlos Buyer', 'Buyer name captured');

  // Verify it's in the store
  const stored = store.getLeadQueueById(item.id);
  assert(stored !== null, 'Lead queue item saved in cache');
  assert(stored.status === 'active', 'Stored status is active');
}

function testClaimByCreator() {
  section('TEST 4: Claim by Creator (Tier 1)');

  // Start a new cascade
  const item = cascade.startCascade('lead', 'test_lead_002', LISTING_ID, {
    name: 'Another Buyer',
    email: 'buyer2@test.com',
  });

  // Creator claims it
  const result = cascade.claimLead(item.id, CREATOR_ID);
  assert(result.success === true, 'Creator successfully claims lead');

  const updated = store.getLeadQueueById(item.id);
  assert(updated.status === 'claimed', 'Status changed to claimed');
  assert(updated.claimed_by === CREATOR_ID, 'claimed_by is creator');
  assert(updated.claimed_at !== null, 'claimed_at timestamp set');
}

function testClaimByWrongTier() {
  section('TEST 5: Claim Rejected for Wrong Tier');

  const item = cascade.startCascade('lead', 'test_lead_003', LISTING_ID, {
    name: 'Third Buyer',
  });

  // Affiliate tries to claim during Tier 1
  const result = cascade.claimLead(item.id, AFFILIATE_ID);
  assert(result.success === false, 'Affiliate cannot claim during Tier 1');
  assert(result.error.includes('prioridad'), 'Error message mentions priority');

  // Contributor also can't claim during Tier 1
  const result2 = cascade.claimLead(item.id, CONTRIB_ID);
  assert(result2.success === false, 'Contributor cannot claim during Tier 1');

  // Clean up — escalate and claim by creator
  cascade.claimLead(item.id, CREATOR_ID);
}

function testDoubleClaim() {
  section('TEST 6: Double Claim Prevention');

  const item = cascade.startCascade('lead', 'test_lead_004', LISTING_ID, {
    name: 'Fourth Buyer',
  });

  // Creator claims
  const r1 = cascade.claimLead(item.id, CREATOR_ID);
  assert(r1.success === true, 'First claim succeeds');

  // Try to claim again
  const r2 = cascade.claimLead(item.id, CREATOR_ID);
  assert(r2.success === false, 'Second claim rejected');
  assert(r2.error.includes('reclamado'), 'Error says already claimed');
}

function testEscalation() {
  section('TEST 7: Tier Escalation');

  const item = cascade.startCascade('lead', 'test_lead_005', LISTING_ID, {
    name: 'Fifth Buyer',
  });

  assert(item.current_tier === 1, 'Starts at tier 1');

  // Manually trigger escalation (simulates 5-min timeout)
  cascade.escalateTier(item.id);

  const updated1 = store.getLeadQueueById(item.id);
  assert(updated1.current_tier === 2, 'Escalated to tier 2');
  assert(updated1.tier2_notified_at !== null, 'Tier 2 notification timestamp set');
  assert(updated1.status === 'active', 'Still active');

  // Escalate again
  cascade.escalateTier(item.id);

  const updated2 = store.getLeadQueueById(item.id);
  assert(updated2.current_tier === 3, 'Escalated to tier 3');
  assert(updated2.tier3_notified_at !== null, 'Tier 3 notification timestamp set');

  // Escalate past all tiers → auto-assign fallback to creator (first eligible)
  cascade.escalateTier(item.id);

  const updated3 = store.getLeadQueueById(item.id);
  assert(updated3.status === 'claimed', 'Auto-assigned to first eligible agent after all tiers');
  assert(updated3.claimed_by === CREATOR_ID, 'Auto-assigned to creator (highest priority fallback)');
  assert(updated3.claimed_at !== null, 'Auto-assign timestamp set');
}

function testClaimAfterEscalation() {
  section('TEST 8: Claim at Tier 2 by Contributor');

  const item = cascade.startCascade('lead', 'test_lead_006', LISTING_ID, {
    name: 'Sixth Buyer',
  });

  // Escalate to tier 2
  cascade.escalateTier(item.id);

  // Contributor claims at tier 2
  const result = cascade.claimLead(item.id, CONTRIB_ID);
  assert(result.success === true, 'Contributor claims at tier 2');

  const updated = store.getLeadQueueById(item.id);
  assert(updated.claimed_by === CONTRIB_ID, 'Claimed by contributor');

  // Verify response time was tracked
  const cs = store.getContributionScore(CONTRIB_ID, LISTING_ID);
  assert(cs.response_count > 0, `Contributor response tracked (count: ${cs.response_count})`);
  assert(cs.avg_response_ms !== null, `Avg response time: ${cs.avg_response_ms}ms`);
}

function testEmptyTierSkip() {
  section('TEST 9: Skip Empty Tiers');

  // Create a listing with only creator (no affiliates)
  const soloListingId = 'test_listing_solo';
  store.saveListing({
    id: soloListingId,
    title: 'Solo Agent Listing',
    type: 'Apartamento',
    condition: 'Buen estado',
    price: '100000',
    status: 'approved',
    creator_user_id: CREATOR_ID,
    agencies: [
      { user_id: CREATOR_ID, name: 'Inmobiliaria MC', email: 'creator@test.com', phone: '8091111111' },
    ],
    submittedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  });

  store.saveContributionScore({
    id: 'cs_test_solo_creator',
    user_id: CREATOR_ID,
    listing_id: soloListingId,
    role: 'creator',
    score: 50,
    score_breakdown: { created_listing: 50 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    _extra: {},
  });

  const listing = store.getListingById(soloListingId);
  const { tier1, tier2, tier3 } = cascade.getTierAgents(listing);

  assert(tier1.length === 1, 'Solo listing: tier 1 has creator');
  assert(tier2.length === 0, 'Solo listing: tier 2 is empty');
  assert(tier3.length === 0, 'Solo listing: tier 3 is empty');

  // Start cascade + escalate past tier 1
  const item = cascade.startCascade('lead', 'test_lead_solo', soloListingId, { name: 'Solo Buyer' });
  assert(item.current_tier === 1, 'Solo cascade starts at tier 1');

  cascade.escalateTier(item.id);

  const updated = store.getLeadQueueById(item.id);
  assert(updated.status === 'claimed', 'Solo listing: skips empty tiers 2&3, auto-assigns to creator');
  assert(updated.claimed_by === CREATOR_ID, 'Solo listing: auto-assigned to creator');
}

function testApplicationCascade() {
  section('TEST 10: Application Inquiry Type');

  // Simulate saving an application first
  store.saveApplication({
    id: 'test_app_001',
    listing_id: LISTING_ID,
    listing_title: 'Test Villa con Piscina',
    listing_price: '500000',
    client: { user_id: BUYER_ID, name: 'Carlos Buyer', email: 'buyer@test.com', phone: '8094444444' },
    broker: { user_id: null, name: 'Pendiente', agency_name: '', email: '', phone: '' },
    status: 'aplicado',
    created_at: new Date().toISOString(),
  });

  const item = cascade.startCascade('application', 'test_app_001', LISTING_ID, {
    name: 'Carlos Buyer',
    email: 'buyer@test.com',
  });

  // Creator claims the application
  const result = cascade.claimLead(item.id, CREATOR_ID);
  assert(result.success === true, 'Creator claims application lead');

  // Verify application broker was updated
  const app = store.getApplicationById('test_app_001');
  assert(app.broker.user_id === CREATOR_ID, 'Application broker updated to creator');
  assert(app.broker.name === 'Maria Creator', 'Application broker name set');
  assert(app.broker_id === CREATOR_ID, 'Application broker_id set');
}

function testContributionScoreAutoCreate() {
  section('TEST 11: Auto-Create Contribution Score on Claim');

  // Create a new user with no existing score
  const newAgentId = 'test_new_agent_005';
  store.saveUser({
    id: newAgentId,
    email: 'newagent@test.com',
    name: 'New Agent',
    phone: '8095555555',
    role: 'agency',
    passwordHash: 'test',
    createdAt: new Date().toISOString(),
  });

  // Add new agent to listing agencies
  const listing = store.getListingById(LISTING_ID);
  listing.agencies.push({ user_id: newAgentId, name: 'New Agency', email: 'newagent@test.com', phone: '8095555555' });
  store.saveListing(listing);

  // Verify no score exists yet
  assert(store.getContributionScore(newAgentId, LISTING_ID) === null, 'New agent has no score initially');

  // Start cascade and escalate to tier 3 where new agent is eligible
  const item = cascade.startCascade('lead', 'test_lead_autoscore', LISTING_ID, { name: 'Score Test Buyer' });
  cascade.escalateTier(item.id); // → tier 2
  cascade.escalateTier(item.id); // → tier 3

  // New agent claims at tier 3
  const result = cascade.claimLead(item.id, newAgentId);
  assert(result.success === true, 'New agent claims at tier 3');

  // Verify score was auto-created
  const score = store.getContributionScore(newAgentId, LISTING_ID);
  assert(score !== null, 'Contribution score auto-created on claim');
  assert(score.role === 'affiliate', 'Auto-created score has affiliate role');
  assert(score.response_count > 0, 'Response was tracked on auto-created score');
}

function testAutoResponseNoAgents() {
  section('TEST 12b: Auto-Response When No Agents Exist');

  // Create a listing where agencies have no user_ids (anonymous submitter)
  const ghostListingId = 'test_listing_ghost';
  store.saveListing({
    id: ghostListingId,
    title: 'Ghost Listing',
    type: 'Casa',
    condition: 'Buen estado',
    price: '200000',
    status: 'approved',
    creator_user_id: null, // no creator
    agencies: [
      { name: 'Unknown Agency', email: 'anon@test.com', phone: '8090000000' }, // no user_id
    ],
    submittedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  });

  const result = cascade.startCascade('lead', 'test_lead_ghost', ghostListingId, { name: 'Ghost Buyer' });
  assert(result === null, 'Cascade returns null when no eligible agents (no user_ids on agencies)');
}

function testRecovery() {
  section('TEST 12: Stale Cascade Recovery');

  // Create a cascade that looks stale (notified 6 minutes ago)
  const staleItem = {
    id: 'lq_stale_test',
    inquiry_type: 'lead',
    inquiry_id: 'test_lead_stale',
    listing_id: LISTING_ID,
    buyer_name: 'Stale Buyer',
    buyer_phone: '',
    buyer_email: '',
    current_tier: 1,
    status: 'active',
    claimed_by: null,
    claimed_at: null,
    tier1_notified_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), // 11 min ago (past 10-min window)
    tier2_notified_at: null,
    tier3_notified_at: null,
    auto_responded_at: null,
    created_at: new Date().toISOString(),
  };
  store.saveLeadQueueItem(staleItem);

  // Run recovery
  cascade.recoverStaleCascades();

  const recovered = store.getLeadQueueById('lq_stale_test');
  assert(recovered.current_tier > 1, `Stale cascade escalated (now tier ${recovered.current_tier})`);
}

// ── Run all tests ───────────────────────────────────────────────────────

function run() {
  console.log('\n🧪 HOGARESRD CASCADE SYSTEM — INTEGRATION TESTS\n');
  console.log('Running against in-memory cache (no database required).\n');

  seedTestData();
  testFeatureFlag();
  testTierIdentification();
  testStartCascade();
  testClaimByCreator();
  testClaimByWrongTier();
  testDoubleClaim();
  testEscalation();
  testClaimAfterEscalation();
  testEmptyTierSkip();
  testApplicationCascade();
  testContributionScoreAutoCreate();
  testAutoResponseNoAgents();
  testRecovery();

  section('RESULTS');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log(failed === 0 ? '\n🎉 ALL TESTS PASSED!' : '\n⚠️  SOME TESTS FAILED!');

  process.exit(failed > 0 ? 1 : 0);
}

run();
