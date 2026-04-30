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

const cookieParser    = require('cookie-parser');
// Use the shared verifier from auth.js so JWT rotation grace
// (JWT_SECRET_PREV fallback) works the same here as in userAuth.
const { verifyJWT }   = require('./auth');

// ── Helper: resolve user from cookie or Bearer token ─────────────────────
function getUser(req) {
  try {
    const cookieToken = req.cookies?.hrdt;
    const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const token = cookieToken || headerToken;
    if (!token) return null;
    return verifyJWT(token);
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
  if (role === 'inmobiliaria' || role === 'constructora') return INM_PRICE_ID;
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

    // Block org-level subscription if agent is linked to another inmobiliaria
    const isOrgRole   = ['inmobiliaria', 'constructora'].includes(user.role);
    const isLinkedAgent = user.inmobiliaria_id || user.inmobiliaria_join_status === 'pending';
    if (isOrgRole && isLinkedAgent) {
      return res.status(400).json({
        error: 'Debes desvincularte de tu inmobiliaria actual antes de suscribirte como empresa. Ve a tu dashboard y sal de la organizacion primero.',
      });
    }

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
    res.status(500).json({ error: 'Error al crear sesión de pago. Intenta de nuevo.' });
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
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
});

// ── GET /api/stripe/status ────────────────────────────────────────────────
// Returns the current subscription status for the logged-in user.
router.get('/status', requireAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const isPro = ['agency', 'broker', 'inmobiliaria', 'constructora'].includes(user.role);
  if (!isPro) return res.json({ required: false });

  const status      = user.subscriptionStatus || 'none';
  const trialEndsAt = user.trialEndsAt   || null;
  const paywallRequired = user.paywallRequired === true;

  // Check if trial expired client-side
  const trialExpired = trialEndsAt && new Date(trialEndsAt) < new Date() && status === 'trial';

  // Legacy trial users (paywallRequired=false) have free access until their trial expires
  const isLegacyTrial = !paywallRequired && status === 'trial' && !trialExpired;
  // Stripe-managed trialing/active users
  const isPaidOrTrialing = ['active', 'trialing'].includes(status);

  const canAccessDashboard = isLegacyTrial || isPaidOrTrialing;

  res.json({
    required:         true,
    status:           trialExpired ? 'expired' : status,
    trialEndsAt,
    isActive:         canAccessDashboard,
    canAccessDashboard,
    paywallRequired,
    isLegacyTrial,
    planName:             (user.role === 'inmobiliaria' || user.role === 'constructora') ? (user.role === 'constructora' ? 'Constructora ($35/mes)' : 'Inmobiliaria ($25/mes)') : 'Agente ($10/mes)',
    hasPaymentMethod:     !!user.stripeSubscriptionId,
    subscriptionRenewsAt: user.subscriptionRenewsAt || null,
  });
});

// ── GET /api/stripe/cancel-stats ─────────────────────────────────────────
// Returns platform usage stats for the retention screen.
router.get('/cancel-stats', requireAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const apps     = store.getApplicationsByBroker(req.user.sub);
  const convs    = store.getConversationsForBroker(req.user.sub);
  const tours    = store.getToursByBroker(req.user.sub);
  const listings = store.getAllSubmissions().filter(s =>
    s.creator_user_id === req.user.sub || s.email === user.email
  );
  const totalViews = listings.reduce((s, l) => s + (l.views || 0), 0);

  res.json({
    listings: listings.length,
    applications: apps.length,
    conversations: convs.length,
    tours: tours.length,
    totalViews,
    memberSince: user.createdAt || null,
  });
});

// ── POST /api/stripe/cancel-feedback ────────────────────────────────────
// Processes cancellation feedback and applies retention offers.
router.post('/cancel-feedback', requireAuth, requireStripe, async (req, res) => {
  try {
    const user = store.getUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { reason, feedback, accepted_offer } = req.body;

    // _extra may come back from PostgreSQL as a JSON string. Parse it before
    // mutating so we don't accidentally treat the string as a non-object and
    // wipe existing keys.
    if (typeof user._extra === 'string') {
      try { user._extra = JSON.parse(user._extra); } catch { user._extra = {}; }
    }
    if (!user._extra || typeof user._extra !== 'object') user._extra = {};

    // Store cancellation feedback
    user._extra.cancelFeedback = {
      reason: reason || '',
      feedback: feedback || '',
      accepted_offer: accepted_offer || null,
      timestamp: new Date().toISOString(),
    };
    store.saveUser(user);

    console.log(`[Stripe] Cancel feedback from ${user.email}: reason="${reason}", offer="${accepted_offer}"`);

    // Handle accepted offers
    if (accepted_offer === 'pause' && user.stripeSubscriptionId) {
      // Pause subscription for 1 month
      await stripe.subscriptions.update(user.stripeSubscriptionId, {
        pause_collection: {
          behavior: 'void',
          resumes_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
        },
      });
      user.subscriptionStatus = 'paused';
      store.saveUser(user);
      console.log(`[Stripe] Subscription paused for user ${user.id}`);
      return res.json({ action: 'paused', message: 'Tu suscripcion ha sido pausada por 1 mes. Se reactivara automaticamente.' });
    }

    if (accepted_offer === 'discount' && user.stripeSubscriptionId) {
      // Create a 30% off coupon for 3 months
      let coupon;
      try {
        coupon = await stripe.coupons.create({
          percent_off: 30,
          duration: 'repeating',
          duration_in_months: 3,
          name: 'Retencion - 30% por 3 meses',
        });
        await stripe.subscriptions.update(user.stripeSubscriptionId, {
          coupon: coupon.id,
        });
      } catch (e) {
        console.error('[Stripe] Coupon error:', e.message);
        return res.status(500).json({ error: 'Error al aplicar descuento' });
      }
      console.log(`[Stripe] 30% discount applied for user ${user.id}`);
      return res.json({ action: 'discounted', message: 'Hemos aplicado un 30% de descuento por los proximos 3 meses.' });
    }

    // No offer accepted — create portal session for actual cancellation
    if (user.stripeCustomerId) {
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${BASE_URL}/subscription`,
        flow_data: {
          type: 'subscription_cancel',
          subscription_cancel: { subscription: user.stripeSubscriptionId },
        },
      });
      return res.json({ action: 'portal', url: session.url });
    }

    res.json({ action: 'none', message: 'No se encontro suscripcion activa.' });
  } catch (err) {
    console.error('[Stripe] cancel-feedback error:', err.message);
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
});

// ── Idempotency cache for Stripe webhook events ──────────────────────────
// Stripe can replay webhook events (network retries, manual replay from the
// dashboard). Without dedup, replays mutate user state repeatedly. We track
// recently-seen event IDs in a FIFO Map capped at 1000 entries (Map preserves
// insertion order, so we evict the oldest when we exceed the cap).
const _processedEventIds = new Map();
const _MAX_PROCESSED_EVENTS = 1000;

function _markEventProcessed(eventId) {
  if (!eventId) return;
  _processedEventIds.set(eventId, Date.now());
  while (_processedEventIds.size > _MAX_PROCESSED_EVENTS) {
    const oldest = _processedEventIds.keys().next().value;
    _processedEventIds.delete(oldest);
  }
}

// ── POST /api/stripe/webhook ──────────────────────────────────────────────
// NOTE: This route needs the RAW request body — mounted in server.js
// BEFORE express.json() with express.raw({ type: 'application/json' }).
router.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Refuse to accept events when the webhook secret is not configured.
  // Returning 200 here would silently turn the endpoint into an unauthenticated
  // mutation surface — any caller could POST a forged event.
  if (!WEBHOOK_SECRET || !stripe) {
    console.error('[Stripe] Webhook received but STRIPE_WEBHOOK_SECRET / stripe client not configured — rejecting.');
    return res.status(503).json({ error: 'webhook not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: drop replays without re-running side effects.
  if (event.id && _processedEventIds.has(event.id)) {
    console.log(`[Stripe] Duplicate webhook event ignored: ${event.id} (${event.type})`);
    return res.json({ received: true, deduplicated: true });
  }
  _markEventProcessed(event.id);

  console.log(`[Stripe] Webhook event: ${event.type}`);

  // Helper: find user by Stripe customer ID or subscription metadata userId.
  // Returns null if no matching user (logs a warning for observability).
  function findUser(sub) {
    const userId = sub.metadata?.userId;
    if (userId) {
      const u = store.getUserById(userId);
      if (u) return u;
    }
    const match = store.getUsers().find(u => u.stripeCustomerId === sub.customer);
    if (!match) {
      console.warn('[stripe] no user found for customer=%s metadata.userId=%s', sub.customer, userId || 'none');
    }
    return match || null;
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
        user.canceledAt = new Date().toISOString();
        store.saveUser(user);
        console.log(`[Stripe] Subscription cancelled → user ${user.id}`);

        // Send win-back email (fire-and-forget)
        setImmediate(async () => {
          try {
            const { createTransport } = require('./mailer');
            const et = require('../utils/email-templates');
            const mailer = createTransport();
            const firstName = (user.name || '').split(' ')[0] || 'Agente';
            await mailer.sendMail({
              to: user.email,
              subject: 'Tu suscripcion fue cancelada — HogaresRD',
              department: 'ventas',
              html: et.layout({
                title: `Hola ${et.esc(firstName)}, lamentamos verte ir`,
                preheader: 'Lamentamos que te vayas. Tu suscripcion ha sido cancelada.',
                body:
                  et.p('Tu suscripcion ha sido cancelada. Tus propiedades y datos se mantendran en nuestra plataforma por 90 dias.')
                  + et.p('Si cambias de opinion, puedes reactivar tu cuenta en cualquier momento con un <strong>30% de descuento por 3 meses</strong>.')
                  + et.button('Reactivar mi cuenta', `${BASE_URL}/subscribe`)
                  + et.small('Esta oferta es valida por 14 dias.'),
              }),
            });
          } catch (e) {
            console.error('[Stripe] Win-back email error:', e.message);
          }
        });
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
      // Meta CAPI — Purchase (fire-and-forget)
      if (user && invoice.amount_paid > 0) {
        setImmediate(async () => {
          try {
            const meta = require('../utils/meta');
            await meta.trackPurchase({
              email: user.email, phone: user.phone, name: user.name,
              ip: null, userAgent: null,
              eventId:  `purch_${invoice.id}`,
              value:    invoice.amount_paid / 100,
              currency: (invoice.currency || 'usd').toUpperCase(),
              planName: user.subscriptionPlan || 'Pro',
            });
          } catch (_) {}
        });
      }
      break;
    }

    // One-time payment completed (ad purchases)
    case 'checkout.session.completed': {
      const session = event.data.object;
      const adId = session.metadata?.ad_id;
      if (adId && session.payment_status === 'paid') {
        // Use .then() instead of await — webhook handler is not async
        store.pool.query(
          `UPDATE ads SET request_status = 'pending_approval' WHERE id = $1 AND request_status = 'pending_payment'`,
          [adId]
        ).then(() => {
          console.log(`[Stripe] Ad payment confirmed: ${adId}`);
          // Notify admin
          const _ADMIN = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';
          const { createTransport: _ct } = require('./mailer');
          const _et = require('../utils/email-templates');
          _ct().sendMail({
            to: _ADMIN,
            subject: 'Nuevo anuncio pagado — pendiente de aprobación',
            html: _et.layout({ title: 'Anuncio pagado — revisar', body: _et.p('Un agente pagó por un anuncio y está pendiente de tu aprobación.') + _et.button('Revisar en Admin', `${BASE_URL}/${process.env.ADMIN_PATH || 'admin'}`) }),
          }).catch(() => {});
          // Notify requester
          const uid = session.metadata?.user_id;
          if (uid) {
            const { notify: _pn } = require('./push');
            _pn(uid, { type: 'status_changed', title: 'Pago recibido ✓', body: 'Tu anuncio fue pagado y está pendiente de aprobación', url: '/broker#ad-request' });
          }
        }).catch(e => console.error('[Stripe] Ad payment update error:', e.message));
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
