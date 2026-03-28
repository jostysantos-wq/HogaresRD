const express = require('express');
const store   = require('./store');
const router  = express.Router();

// GET /api/listings?province=&city=&type=&condition=&priceMin=&priceMax=&bedroomsMin=&tags=&page=&limit=
router.get('/', (req, res) => {
  const filters = {
    province:    req.query.province    || '',
    city:        req.query.city        || '',
    type:        req.query.type        || '',
    condition:   req.query.condition   || '',
    priceMin:    req.query.priceMin    || '',
    priceMax:    req.query.priceMax    || '',
    bedroomsMin: req.query.bedroomsMin || '',
  };

  // Remove empty filters so store.getListings doesn't filter needlessly
  Object.keys(filters).forEach(k => { if (!filters[k]) delete filters[k]; });

  let listings = store.getListings(filters);

  // Tag filter (comma-separated, match ANY)
  if (req.query.tags) {
    const wanted = req.query.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (wanted.length) {
      listings = listings.filter(l =>
        Array.isArray(l.tags) && wanted.some(t => l.tags.includes(t))
      );
    }
  }

  // Sort: newest approved first
  listings.sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt));

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const total = listings.length;
  const items = listings.slice((page - 1) * limit, page * limit);

  res.json({ listings: items, total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/listings/trending — top 8 listings by view count in the last 7 days
router.get('/trending', (req, res) => {
  const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = store.getListingActivity(since);

  const counts = {};
  events.forEach(e => { counts[e.listingId] = (counts[e.listingId] || 0) + 1; });

  const listings = store.getListings()
    .filter(l => counts[l.id])
    .map(l => ({ ...l, _views: counts[l.id] }))
    .sort((a, b) => b._views - a._views)
    .slice(0, 8);

  res.json({ listings });
});

// GET /api/listings/:id
router.get('/:id', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });
  res.json(listing);
});

module.exports = router;
