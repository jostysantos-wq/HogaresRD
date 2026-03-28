const express  = require('express');
const store    = require('./store');
const { userAuth } = require('./auth');

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

module.exports = router;
