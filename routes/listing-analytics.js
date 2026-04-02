const express    = require('express');
const store      = require('./store');
const { userAuth } = require('./auth');
const { logSec } = require('./security-log');

const router = express.Router();

// ── Auth: broker / agency / inmobiliaria only ───────────────────
router.use(userAuth, (req, res, next) => {
  const user = store.getUserById(req.user.sub);
  const allowed = ['agency', 'broker', 'inmobiliaria'];
  if (!user || !allowed.includes(user.role)) {
    logSec('role_violation', req, {
      userId:       req.user.sub,
      actualRole:   user?.role || 'unknown',
      requiredRole: 'broker|agency|inmobiliaria',
    });
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias pueden acceder' });
  }
  req.brokerUser = user;
  next();
});

// ── Helpers ──────────────────────────────────────────────────────

/** Get all approved listings belonging to this user (by agency user_id) */
function getMyListings(user) {
  const allListings = store.getListings(); // already filtered to approved
  if (user.role === 'inmobiliaria') {
    // Get all brokers under this inmobiliaria
    const teamIds = new Set(
      store.getUsersByInmobiliaria(user.id).map(b => b.id)
    );
    teamIds.add(user.id);
    return allListings.filter(l =>
      (l.agencies || []).some(a => a.user_id && teamIds.has(a.user_id))
    );
  }
  return allListings.filter(l =>
    (l.agencies || []).some(a => a.user_id === user.id)
  );
}

function parseRange(range) {
  const now = Date.now();
  if (range === '7d')  return new Date(now - 7  * 86400000);
  if (range === '30d') return new Date(now - 30 * 86400000);
  if (range === '90d') return new Date(now - 90 * 86400000);
  return null; // all time
}

function daysBetween(d1, d2) {
  return Math.max(1, Math.round(Math.abs(d2 - d1) / 86400000));
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

/** Count favorites across all users for a given listing ID */
function countFavorites(listingId) {
  return store.getUsers().filter(u =>
    Array.isArray(u.favorites) && u.favorites.includes(listingId)
  ).length;
}

/** Get tours for a set of listing IDs */
function getToursForListings(listingIds) {
  const idSet = new Set(listingIds);
  return store.getTours().filter(t => idSet.has(t.listing_id));
}

/** Build per-day view counts from activity log for given listing IDs */
function getViewTimeline(listingIds, since) {
  const idSet = new Set(listingIds);
  const activity = (function() {
    try {
      return require('fs').readFileSync(
        require('path').join(__dirname, '..', 'data', 'activity.json'), 'utf8'
      );
    } catch { return '[]'; }
  })();
  const events = JSON.parse(activity).filter(e =>
    e.type === 'view_listing' && e.listingId && idSet.has(e.listingId) &&
    (!since || new Date(e.timestamp) >= since)
  );
  const byDay = {};
  events.forEach(e => {
    const day = e.timestamp?.split('T')[0];
    if (day) byDay[day] = (byDay[day] || 0) + 1;
  });
  return byDay;
}

// ── GET /summary ─────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  try {
    const listings = getMyListings(req.brokerUser);
    const ids = listings.map(l => l.id);
    const range = parseRange(req.query.range);

    const totalViews = listings.reduce((sum, l) => sum + (l.views || 0), 0);
    const allTours   = getToursForListings(ids);
    const tours      = range
      ? allTours.filter(t => new Date(t.created_at) >= range)
      : allTours;
    const totalFavs  = ids.reduce((sum, id) => sum + countFavorites(id), 0);

    // Views trend (last 30 days)
    const thirtyAgo = new Date(Date.now() - 30 * 86400000);
    const viewsByDay = getViewTimeline(ids, thirtyAgo);
    const viewsTrend = [];
    for (let d = new Date(thirtyAgo); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = formatDate(d);
      viewsTrend.push({ date: key, views: viewsByDay[key] || 0 });
    }

    // Top performing (by views + tours*5 composite score)
    const tourCountMap = {};
    allTours.forEach(t => {
      tourCountMap[t.listing_id] = (tourCountMap[t.listing_id] || 0) + 1;
    });
    const scored = listings.map(l => ({
      id: l.id,
      title: l.title,
      city: l.city,
      province: l.province,
      price: l.price,
      image: l.images?.[0]?.url || l.images?.[0] || null,
      views: l.views || 0,
      tours: tourCountMap[l.id] || 0,
      favorites: countFavorites(l.id),
      score: (l.views || 0) + (tourCountMap[l.id] || 0) * 5,
    }));
    scored.sort((a, b) => b.score - a.score);

    res.json({
      total_listings: listings.length,
      total_views:    totalViews,
      total_tours:    tours.length,
      total_favorites: totalFavs,
      views_trend:    viewsTrend,
      top_performing: scored.slice(0, 5),
    });
  } catch (err) {
    console.error('Listing analytics summary error:', err);
    res.status(500).json({ error: 'Error al obtener analíticas' });
  }
});

// ── GET /listings ────────────────────────────────────────────────
router.get('/listings', (req, res) => {
  try {
    const listings = getMyListings(req.brokerUser);
    const allTours = getToursForListings(listings.map(l => l.id));
    const sort     = req.query.sort || 'views';

    const tourCountMap = {};
    allTours.forEach(t => {
      tourCountMap[t.listing_id] = (tourCountMap[t.listing_id] || 0) + 1;
    });

    const items = listings.map(l => {
      const approvedDate = l.approvedAt ? new Date(l.approvedAt) : new Date(l.submittedAt);
      const daysOnMarket = daysBetween(approvedDate, new Date());
      const views = l.views || 0;
      const toursCount = tourCountMap[l.id] || 0;
      const favs = countFavorites(l.id);

      return {
        id:             l.id,
        title:          l.title,
        city:           l.city,
        province:       l.province,
        price:          l.price,
        type:           l.type,
        condition:      l.condition,
        image:          l.images?.[0] || null,
        bedrooms:       l.bedrooms,
        bathrooms:      l.bathrooms,
        views,
        tours:          toursCount,
        favorites:      favs,
        days_on_market: daysOnMarket,
        conversion:     views > 0 ? ((toursCount / views) * 100).toFixed(1) : '0.0',
        status:         l.status,
        submittedAt:    l.submittedAt,
        approvedAt:     l.approvedAt,
      };
    });

    // Sort
    const sortFn = {
      views:      (a, b) => b.views - a.views,
      tours:      (a, b) => b.tours - a.tours,
      favorites:  (a, b) => b.favorites - a.favorites,
      days:       (a, b) => b.days_on_market - a.days_on_market,
      conversion: (a, b) => parseFloat(b.conversion) - parseFloat(a.conversion),
      price:      (a, b) => Number(b.price) - Number(a.price),
    };
    items.sort(sortFn[sort] || sortFn.views);

    res.json({ listings: items });
  } catch (err) {
    console.error('Listing analytics list error:', err);
    res.status(500).json({ error: 'Error al obtener listado' });
  }
});

// ── GET /listing/:id ─────────────────────────────────────────────
router.get('/listing/:id', (req, res) => {
  try {
    const listing = store.getListingById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

    // Verify ownership
    const user = req.brokerUser;
    const isOwner = user.role === 'inmobiliaria'
      ? (() => {
          const teamIds = new Set(store.getUsersByInmobiliaria(user.id).map(b => b.id));
          teamIds.add(user.id);
          return (listing.agencies || []).some(a => a.user_id && teamIds.has(a.user_id));
        })()
      : (listing.agencies || []).some(a => a.user_id === user.id);

    if (!isOwner) return res.status(403).json({ error: 'No tienes acceso a esta propiedad' });

    const tours = store.getToursByListing(listing.id);
    const favs  = countFavorites(listing.id);

    // Tour timeline (by day)
    const toursByDay = {};
    tours.forEach(t => {
      const day = t.created_at?.split('T')[0];
      if (day) toursByDay[day] = (toursByDay[day] || 0) + 1;
    });

    // Tour status breakdown
    const tourStatus = { pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
    tours.forEach(t => {
      if (tourStatus[t.status] !== undefined) tourStatus[t.status]++;
    });

    // Views timeline
    const thirtyAgo = new Date(Date.now() - 30 * 86400000);
    const viewsByDay = getViewTimeline([listing.id], thirtyAgo);
    const viewsTrend = [];
    for (let d = new Date(thirtyAgo); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = formatDate(d);
      viewsTrend.push({ date: key, views: viewsByDay[key] || 0 });
    }

    const approvedDate = listing.approvedAt ? new Date(listing.approvedAt) : new Date(listing.submittedAt);

    res.json({
      id:             listing.id,
      title:          listing.title,
      city:           listing.city,
      province:       listing.province,
      price:          listing.price,
      type:           listing.type,
      condition:      listing.condition,
      image:          listing.images?.[0] || null,
      bedrooms:       listing.bedrooms,
      bathrooms:      listing.bathrooms,
      views:          listing.views || 0,
      tours_count:    tours.length,
      favorites:      favs,
      days_on_market: daysBetween(approvedDate, new Date()),
      conversion:     (listing.views || 0) > 0
        ? (((tours.length) / (listing.views || 1)) * 100).toFixed(1)
        : '0.0',
      views_trend:    viewsTrend,
      tours_timeline: toursByDay,
      tour_status:    tourStatus,
    });
  } catch (err) {
    console.error('Listing analytics detail error:', err);
    res.status(500).json({ error: 'Error al obtener detalle' });
  }
});

module.exports = router;
