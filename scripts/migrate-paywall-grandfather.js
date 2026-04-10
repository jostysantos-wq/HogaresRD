#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Grandfather existing users from paywall
//
// Run ONCE immediately BEFORE deploying the paywall feature:
//   node scripts/migrate-paywall-grandfather.js
//
// This sets paywallRequired=false on all existing users so that:
//   - Current legacy trial users continue to have free access until their
//     trial expires.
//   - Existing paid/active subscribers remain unaffected.
//   - Only NEW signups after the deploy (which get paywallRequired=true
//     from routes/auth.js) will be forced into the Stripe Checkout flow.
//
// Safe to re-run — idempotent. Only users with paywallRequired === undefined
// are modified.
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const store = require('../routes/store');

async function waitForCache(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (store.getUsers().length > 0) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function migrate() {
  console.log('[paywall-migration] Waiting for cache to load...');
  const ready = await waitForCache();
  if (!ready) {
    console.error('[paywall-migration] Cache did not load within 30s. Check DATABASE_URL.');
    process.exit(1);
  }

  const users = store.getUsers();
  console.log(`[paywall-migration] Loaded ${users.length} users.`);

  let grandfathered = 0;
  let alreadySet    = 0;
  let skippedNonPro = 0;

  const proRoles = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];

  for (const u of users) {
    if (!proRoles.includes(u.role)) { skippedNonPro++; continue; }
    if (u.paywallRequired === undefined || u.paywallRequired === null) {
      u.paywallRequired = false;
      store.saveUser(u);
      grandfathered++;
      console.log(`  [grandfathered] ${u.email} (${u.role}) — status=${u.subscriptionStatus || 'none'}`);
    } else {
      alreadySet++;
    }
  }

  console.log('');
  console.log('[paywall-migration] Done.');
  console.log(`  Grandfathered:     ${grandfathered}`);
  console.log(`  Already set:       ${alreadySet}`);
  console.log(`  Non-pro (skipped): ${skippedNonPro}`);
  console.log('');
  console.log('[paywall-migration] All new signups after this deploy will be paywalled.');

  process.exit(0);
}

migrate().catch(err => {
  console.error('[paywall-migration] Fatal error:', err);
  process.exit(1);
});
