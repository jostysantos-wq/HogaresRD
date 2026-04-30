/**
 * subscription-gate.js — Subscription enforcement middleware
 *
 * Blocks write operations (POST/PUT/DELETE/PATCH) for pro-role users
 * who do not have an active subscription. Reads (GET) are always allowed
 * so canceled users can still view their data.
 *
 * Rules:
 *   - Regular users (role: 'user') are never blocked — no subscription needed
 *   - Admins are never blocked
 *   - Secretaries inherit from their inmobiliaria's subscription status
 *   - 'active' and 'trialing' always pass
 *   - 'past_due' passes (Stripe grace period ~3 weeks of retries)
 *   - Legacy trial (paywallRequired !== true, trialEndsAt > now) passes
 *   - Everything else (canceled, none, expired) → 402 on writes
 */

'use strict';

const store = require('../routes/store');
// Lazy-required to avoid circular dependency: routes/auth.js requires this file
// indirectly via server.js bootstrap. We pull verifyJWT only at first call.
let _verifyJWT = null;
function getVerifyJWT() {
  if (_verifyJWT) return _verifyJWT;
  try {
    _verifyJWT = require('../routes/auth').verifyJWT;
  } catch {
    _verifyJWT = null;
  }
  return _verifyJWT;
}

const COOKIE_NAME = 'hrdt';
const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];

function isSubscriptionActive(user) {
  const status = user.subscriptionStatus || 'none';

  // Stripe-managed active/trial/grace states
  if (['active', 'trialing', 'past_due'].includes(status)) return true;

  // Legacy trial — users onboarded before paywall was enforced
  if (user.paywallRequired !== true && status === 'trial' &&
      user.trialEndsAt && new Date(user.trialEndsAt) > new Date()) {
    return true;
  }

  return false;
}

/**
 * Middleware: blocks POST/PUT/DELETE/PATCH for pro users without active subscription.
 * GET/HEAD/OPTIONS always pass through (read-only access).
 *
 * Must be applied AFTER userAuth (needs req.user.sub populated).
 */
function requireActiveSubscription(req, res, next) {
  // Reads are always allowed — canceled users can view their data
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Inline JWT verification: this middleware runs at app-level BEFORE
  // per-route userAuth has populated req.user. Try to verify any token
  // present (cookie or Authorization header) so the gate can actually
  // enforce. On any failure, leave req.user unset and let downstream
  // auth handle it.
  if (!req.user?.sub) {
    const verifyJWT = getVerifyJWT();
    if (verifyJWT) {
      const cookieToken = req.cookies?.[COOKIE_NAME];
      const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      const token = cookieToken || headerToken;
      if (token) {
        try {
          const payload = verifyJWT(token);
          if (!payload.jti || !store.isTokenRevoked(payload.jti)) {
            req.user = payload;
          }
        } catch {
          // verification failed — fall through, downstream auth will reject
        }
      }
    }
  }

  // No auth context yet — let downstream auth handle it
  if (!req.user?.sub) return next();

  const user = store.getUserById(req.user.sub);
  if (!user) return next();

  // Regular users and admins are never subscription-gated
  if (user.role === 'user' || user.role === 'admin') return next();

  // Secretaries inherit from their inmobiliaria
  if (user.role === 'secretary') {
    if (user.inmobiliaria_id) {
      const inm = store.getUserById(user.inmobiliaria_id);
      if (inm && isSubscriptionActive(inm)) return next();
    }
    return res.status(402).json({
      error: 'La suscripcion de tu inmobiliaria no esta activa.',
      needsSubscription: true,
    });
  }

  // Pro roles: check subscription
  if (!PRO_ROLES.includes(user.role)) return next();

  if (isSubscriptionActive(user)) return next();

  return res.status(402).json({
    error: 'Tu suscripcion no esta activa. Renueva tu plan para continuar.',
    needsSubscription: true,
  });
}

module.exports = { requireActiveSubscription, isSubscriptionActive };
