'use strict';
const store = require('../routes/store');

// Rebuild user profile preferences from their 50 most recent view events.
// Buying-power settings (price range, type, bedrooms) are preserved and
// take priority over browsing-derived values.
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

  const bp = user.buyingPower || null;

  // ── Price range: preserve buying-power value if explicitly set ──
  const bpMaxPrice = bp && bp.calculatedMaxPrice ? bp.calculatedMaxPrice : 0;
  const newPriceMin = bpMaxPrice
    ? user.profile.priceMin
    : (prices.length ? Math.round(Math.min(...prices) * 0.8) : 0);
  const newPriceMax = bpMaxPrice
    ? user.profile.priceMax
    : (prices.length ? Math.round(Math.max(...prices) * 1.2) : 0);

  // ── Bedrooms: preserve buying-power value; 0 = "any" is intentional ──
  const bpBedrooms = bp && bp.bedrooms != null ? bp.bedrooms : null;
  const newBedrooms = bpBedrooms !== null
    ? bpBedrooms
    : (beds.length ? Math.min(...beds) : 0);

  // ── Property type: buying-power type always stays at the front ──
  const browsedTypes  = topN(countBy(listings, 'type'), 3);
  const bpType        = bp && bp.propertyType ? bp.propertyType : null;
  let newTypes;
  if (bpType) {
    // Keep bp type first, then fill remaining slots with browsed types
    newTypes = [bpType, ...browsedTypes.filter(t => t !== bpType)].slice(0, 3);
  } else {
    newTypes = browsedTypes;
  }

  user.profile = {
    ...user.profile,
    preferredTypes:      newTypes,
    preferredProvinces:  topN(countBy(listings, 'province'), 3),
    preferredCities:     topN(countBy(listings, 'city'), 5),
    preferredConditions: topN(countBy(listings, 'condition'), 3),
    preferredTags:       topN(tagMap, 15),
    priceMin:            newPriceMin,
    priceMax:            newPriceMax,
    bedroomsMin:         newBedrooms,
    scoredAt:            new Date().toISOString(),
  };
  store.saveUser(user);
}

// Score a single listing against a user's profile + optional buying power.
// buyingPower is used as the primary price/type signal when present.
function scoreListingForUser(listing, profile, buyingPower) {
  let score = 0;
  if (profile.preferredTypes.includes(listing.type))           score += 30;
  if (profile.preferredProvinces.includes(listing.province))   score += 20;
  if (profile.preferredCities.includes(listing.city))          score += 15;
  if (profile.preferredConditions.includes(listing.condition)) score += 15;

  const price = Number(listing.price);

  if (buyingPower && buyingPower.calculatedMaxPrice) {
    // Only score price for listings of the same type as the buying power intent
    const sameType = !buyingPower.propertyType || listing.type === buyingPower.propertyType;
    if (sameType) {
      const max = buyingPower.calculatedMaxPrice;
      const min = max * 0.5; // sweet spot: 50–100% of budget
      if (price >= min && price <= max)   score += 35; // perfect fit
      else if (price > 0 && price <= max) score += 15; // under budget
      // Over budget = no price bonus
    }
  } else if (profile.priceMin && profile.priceMax &&
      price >= profile.priceMin && price <= profile.priceMax) {
    score += 25;
  }

  const tagMatches = (listing.tags || [])
    .filter(t => profile.preferredTags.includes(t)).length;
  score += tagMatches * 5;

  if (profile.bedroomsMin && Number(listing.bedrooms) >= profile.bedroomsMin) score += 10;
  return score;
}

function getRecommendations(userId, limit = 10) {
  const user = store.getUserById(userId);
  if (!user || !user.profile || !user.profile.scoredAt) return [];

  const favorites   = new Set(user.favorites || []);
  const profile     = user.profile;
  const buyingPower = user.buyingPower || null;

  return store.getListings()
    .filter(l => !favorites.has(l.id))
    // Type-aware budget filter: only apply price ceiling to the same listing type
    .filter(l => {
      if (!buyingPower || !buyingPower.calculatedMaxPrice) return true;
      // Don't filter out listings of a different type (e.g. don't apply venta
      // purchase budget to rental monthly prices)
      if (buyingPower.propertyType && l.type !== buyingPower.propertyType) return true;
      const price = Number(l.price);
      return !price || price <= buyingPower.calculatedMaxPrice * 1.1; // 10% tolerance
    })
    .map(l => ({ listing: l, score: scoreListingForUser(l, profile, buyingPower) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ listing }) => listing);
}

module.exports = { rebuildProfile, getRecommendations };
