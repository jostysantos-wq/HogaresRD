const express = require('express');
const router  = express.Router();
const store   = require('./store');

// Stripe is optional — only initialised when the secret key is present.
// This lets the server start in dev without Stripe configured.
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe    = stripeKey ? require('stripe')(stripeKey) : null;

const BROKER_PRICE_ID = process.env.STRIPE_BROKER_PRICE_ID;   // $10/month
const INM_PRICE_ID    = process.env.STRIPE_INM_PRICE_ID;       // $25/month
const WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;
const BASE_URL        = process.env.BASE_URL || 'http://localhost:3000';

const JWT_SECRET      = process.env.JWT_SECRET;
const jwt             = require('jsonwebtoken');
const cookieParser    = require('cookie-parser');

// ── Helper: resolve user from cookie or Bearer token ─────────────────────
function getUser(req) {
  try {
    const cookieToken = req.cookies?.hrdt;
    const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const token = cookieToken || headerToken;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  req.user = user;
  next();
}

function requireStripe(req, res, next) {
  if (!stripe) return res.status(503).json({ error: 'Pagos no configurados. Contacta al administrador.' });
  next();
}

// ── Price ID by role ──────────────────────────────────────────────────────
function priceForRole(role) {
  if (role === 'agency' || role === 'broker') return BROKER_PRICE_ID;
  if (role === 'inmobiliaria')                return INM_PRICE_ID;
  return null;
}

// ── POST /api/stripe/create-checkout ─────────────────────────────────────
// Creates a Stripe Checkout session and returns the URL.
// The user is redirected to Stripe's hosted checkout page.
router.post('/create-checkout', requireAuth, requireStripe, async (req, res) => {
  try {
    const user     = store.getUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const priceId  = priceForRole(user.role);
    if (!priceId)  return res.status(400).json({ error: 'Este tipo de cuenta no requiere suscripción' });

    // Get or create a Stripe customer for this user
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    user.email,
        name:     user.name,
        metadata: { userId: user.id, role: user.role },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      store.saveUser(user);
    }

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode:                 'subscription',
      subscription_data: {
        trial_period_days: 14,
        metadata:          { userId: user.id },
      },
      allow_promotion_codes: true,
      success_url: `${BASE_URL}/broker?subscribed=1`,
      cancel_url:  `${BASE_URL}/subscribe?cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] create-checkout error:', err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago: ' + err.message });
  }
});

// ── POST /api/stripe/create-portal ───────────────────────────────────────
// Creates a Stripe Billing Portal session so users can manage their sub.
router.post('/create-portal', requireAuth, requireStripe, async (req, res) => {
  try {
    const user = store.getUserById(req.user.sub);
    if (!user?.stripeCustomerId)
      return res.status(400).json({ error: 'No tienes una suscripción activa' });

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${BASE_URL}/subscription`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] create-portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stripe/status ────────────────────────────────────────────────
// Returns the current subscription status for the logged-in user.
router.get('/status', requireAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const isPro = ['agency', 'broker', 'inmobiliaria'].includes(user.role);
  if (!isPro) return res.json({ required: false });

  const status      = user.subscriptionStatus || 'none';
  const trialEndsAt = user.trialEndsAt   || null;
  const isActive    = ['active', 'trialing'].includes(status);

  // Check if trial expired client-side
  const trialExpired = trialEndsAt && new Date(trialEndsAt) < new Date() && status === 'trial';

  res.json({
    required:     true,
    status:       trialExpired ? 'expired' : status,
    trialEndsAt,
    isActive:     isActive && !trialExpired,
    planName:     user.role === 'inmobiliaria' ? 'Inmobiliaria ($25/mes)' : 'Agente ($10/mes)',
    hasPaymentMethod: !!user.stripeCustomerId,
  });
});

// ── POST /api/stripe/webhook ──────────────────────────────────────────────
// NOTE: This route needs the RAW request body — mounted in server.js
// BEFORE express.json() with express.raw({ type: 'application/json' }).
router.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!WEBHOOK_SECRET || !stripe) {
    console.warn('[Stripe] Webhook received but STRIPE_WEBHOOK_SECRET not set — skipping.');
    return res.json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Stripe] Webhook event: ${event.type}`);

  // Helper: find user by Stripe customer ID or subscription metadata userId
  function findUser(sub) {
    const userId = sub.metadata?.userId;
    if (userId) {
      const u = store.getUserById(userId);
      if (u) return u;
    }
    return store.getUsers().find(u => u.stripeCustomerId === sub.customer) || null;
  }

  switch (event.type) {

    // Subscription created or updated (also fires when trial starts)
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub  = event.data.object;
      const user = findUser(sub);
      if (user) {
        user.stripeSubscriptionId = sub.id;
        user.subscriptionStatus   = sub.status; // 'trialing', 'active', 'past_due', 'canceled'
        if (sub.trial_end) {
          user.trialEndsAt = new Date(sub.trial_end * 1000).toISOString();
        }
        if (sub.current_period_end) {
          user.subscriptionRenewsAt = new Date(sub.current_period_end * 1000).toISOString();
        }
        store.saveUser(user);
        console.log(`[Stripe] Subscription ${sub.status} → user ${user.id}`);
      }
      break;
    }

    // Subscription cancelled (immediately or at period end)
    case 'customer.subscription.deleted': {
      const sub  = event.data.object;
      const user = findUser(sub);
      if (user) {
        user.subscriptionStatus = 'canceled';
        store.saveUser(user);
        console.log(`[Stripe] Subscription cancelled → user ${user.id}`);
      }
      break;
    }

    // Payment failed (e.g. card declined on renewal)
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const user    = store.getUsers().find(u => u.stripeCustomerId === invoice.customer);
      if (user) {
        user.subscriptionStatus = 'past_due';
        store.saveUser(user);
        console.log(`[Stripe] Payment failed → user ${user.id}`);
      }
      break;
    }

    // Payment succeeded (renewal, trial conversion, etc.)
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const user    = store.getUsers().find(u => u.stripeCustomerId === invoice.customer);
      if (user && user.subscriptionStatus !== 'trialing') {
        user.subscriptionStatus = 'active';
        store.saveUser(user);
        console.log(`[Stripe] Payment succeeded → user ${user.id}`);
      }
      break;
    }

    default:
      // Ignore unhandled event types
      break;
  }

  res.json({ received: true });
});

module.exports = router;
