const express      = require('express');
const crypto       = require('crypto');
const rateLimit    = require('express-rate-limit');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');
const { userAuth } = require('./auth');
const { notify }   = require('./push');
const { makeUnsubToken } = require('./newsletter');

const router  = express.Router();

const savedSearchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 15,
  message: { error: 'Demasiadas búsquedas guardadas. Intenta más tarde.' },
  standardHeaders: true, legacyHeaders: false,
});
const MAX_SAVED_SEARCHES = 10;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const { createTransport } = require('./mailer');
const et = require('../utils/email-templates');
const transporter = createTransport();

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run the saved-search filters against the listings DB and return matches */
function runSearch(filters) {
  const dbFilters = {};
  if (filters.province)    dbFilters.province    = filters.province;
  if (filters.city)        dbFilters.city         = filters.city;
  if (filters.type)        dbFilters.type         = filters.type;
  if (filters.condition)   dbFilters.condition    = filters.condition;
  if (filters.priceMin)    dbFilters.priceMin     = filters.priceMin;
  if (filters.priceMax)    dbFilters.priceMax     = filters.priceMax;
  if (filters.bedroomsMin) dbFilters.bedroomsMin  = filters.bedroomsMin;

  let listings = store.getListings(dbFilters);

  // Tag filter (comma-separated, match ANY)
  if (filters.tags) {
    const wanted = (typeof filters.tags === 'string'
      ? filters.tags.split(',') : filters.tags
    ).map(t => t.trim()).filter(Boolean);
    if (wanted.length) {
      listings = listings.filter(l =>
        Array.isArray(l.tags) && wanted.some(t => l.tags.includes(t))
      );
    }
  }

  return listings;
}

/** Build a human-readable summary of filter criteria */
function describeFilters(f) {
  const parts = [];
  if (f.type) {
    const types = { venta: 'En Venta', alquiler: 'En Alquiler', proyecto: 'Proyectos' };
    parts.push(types[f.type] || f.type);
  }
  if (f.bedroomsMin) parts.push(`${f.bedroomsMin}+ hab.`);
  if (f.province)    parts.push(f.province);
  if (f.city)        parts.push(f.city);
  if (f.priceMax)    parts.push(`hasta $${Number(f.priceMax).toLocaleString()}`);
  if (f.priceMin)    parts.push(`desde $${Number(f.priceMin).toLocaleString()}`);
  if (f.condition) {
    const cond = { nueva_construccion: 'Nueva', usada: 'Usada', planos: 'En Planos' };
    parts.push(cond[f.condition] || f.condition);
  }
  return parts.join(' · ') || 'Todas las propiedades';
}

// ── CRUD Routes ─────────────────────────────────────────────────────────────

// GET /api/saved-searches — list user's saved searches with current match count
router.get('/', userAuth, (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 100), 500);
  const searches = store.getSavedSearchesByUser(req.user.sub);
  // Order by createdAt descending, then slice
  const sorted = searches.slice().sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
  const sliced = sorted.slice(0, limit);
  // Optionally include current match counts
  const enriched = sliced.map(s => {
    const matches = runSearch(s.filters);
    return { ...s, matchCount: matches.length };
  });
  res.json({ searches: enriched });
});

// POST /api/saved-searches — create a new saved search
router.post('/', savedSearchLimiter, userAuth, (req, res) => {
  const existing = store.getSavedSearchesByUser(req.user.sub);
  if (existing.length >= MAX_SAVED_SEARCHES) {
    return res.status(400).json({
      error: `Puedes guardar hasta ${MAX_SAVED_SEARCHES} búsquedas. Elimina una para crear otra.`,
    });
  }

  const { name, filters, notify: doNotify } = req.body;
  if (!filters || typeof filters !== 'object') {
    return res.status(400).json({ error: 'Filtros son requeridos' });
  }

  // Auto-generate name if not provided
  const searchName = (name || '').trim() || describeFilters(filters);

  // Get current matches so we don't notify about existing listings
  const currentMatches = runSearch(filters);
  const currentIds     = currentMatches.map(l => l.id);

  const search = {
    id:             crypto.randomUUID(),
    userId:         req.user.sub,
    name:           searchName,
    filters,
    notify:         doNotify !== false,
    lastMatchIds:   currentIds,
    lastNotifiedAt: null,
    matchCount:     currentMatches.length,
    createdAt:      new Date().toISOString(),
  };

  store.saveSavedSearch(search);
  res.json({ success: true, search });
});

// GET /api/saved-searches/:id — get a specific saved search with current results
router.get('/:id', userAuth, (req, res) => {
  const search = store.getSavedSearchById(req.params.id);
  if (!search || search.userId !== req.user.sub) {
    return res.status(404).json({ error: 'Búsqueda no encontrada' });
  }

  const matches = runSearch(search.filters);
  // Sort newest first
  matches.sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt));

  res.json({ search, listings: matches.slice(0, 50), total: matches.length });
});

// PUT /api/saved-searches/:id — update name, filters, or notification setting
router.put('/:id', userAuth, (req, res) => {
  const search = store.getSavedSearchById(req.params.id);
  if (!search || search.userId !== req.user.sub) {
    return res.status(404).json({ error: 'Búsqueda no encontrada' });
  }

  const { name, filters, notify: doNotify } = req.body;

  if (name !== undefined)     search.name    = name.trim() || search.name;
  if (filters !== undefined)  search.filters = filters;
  if (doNotify !== undefined) search.notify  = !!doNotify;

  // If filters changed, recalculate current matches
  if (filters !== undefined) {
    const currentMatches = runSearch(search.filters);
    search.lastMatchIds  = currentMatches.map(l => l.id);
    search.matchCount    = currentMatches.length;
  }

  store.saveSavedSearch(search);
  res.json({ success: true, search });
});

// DELETE /api/saved-searches/:id — delete a saved search
router.delete('/:id', userAuth, (req, res) => {
  const result = store.deleteSavedSearch(req.params.id, req.user.sub);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Búsqueda no encontrada' });
  }
  res.json({ success: true });
});

// ── Match checker — called by cron ──────────────────────────────────────────

/** Check all notifiable saved searches for new matches, send alerts */
async function checkSavedSearchMatches() {
  const searches = store.getAllNotifiableSavedSearches();
  if (!searches.length) return { checked: 0, notified: 0 };

  let notified = 0;

  for (const search of searches) {
    try {
      const user = store.getUserById(search.userId);
      if (!user) continue;

      const currentMatches = runSearch(search.filters);
      const currentIds     = new Set(currentMatches.map(l => l.id));
      const previousIds    = new Set(search.lastMatchIds || []);

      // Find NEW listings (in current but not in previous)
      const newIds = [...currentIds].filter(id => !previousIds.has(id));

      if (newIds.length === 0) {
        // Still update match count
        if (currentMatches.length !== search.matchCount) {
          search.matchCount = currentMatches.length;
          store.saveSavedSearch(search);
        }
        continue;
      }

      // Get the new listing objects (max 5 for notification)
      const newListings = newIds
        .slice(0, 5)
        .map(id => currentMatches.find(l => l.id === id))
        .filter(Boolean);

      // ── Send push notification ──────────────────────────────
      const firstTitle = newListings[0]?.title || 'Nueva propiedad';
      const nounPlural = newIds.length === 1 ? 'nueva propiedad' : 'nuevas propiedades';
      await notify(user.id, {
        type:  'saved_search_match',
        title: `${newIds.length} ${nounPlural} en "${search.name}"`,
        body:  newIds.length === 1
          ? firstTitle
          : `${firstTitle} y ${newIds.length - 1} más`,
        url:   `/busquedas-guardadas`,
      });

      // ── Send email alert ────────────────────────────────────
      if (user.email && user.marketingOptIn) {
        try {
          await sendSearchAlertEmail(user, search, newListings, newIds.length);
        } catch (err) {
          console.error(`[SavedSearch] Email failed for ${user.email}:`, err.message);
        }
      }

      // Update the saved search
      search.lastMatchIds   = [...currentIds];
      search.matchCount     = currentMatches.length;
      search.lastNotifiedAt = new Date().toISOString();
      store.saveSavedSearch(search);
      notified++;
    } catch (err) {
      console.error(`[SavedSearch] Error processing search ${search.id}:`, err.message);
    }
  }

  console.log(`[SavedSearch] Checked: ${searches.length}, Notified: ${notified}`);
  return { checked: searches.length, notified };
}

// ── Email template ──────────────────────────────────────────────────────────

async function sendSearchAlertEmail(user, search, newListings, totalNew) {
  const firstName = user.name.split(' ')[0];
  const filterDesc = describeFilters(search.filters);

  // Use the shared hero-image listing card so saved-search alerts show
  // the actual property photo with price overlay, matching the newsletter.
  const listingCards = newListings.map(et.listingCard).join('');

  const moreText = totalNew > newListings.length
    ? et.small(`...y ${totalNew - newListings.length} mas`)
    : '';

  const html = et.layout({
    title: totalNew === 1 ? 'Nueva propiedad encontrada' : `${totalNew} nuevas propiedades encontradas`,
    subtitle: `Busqueda: "${et.esc(search.name)}"`,
    preheader: `${totalNew} nuevas propiedades en ${search.name}`,
    body:
      et.p(`Hola <strong>${et.esc(firstName)}</strong>,`)
      + et.p(
          (totalNew === 1 ? 'Hay una nueva propiedad que coincide' : `Hay ${totalNew} nuevas propiedades que coinciden`)
          + ` con tu busqueda guardada <strong>"${et.esc(search.name)}"</strong> (${et.esc(filterDesc)}).`
        )
      + listingCards
      + moreText
      + et.button('Ver todas mis busquedas', `${BASE_URL}/busquedas-guardadas`)
      + et.divider()
      + et.small(`Recibiste este correo por tu busqueda guardada. <a href="${BASE_URL}/unsubscribe?token=${makeUnsubToken(user.id)}" style="color:${et.C.muted};text-decoration:underline;">Cancelar suscripcion</a>`),
  });

  await transporter.sendMail({
    department: 'noreply',
    to:      user.email,
    subject: `${totalNew === 1 ? 'Nueva propiedad' : totalNew + ' nuevas propiedades'} en "${search.name}" — HogaresRD`,
    html,
  });
}

module.exports = { router, checkSavedSearchMatches };
