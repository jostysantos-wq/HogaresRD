'use strict';
const store = require('../routes/store');

// Rebuild user profile preferences from their 50 most recent view events
function rebuildProfile(user) {
  const events  = store.getActivityByUser(user.id, 50);
  const viewIds = [...new Set(
    events.filter(e => e.type === 'view_listing' && e.listingId).map(e => e.listingId)
  )];
  if (!viewIds.length) return;

  const listings = viewIds.map(id => store.getListingById(id)).filter(Boolean);
  if (!listings.length) return;

  const countBy = (arr, key) => {
    const map = {};
    arr.forEach(l => { if (l[key]) map[l[key]] = (map[l[key]] || 0) + 1; });
    return map;
  };
  const topN = (map, n) =>
    Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  const tagMap = {};
  const prices = [];
  const beds   = [];
  listings.forEach(l => {
    (l.tags || []).forEach(t => { tagMap[t] = (tagMap[t] || 0) + 1; });
    if (l.price)    prices.push(Number(l.price));
    if (l.bedrooms) beds.push(Number(l.bedrooms));
  });

  user.profile = {
    ...user.profile,
    preferredTypes:      topN(countBy(listings, 'type'), 3),
    preferredProvinces:  topN(countBy(listings, 'province'), 3),
    preferredCities:     topN(countBy(listings, 'city'), 5),
    preferredConditions: topN(countBy(listings, 'condition'), 3),
    preferredTags:       topN(tagMap, 15),
    priceMin:    prices.length ? Math.round(Math.min(...prices) * 0.8) : 0,
    priceMax:    prices.length ? Math.round(Math.max(...prices) * 1.2) : 0,
    bedroomsMin: beds.length   ? Math.min(...beds) : 0,
    scoredAt:    new Date().toISOString(),
  };
  store.saveUser(user);
}

function scoreListingForUser(listing, profile) {
  let score = 0;
  if (profile.preferredTypes.includes(listing.type))           score += 30;
  if (profile.preferredProvinces.includes(listing.province))   score += 20;
  if (profile.preferredCities.includes(listing.city))          score += 15;
  if (profile.preferredConditions.includes(listing.condition)) score += 15;

  const price = Number(listing.price);
  if (profile.priceMin && profile.priceMax &&
      price >= profile.priceMin && price <= profile.priceMax)  score += 25;

  const tagMatches = (listing.tags || [])
    .filter(t => profile.preferredTags.includes(t)).length;
  score += tagMatches * 5;

  if (profile.bedroomsMin && Number(listing.bedrooms) >= profile.bedroomsMin) score += 10;
  return score;
}

function getRecommendations(userId, limit = 10) {
  const user = store.getUserById(userId);
  if (!user || !user.profile || !user.profile.scoredAt) return [];

  const favorites = new Set(user.favorites || []);
  const profile   = user.profile;

  return store.getListings()
    .filter(l => !favorites.has(l.id))
    .map(l => ({ listing: l, score: scoreListingForUser(l, profile) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ listing }) => listing);
}

module.exports = { rebuildProfile, getRecommendations };
