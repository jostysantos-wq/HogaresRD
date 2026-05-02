const express  = require('express');
const store    = require('./store');
const { userAuth } = require('./auth');
const { rebuildProfile, getRecommendations } = require('../utils/recommendations');

const router = express.Router();

// GET /api/user/favorites — list favorited listings
router.get('/favorites', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const ids      = user.favorites || [];
  const listings = ids.map(id => store.getListingById(id)).filter(l => l && l.status === 'approved');
  res.json({ favorites: listings });
});

// POST /api/user/favorites — toggle favorite via { listingId } body.
// Used by listing-card heart toggles (listing.html#toggleSimFav). The
// :listingId variant below is the explicit add; this one flips state
// based on whether the id is already in the list, so the caller doesn't
// need to track current state.
router.post('/favorites', userAuth, (req, res) => {
  const listingId = String((req.body && req.body.listingId) || '');
  if (!listingId) return res.status(400).json({ error: 'listingId requerido' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const listing = store.getListingById(listingId);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  if (!Array.isArray(user.favorites)) user.favorites = [];
  const idx = user.favorites.indexOf(listingId);
  if (idx >= 0) user.favorites.splice(idx, 1);
  else user.favorites.push(listingId);
  store.saveUser(user);

  res.json({ success: true, favorites: user.favorites, isFavorite: idx < 0 });
});

// POST /api/user/favorites/:listingId — add favorite
router.post('/favorites/:listingId', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  if (!user.favorites.includes(req.params.listingId)) {
    user.favorites.push(req.params.listingId);
    store.saveUser(user);
  }
  res.json({ success: true, favorites: user.favorites });
});

// DELETE /api/user/favorites/:listingId — remove favorite
router.delete('/favorites/:listingId', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  user.favorites = user.favorites.filter(id => id !== req.params.listingId);
  store.saveUser(user);
  res.json({ success: true, favorites: user.favorites });
});

// GET /api/user/comparisons — get user's comparison list (array of listing IDs)
router.get('/comparisons', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ids: user.comparisonIds || [] });
});

// PUT /api/user/comparisons — replace the entire comparison list
router.put('/comparisons', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids debe ser un array' });
  // Reject non-string entries and clamp each id to 64 chars so an attacker
  // can't persist megabytes of garbage. Cap the overall list at 10.
  user.comparisonIds = ids
    .filter(id => typeof id === 'string')
    .slice(0, 10)
    .map(id => id.slice(0, 64));
  store.saveUser(user);
  res.json({ ids: user.comparisonIds });
});

// POST /api/user/recently-viewed/:listingId — log a recently viewed listing
router.post('/recently-viewed/:listingId', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const id = req.params.listingId;
  let recent = Array.isArray(user.recentlyViewed) ? user.recentlyViewed : [];
  // Remove if already in list, add to front, cap at 20
  recent = recent.filter(r => r !== id);
  recent.unshift(id);
  if (recent.length > 20) recent = recent.slice(0, 20);
  user.recentlyViewed = recent;
  store.saveUser(user);
  res.json({ success: true });
});

// GET /api/user/recently-viewed — get recently viewed listing IDs
router.get('/recently-viewed', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ids: user.recentlyViewed || [] });
});

// Per-user rate limit for /activity. Without this, every authenticated page
// view writes a row to the activity table — an attacker (or buggy client) can
// trivially flood the DB. Allow 60 events / 60s per user.
const _activityWindow = new Map(); // userId → number[] (ms timestamps in the last 60s)
const ACTIVITY_WINDOW_MS = 60_000;
const ACTIVITY_MAX       = 60;
function activityRateLimit(userId) {
  const now    = Date.now();
  const cutoff = now - ACTIVITY_WINDOW_MS;
  const arr    = (_activityWindow.get(userId) || []).filter(t => t > cutoff);
  if (arr.length >= ACTIVITY_MAX) {
    _activityWindow.set(userId, arr);
    return false;
  }
  arr.push(now);
  _activityWindow.set(userId, arr);
  return true;
}

// POST /api/user/activity — log a user event and rebuild profile if it's a view
router.post('/activity', userAuth, (req, res) => {
  const { type, listingId, metadata } = req.body;
  const validTypes = ['view_listing', 'search', 'favorite'];
  if (!type || !validTypes.includes(type))
    return res.status(400).json({ error: 'Tipo de evento inválido' });

  if (!activityRateLimit(req.user.sub)) {
    return res.status(429).json({ error: 'Demasiados eventos. Intenta de nuevo en un minuto.' });
  }

  store.appendActivity({
    user_id:    req.user.sub,
    action:     type,
    listing_id: listingId || null,
    data:       metadata  || {},
    created_at: new Date().toISOString(),
  });

  // Rebuild profile preferences after every view event
  if (type === 'view_listing' && listingId) {
    const user    = store.getUserById(req.user.sub);
    const listing = store.getListingById(listingId);
    if (user && listing && listing.status === 'approved') rebuildProfile(user);
  }

  res.json({ success: true });
});

// GET /api/user/recommendations — personalized listings for the logged-in user
router.get('/recommendations', userAuth, (req, res) => {
  res.json({ listings: getRecommendations(req.user.sub, 10) });
});

// PATCH /api/user/profile/buying-power — save buying power and update recommendation profile
router.patch('/profile/buying-power', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const {
    budget, annualIncome, monthlyDebts, downPayment,
    calculatedMaxPrice, propertyType, bedrooms,
  } = req.body;

  const maxPrice = Number(calculatedMaxPrice) || Number(budget) || 0;
  if (!maxPrice || maxPrice <= 0)
    return res.status(400).json({ error: 'Presupuesto inválido' });

  user.buyingPower = {
    budget:             Number(budget) || 0,
    annualIncome:       Number(annualIncome) || 0,
    monthlyDebts:       Number(monthlyDebts) || 0,
    downPayment:        Number(downPayment) || 0,
    calculatedMaxPrice: maxPrice,
    propertyType:       propertyType || 'venta',
    bedrooms:           Number(bedrooms) || 0,
    updatedAt:          new Date().toISOString(),
  };

  // Feed buying power into the recommendation profile
  const minPrice = Math.round(maxPrice * 0.5);
  const currentTypes = user.profile.preferredTypes || [];
  const newTypes = propertyType && !currentTypes.includes(propertyType)
    ? [propertyType, ...currentTypes].slice(0, 3)
    : (propertyType ? [propertyType, ...currentTypes.filter(t => t !== propertyType)].slice(0, 3) : currentTypes);

  user.profile = {
    ...user.profile,
    priceMin:       minPrice,
    priceMax:       maxPrice,
    bedroomsMin:    Number(bedrooms) || user.profile.bedroomsMin || 0,
    preferredTypes: newTypes,
    scoredAt:       new Date().toISOString(),
  };

  store.saveUser(user);
  res.json({ success: true, buyingPower: user.buyingPower });
});

// PATCH /api/user/profile — update mutable profile fields
// NOTE: name is intentionally excluded to preserve listing accountability
router.patch('/profile', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { phone, bio, jobTitle,
          profileVisible, showOnlineStatus, shareActivity, allowAnalytics,
          notif_newListings, notif_priceDrops, notif_similar, notif_agentMessages, notif_appUpdates
  } = req.body;

  if (phone !== undefined) user.phone = (phone + '').trim();
  if (bio !== undefined) user.bio = (bio + '').trim().slice(0, 300);
  if (jobTitle !== undefined && ['broker', 'agency'].includes(user.role)) {
    user.jobTitle = (jobTitle + '').trim().slice(0, 60);
  }
  // Privacy settings — synced across platforms
  if (profileVisible !== undefined)   user.profileVisible   = !!profileVisible;
  if (showOnlineStatus !== undefined) user.showOnlineStatus = !!showOnlineStatus;
  if (shareActivity !== undefined)    user.shareActivity    = !!shareActivity;
  if (allowAnalytics !== undefined)   user.allowAnalytics   = !!allowAnalytics;
  // CCPA / Do Not Sell — opt out of any future data sharing
  if (req.body.doNotSell !== undefined) {
    const oldVal = !!user.doNotSell;
    const newVal = !!req.body.doNotSell;
    user.doNotSell = newVal;
    // Log the change for CCPA compliance (24-month retention)
    if (oldVal !== newVal) {
      const crypto = require('crypto');
      store.appendPrivacyLog({
        id:           'priv_' + crypto.randomBytes(8).toString('hex'),
        user_id:      user.id,
        user_email:   user.email,
        request_type: newVal ? 'opt_out_sale' : 'opt_in_sale',
        status:       'completed',
        source:       req.headers['sec-gpc'] === '1' ? 'gpc_signal' : 'manual',
        details:      { previous: oldVal, current: newVal, ip: req.ip, userAgent: (req.headers['user-agent'] || '').slice(0, 200) },
        created_at:   new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
    }
  }
  // Notification preferences — synced across platforms
  if (notif_newListings !== undefined)   user.notif_newListings   = !!notif_newListings;
  if (notif_priceDrops !== undefined)    user.notif_priceDrops    = !!notif_priceDrops;
  if (notif_similar !== undefined)       user.notif_similar       = !!notif_similar;
  if (notif_agentMessages !== undefined) user.notif_agentMessages = !!notif_agentMessages;
  if (notif_appUpdates !== undefined)    user.notif_appUpdates    = !!notif_appUpdates;

  store.saveUser(user);
  res.json({ success: true, user: {
    id:       user.id,
    phone:    user.phone,
    bio:      user.bio,
    jobTitle: user.jobTitle,
    avatarUrl: user.avatarUrl,
    profileVisible:   user.profileVisible,
    showOnlineStatus: user.showOnlineStatus,
    shareActivity:    user.shareActivity,
    allowAnalytics:   user.allowAnalytics,
    notif_newListings:   user.notif_newListings,
    notif_priceDrops:    user.notif_priceDrops,
    notif_similar:       user.notif_similar,
    notif_agentMessages: user.notif_agentMessages,
    notif_appUpdates:    user.notif_appUpdates,
  }});
});

// GET /api/user/listings — the authenticated user's own submissions
// Returns ALL statuses (approved, pending, rejected, edits_requested) so
// the owner can see and manage listings that haven't been published yet.
router.get('/listings', userAuth, (req, res) => {
  const userId = req.user.sub;
  const user = store.getUserById(userId);
  const userEmail = user?.email?.toLowerCase() || null;
  // For inmobiliaria/constructora accounts the user.id IS the inmobiliaria_id
  // on listings. For brokers affiliated to one, user.inmobiliaria_id holds
  // the parent org id. Match either.
  const userInmIds = new Set([userId, user?.inmobiliaria_id].filter(Boolean));

  const all = store.getAllSubmissions();
  const mine = all.filter(s => {
    if (s.creator_user_id && s.creator_user_id === userId) return true;
    if (s.inmobiliaria_id && userInmIds.has(s.inmobiliaria_id)) return true;
    // Some submissions store the broker on the agencies array instead of
    // creator_user_id (older agency-claim flow).
    if (Array.isArray(s.agencies) && s.agencies.some(a => a && a.user_id === userId)) return true;
    // Fallback: legacy listings whose only owner signal is the contact email.
    if (userEmail && s.email && s.email.toLowerCase() === userEmail) return true;
    return false;
  });
  // Strip nothing; sort by most recent first so pending/edits_requested
  // rise naturally if the client doesn't explicitly group them.
  mine.sort((a, b) => {
    const ta = new Date(a.editsRequestedAt || a.submittedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.editsRequestedAt || b.submittedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  res.json({ listings: mine });
});

// POST /api/user/request-data-download — CCPA/GDPR data export request
// Collects all user data and sends it via email as a JSON attachment.
router.post('/request-data-download', userAuth, async (req, res) => {
  const userId = req.user.sub;
  const user = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    // Collect all user data
    const conversations = store.getConversationsByClient(userId);
    const applications = store.getApplicationsByClient(userId);
    const favorites = user.favorites || [];
    const recentlyViewed = user.recentlyViewed || [];
    const savedSearches = store.getSavedSearchesByUser(userId);
    const tasks = store.getTasksByUser(userId);
    const activity = [];
    try {
      const a = await store.getActivityByUser(userId, { limit: 500 });
      activity.push(...a);
    } catch (err) {
      // Activity is non-essential to a data export — keep going so the
      // user still gets the rest of their data, but log so we know the
      // export was incomplete. (Visible in the error log.)
      console.warn(`[user] Data export: activity load failed for user ${userId}:`, err.message);
    }

    // Strip sensitive fields
    const { passwordHash, resetToken, resetTokenExpiry, biometricTokenHash, ...safeUser } = user;

    const exportData = {
      exportedAt: new Date().toISOString(),
      user: safeUser,
      favorites,
      recentlyViewed,
      savedSearches: savedSearches.map(s => ({ id: s.id, name: s.name, filters: s.filters, createdAt: s.created_at })),
      conversations: conversations.map(c => ({
        id: c.id, propertyTitle: c.propertyTitle, brokerName: c.brokerName,
        messageCount: c.message_count || 0, createdAt: c.createdAt,
      })),
      applications: applications.map(a => ({
        id: a.id, listingTitle: a.listing_title, status: a.status, createdAt: a.created_at,
      })),
      tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, createdAt: t.created_at })),
      activityLog: activity.slice(0, 100),
    };

    // Send via email
    const { createTransport } = require('./mailer');
    const et = require('../utils/email-templates');
    const mailer = createTransport();

    await mailer.sendMail({
      to: user.email,
      subject: 'Tu descarga de datos — HogaresRD',
      department: 'soporte',
      html: et.layout({
        title: 'Descarga de Datos',
        subtitle: 'HogaresRD',
        body: `<p>Hola <strong>${user.name || ''}</strong>,</p>
          <p>Adjunto encontrarás un resumen de tus datos personales almacenados en HogaresRD.</p>
          <p>Este archivo contiene: tu perfil, favoritos, búsquedas guardadas, historial de conversaciones (sin mensajes completos), aplicaciones, tareas y actividad reciente.</p>
          <p>Si deseas la eliminación completa de tus datos, puedes hacerlo desde la app en Perfil → Privacidad → Eliminar mi cuenta.</p>
          <pre style="background:#f5f5f5;padding:1rem;border-radius:8px;font-size:0.75rem;max-height:400px;overflow:auto;">${JSON.stringify(exportData, null, 2).slice(0, 50000)}</pre>`,
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[data-download] Error:', err.message);
    res.status(500).json({ error: 'Error al procesar la solicitud. Intenta de nuevo.' });
  }
});

module.exports = router;
