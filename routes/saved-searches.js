const express      = require('express');
const crypto       = require('crypto');
const rateLimit    = require('express-rate-limit');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');
const { userAuth } = require('./auth');
const { notify }   = require('./push');

const router  = express.Router();

const savedSearchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 15,
  message: { error: 'Demasiadas búsquedas guardadas. Intenta más tarde.' },
  standardHeaders: true, legacyHeaders: false,
});
const MAX_SAVED_SEARCHES = 10;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const { createTransport } = require('./mailer');
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

function formatPrice(p) {
  if (!p) return 'Consultar';
  const n = Number(p);
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000)    return '$' + Math.round(n / 1000) + 'K';
  return '$' + n.toLocaleString('es-DO');
}

async function sendSearchAlertEmail(user, search, newListings, totalNew) {
  const firstName = user.name.split(' ')[0];
  const filterDesc = describeFilters(search.filters);

  const listingCards = newListings.map(l => {
    const loc = [l.sector, l.city].filter(Boolean).join(', ');
    const specs = [
      l.bedrooms   ? `${l.bedrooms} hab.`     : '',
      l.bathrooms  ? `${l.bathrooms} baños`    : '',
      l.area_const ? `${l.area_const} m²`      : '',
    ].filter(Boolean).join(' · ');

    return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;border-radius:10px;overflow:hidden;border:1px solid #dce8f5;">
      <tr><td style="padding:16px 20px;background:#fff;">
        <div style="font-size:1.1rem;font-weight:800;color:#002D62;margin-bottom:2px;">${formatPrice(l.price)}</div>
        <div style="font-size:0.9rem;font-weight:600;color:#1a2b40;margin-bottom:4px;">${l.title}</div>
        <div style="font-size:0.78rem;color:#7a9bbf;margin-bottom:${specs ? '6px' : '12px'};">📍 ${loc}</div>
        ${specs ? `<div style="font-size:0.75rem;color:#4d6a8a;margin-bottom:12px;">${specs}</div>` : ''}
        <a href="${BASE_URL}/listing/${l.id}" style="display:inline-block;background:#002D62;color:#fff;font-size:0.8rem;font-weight:700;padding:8px 18px;border-radius:8px;text-decoration:none;">Ver propiedad →</a>
      </td></tr>
    </table>`;
  }).join('');

  const moreText = totalNew > newListings.length
    ? `<p style="font-size:0.85rem;color:#7a9bbf;text-align:center;margin-top:8px;">...y ${totalNew - newListings.length} más</p>`
    : '';

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#eef3fa;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fa;padding:28px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,45,98,0.10);">

  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="background:linear-gradient(135deg,#002D62,#1a5fa8);padding:28px 32px;">
      <div style="font-size:0.75rem;font-weight:800;color:rgba(255,255,255,0.6);letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">🔔 ALERTA DE BÚSQUEDA</div>
      <div style="font-size:1.3rem;font-weight:800;color:#fff;line-height:1.25;margin-bottom:6px;">
        ¡${totalNew === 1 ? 'Nueva propiedad encontrada' : totalNew + ' nuevas propiedades encontradas'}!
      </div>
      <div style="font-size:0.85rem;color:rgba(255,255,255,0.7);">Búsqueda: "${search.name}"</div>
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:24px 32px 8px;">
      <p style="margin:0 0 6px;font-size:0.92rem;color:#1a2b40;">Hola <strong>${firstName}</strong>,</p>
      <p style="margin:0 0 20px;font-size:0.88rem;color:#4d6a8a;line-height:1.6;">
        ${totalNew === 1 ? 'Hay una nueva propiedad que coincide' : `Hay ${totalNew} nuevas propiedades que coinciden`} con tu búsqueda guardada <strong>"${search.name}"</strong> (${filterDesc}).
      </p>
      ${listingCards}
      ${moreText}
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:16px 32px 28px;text-align:center;">
      <a href="${BASE_URL}/busquedas-guardadas" style="display:inline-block;background:#002D62;color:#fff;font-size:0.9rem;font-weight:700;padding:12px 36px;border-radius:10px;text-decoration:none;">Ver todas mis búsquedas →</a>
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:16px 32px;background:#f5f8fd;border-top:1px solid #dce8f5;">
      <p style="margin:0;font-size:0.72rem;color:#9ab0c8;text-align:center;line-height:1.7;">
        © ${new Date().getFullYear()} HogaresRD — República Dominicana<br/>
        Recibiste este correo por tu búsqueda guardada. Desactiva las alertas desde tu perfil.
      </p>
    </td></tr>
  </table>

</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  await transporter.sendMail({
    department: 'noreply',
    to:      user.email,
    subject: `🔔 ${totalNew === 1 ? 'Nueva propiedad' : totalNew + ' nuevas propiedades'} en "${search.name}" — HogaresRD`,
    html,
  });
}

module.exports = { router, checkSavedSearchMatches };
