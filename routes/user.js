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

// POST /api/user/activity — log a user event and rebuild profile if it's a view
router.post('/activity', userAuth, (req, res) => {
  const { type, listingId, metadata } = req.body;
  const validTypes = ['view_listing', 'search', 'favorite'];
  if (!type || !validTypes.includes(type))
    return res.status(400).json({ error: 'Tipo de evento inválido' });

  store.appendActivity({
    userId:    req.user.sub,
    type,
    listingId: listingId || null,
    metadata:  metadata  || {},
    timestamp: new Date().toISOString(),
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

// PATCH /api/user/profile — update mutable profile fields (name, phone)
router.patch('/profile', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { name, phone } = req.body;

  if (name !== undefined) {
    const trimmed = (name + '').trim();
    if (!trimmed) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
    user.name = trimmed;
  }

  if (phone !== undefined) {
    user.phone = (phone + '').trim();
  }

  store.saveUser(user);
  res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone } });
});

module.exports = router;
