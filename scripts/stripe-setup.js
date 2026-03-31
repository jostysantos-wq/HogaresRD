/**
 * HogaresRD — Stripe Setup Script
 * ─────────────────────────────────
 * Creates the two subscription products + prices and writes the
 * resulting Price IDs into your .env file automatically.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.js
 *
 * Or add STRIPE_SECRET_KEY to .env first, then just run:
 *   node scripts/stripe-setup.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('\n❌  STRIPE_SECRET_KEY not set.');
  console.error('    Add it to your .env file or run:');
  console.error('    STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.js\n');
  process.exit(1);
}

const stripe = require('stripe')(key);
const ENV_FILE = path.join(__dirname, '..', '.env');

// ── Helpers ───────────────────────────────────────────────────────────────
function readEnv() {
  try { return fs.readFileSync(ENV_FILE, 'utf8'); } catch { return ''; }
}

function setEnvVar(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${key}=${value}`);
  }
  return content.trimEnd() + `\n${key}=${value}\n`;
}

function writeEnv(content) {
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀  HogaresRD — Stripe Setup');
  console.log('─'.repeat(40));
  const isLive = key.startsWith('sk_live_');
  console.log(`📍  Mode: ${isLive ? '🔴 LIVE' : '🟡 TEST (sandbox)'}`);
  console.log('');

  // ── 1. Create Plan Agente product ($10/month) ─────────────────────────
  console.log('Creating "Plan Agente" product ($10/month)...');
  const brokerProduct = await stripe.products.create({
    name:        'Plan Agente — HogaresRD',
    description: 'Acceso completo para agentes y brokers. Publica propiedades, gestiona clientes y accede a estadísticas.',
    metadata:    { role: 'broker', platform: 'hogaresrd' },
  });
  console.log(`  ✓ Product created: ${brokerProduct.id}`);

  const brokerPrice = await stripe.prices.create({
    product:    brokerProduct.id,
    unit_amount: 1000,       // $10.00 in cents
    currency:   'usd',
    recurring:  { interval: 'month' },
    nickname:   'Agente mensual',
    metadata:   { role: 'broker' },
  });
  console.log(`  ✓ Price created:   ${brokerPrice.id}  ($10.00/month)`);

  // ── 2. Create Plan Inmobiliaria product ($25/month) ───────────────────
  console.log('');
  console.log('Creating "Plan Inmobiliaria" product ($25/month)...');
  const inmProduct = await stripe.products.create({
    name:        'Plan Inmobiliaria — HogaresRD',
    description: 'Acceso empresarial para inmobiliarias. Gestión de equipo, dashboard centralizado y estadísticas por agente.',
    metadata:    { role: 'inmobiliaria', platform: 'hogaresrd' },
  });
  console.log(`  ✓ Product created: ${inmProduct.id}`);

  const inmPrice = await stripe.prices.create({
    product:    inmProduct.id,
    unit_amount: 2500,       // $25.00 in cents
    currency:   'usd',
    recurring:  { interval: 'month' },
    nickname:   'Inmobiliaria mensual',
    metadata:   { role: 'inmobiliaria' },
  });
  console.log(`  ✓ Price created:   ${inmPrice.id}  ($25.00/month)`);

  // ── 3. Register webhook endpoint ──────────────────────────────────────
  const baseUrl = process.env.BASE_URL || '';
  let webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  if (baseUrl && baseUrl.startsWith('https://')) {
    console.log('');
    console.log('Registering webhook endpoint...');
    try {
      const webhook = await stripe.webhookEndpoints.create({
        url: `${baseUrl}/api/stripe/webhook`,
        enabled_events: [
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
          'invoice.payment_failed',
          'invoice.payment_succeeded',
        ],
        description: 'HogaresRD subscription events',
      });
      webhookSecret = webhook.secret;
      console.log(`  ✓ Webhook registered: ${webhook.url}`);
      console.log(`  ✓ Webhook secret:     ${webhookSecret}`);
    } catch (err) {
      console.warn(`  ⚠️  Could not auto-register webhook: ${err.message}`);
      console.warn('     Register it manually at: https://dashboard.stripe.com/webhooks');
    }
  } else {
    console.log('');
    console.log('⏭️  Skipping webhook auto-registration (BASE_URL not set or not https).');
    console.log('   Register manually at: https://dashboard.stripe.com/webhooks');
    console.log(`   URL: ${baseUrl}/api/stripe/webhook`);
    console.log('   Events: customer.subscription.*, invoice.payment_*');
  }

  // ── 4. Write to .env ──────────────────────────────────────────────────
  console.log('');
  console.log('Writing Price IDs to .env...');
  let envContent = readEnv();
  envContent = setEnvVar(envContent, 'STRIPE_BROKER_PRICE_ID', brokerPrice.id);
  envContent = setEnvVar(envContent, 'STRIPE_INM_PRICE_ID',    inmPrice.id);
  if (webhookSecret) {
    envContent = setEnvVar(envContent, 'STRIPE_WEBHOOK_SECRET', webhookSecret);
  }
  writeEnv(envContent);
  console.log('  ✓ .env updated');

  // ── 5. Summary ────────────────────────────────────────────────────────
  console.log('');
  console.log('─'.repeat(40));
  console.log('✅  Setup complete!\n');
  console.log('  STRIPE_BROKER_PRICE_ID =', brokerPrice.id);
  console.log('  STRIPE_INM_PRICE_ID    =', inmPrice.id);
  if (webhookSecret) {
    console.log('  STRIPE_WEBHOOK_SECRET  =', webhookSecret);
  } else {
    console.log('  STRIPE_WEBHOOK_SECRET  = (set after webhook registration)');
  }
  console.log('');
  if (!isLive) {
    console.log('🟡  These are TEST keys. When you\'re ready to go live:');
    console.log('    1. Switch to Live mode in Stripe dashboard');
    console.log('    2. Update STRIPE_SECRET_KEY with your sk_live_... key');
    console.log('    3. Re-run this script to create live products + prices');
    console.log('');
  }
  console.log('Next step: restart your server (pm2 restart all or node server.js)');
  console.log('');
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  if (err.type === 'StripeAuthenticationError') {
    console.error('    Your STRIPE_SECRET_KEY is invalid. Check it and try again.');
  }
  process.exit(1);
});
