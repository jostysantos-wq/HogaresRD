const express      = require('express');
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');
const { userAuth, optionalAuth } = require('./auth');
const router       = express.Router();

// Cache favorite counts (refreshed every 60s to avoid scanning all users per request)
let _favCache = {};
let _favCacheAt = 0;
function getFavoriteCounts() {
  if (Date.now() - _favCacheAt < 60_000) return _favCache;
  const counts = {};
  store.getUsers().forEach(u => {
    if (Array.isArray(u.favorites)) {
      u.favorites.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    }
  });
  _favCache = counts;
  _favCacheAt = Date.now();
  return counts;
}

function attachFavCounts(listings) {
  const counts = getFavoriteCounts();
  return listings.map(l => ({ ...l, favoriteCount: counts[l.id] || 0 }));
}

// ── Public view-counter rate limiter ────────────────────────────────────────
// One view increment per IP per listing per hour (no auth required).
const _viewSeen       = new Map(); // key: `${ip}::${listingId}` → last-seen ms
const VIEW_COOLDOWN   = 60 * 60 * 1000; // 1 hour
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

const { createTransport } = require('./mailer');
const transporter = createTransport();

// Cap an array to a max length and clamp string elements. Used to bound
// user-supplied list fields (amenities, tags, unit_types, agency strings)
// so an attacker can't persist a 50MB JSON blob.
function capArray(arr, maxItems, maxLen) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems).map(v => typeof v === 'string' ? v.slice(0, maxLen) : v);
}

// GET /api/listings?q=&province=&city=&type=&condition=&propertyType=&priceMin=&priceMax=&bedroomsMin=&tags=&page=&limit=
//
// Public endpoint: anonymous browsing of approved listings is allowed.
// optionalAuth populates req.user when a token is present so the
// `affiliated_to` filter (below) can verify the requester is authorized
// to query that user's affiliation graph.
router.get('/', optionalAuth, (req, res) => {
  const filters = {
    q:           req.query.q           || '',
    province:    req.query.province    || '',
    city:        req.query.city        || '',
    type:        req.query.type        || '',
    condition:   req.query.condition   || '',
    propertyType:req.query.propertyType|| '',
    priceMin:    req.query.priceMin    || '',
    priceMax:    req.query.priceMax    || '',
    bedroomsMin: req.query.bedroomsMin || '',
  };

  // Remove empty filters so store.getListings doesn't filter needlessly
  Object.keys(filters).forEach(k => { if (!filters[k]) delete filters[k]; });

  let listings = store.getListings(filters);

  // Owner filter — broker dashboard pages pass creator_user_id to scope
  // the response to the logged-in agent's portfolio. Backed by the same
  // /api/listings endpoint so we don't need a separate route.
  if (req.query.creator_user_id) {
    const ownerId = String(req.query.creator_user_id);
    listings = listings.filter(l =>
      String(l.creator_user_id || '') === ownerId ||
      String(l.inmobiliaria_id || '') === ownerId
    );
  }

  // Affiliation filter — broader than creator_user_id. Returns every
  // listing the given user could legitimately credit themselves on
  // (their own listings, listings their inmobiliaria created, listings
  // where they appear in `agencies[]` directly or through their parent
  // inmobiliaria, and listings whose agency card shares their email or
  // phone tail). Mirrors isReferrerAffiliatedWithListing in
  // routes/applications.js so the affiliate-link picker on
  // /enlaces-de-referido stays in sync with the routing decision.
  //
  // SECURITY: this filter exposes the affiliation graph (which agent is
  // tied to which listings), so it MUST require the requester to be the
  // queried user themselves OR an admin. Without this gate, a scraper
  // could enumerate user ids and dump the entire agent-listing map.
  if (req.query.affiliated_to) {
    const uid = String(req.query.affiliated_to);
    const me = req.user || null;
    const meRecord = me?.sub ? store.getUserById(me.sub) : null;
    const isAdmin  = meRecord?.role === 'admin';
    const authorized = !!me && (String(me.sub) === uid || isAdmin);
    const u = authorized ? store.getUserById(uid) : null;
    if (authorized && u) {
      const refEmail = (u.email || '').toLowerCase();
      const refPhoneTail = String(u.phone || '').replace(/\D/g, '').slice(-8);
      const refInmId = u.inmobiliaria_id || null;
      listings = listings.filter(l => {
        if (String(l.creator_user_id || '') === uid) return true;
        if (String(l.inmobiliaria_id || '') === uid) return true;
        if (refInmId && String(l.inmobiliaria_id || '') === String(refInmId)) return true;
        const agencies = Array.isArray(l.agencies) ? l.agencies : [];
        for (const a of agencies) {
          if (!a) continue;
          if (a.user_id && (String(a.user_id) === uid || (refInmId && String(a.user_id) === String(refInmId)))) return true;
          if (a.inmobiliaria && (String(a.inmobiliaria) === uid || (refInmId && String(a.inmobiliaria) === String(refInmId)))) return true;
          if (a.email && refEmail && String(a.email).toLowerCase() === refEmail) return true;
          if (refPhoneTail && refPhoneTail.length >= 8) {
            const tail = String(a.phone || '').replace(/\D/g, '').slice(-8);
            if (tail.length >= 8 && tail === refPhoneTail) return true;
          }
        }
        return false;
      });
    } else {
      listings = [];
    }
  }

  // Tag filter (comma-separated, match ANY)
  if (req.query.tags) {
    const wanted = req.query.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (wanted.length) {
      listings = listings.filter(l =>
        Array.isArray(l.tags) && wanted.some(t => l.tags.includes(t))
      );
    }
  }

  // Agency filter (by slug)
  if (req.query.agency) {
    const slug = req.query.agency;
    listings = listings.filter(l =>
      (l.agencies || []).some(a =>
        a.name && a.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
      )
    );
  }

  // Constructora filter (by slug)
  if (req.query.constructora) {
    const slug = req.query.constructora;
    listings = listings.filter(l =>
      l.construction_company &&
      l.construction_company.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
    );
  }

  // App Store Review 1.2 — when the caller is logged in, hide listings
  // whose creator (or any agency-card user_id) is in the caller's block
  // list. Anonymous browsers see the full feed; this only applies once
  // the user has identified themselves and chosen to block someone.
  if (req.user?.sub) {
    const blocked = new Set(store.getBlockedUserIds(req.user.sub));
    if (blocked.size > 0) {
      listings = listings.filter(l => {
        if (l.creator_user_id && blocked.has(l.creator_user_id)) return false;
        if (l.inmobiliaria_id && blocked.has(l.inmobiliaria_id)) return false;
        const agencies = Array.isArray(l.agencies) ? l.agencies : [];
        return !agencies.some(a => a?.user_id && blocked.has(a.user_id));
      });
    }
  }

  // Sort: newest approved first
  listings.sort((a, b) => new Date(b.approvedAt || b.submittedAt) - new Date(a.approvedAt || a.submittedAt));

  // Pagination — clamp to safe ranges so bad query params can't produce
  // NaN/negative slice indices or huge pages.
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const total = listings.length;
  const items = listings.slice((page - 1) * limit, page * limit);

  // Rating aggregate snapshot — one O(M) scan over tours per request,
  // grouped into a Map. Attached only to the paginated slice so a
  // 1000-item index doesn't pay the per-row cost. Cards use this
  // pre-computed pair to render "★ 4.5 (12)" without an extra fetch.
  const tourAgg = {};
  for (const t of store.getTours()) {
    if (!t.feedback_rating || !t.listing_id) continue;
    const lid = t.listing_id;
    if (!tourAgg[lid]) tourAgg[lid] = { sum: 0, count: 0 };
    tourAgg[lid].sum   += t.feedback_rating;
    tourAgg[lid].count += 1;
  }
  for (const l of items) {
    const a = tourAgg[l.id];
    if (a && a.count > 0) {
      l.rating_average = Math.round((a.sum / a.count) * 10) / 10;
      l.rating_count   = a.count;
    }
  }

  res.json({ listings: attachFavCounts(items), total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/listings/trending — top 8 by combined score: total public views + recent auth views (3×)
router.get('/trending', (req, res) => {
  const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = store.getListingActivity(since);

  // Recent authenticated-user views (last 7 days) — weighted 3× for recency signal
  const recentCounts = {};
  events.forEach(e => { recentCounts[e.listingId] = (recentCounts[e.listingId] || 0) + 1; });

  const listings = store.getListings()
    .map(l => {
      const totalViews  = l.views || 0;
      const recentViews = recentCounts[l.id] || 0;
      return { ...l, _views: totalViews, _score: totalViews + recentViews * 3 };
    })
    .filter(l => l._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8);

  res.json({ listings: attachFavCounts(listings) });
});

// GET /api/listings/agent/:refToken — public: resolve affiliate token to agent name/agency
router.get('/agent/:refToken', (req, res) => {
  const agent = store.getUserByRefToken(req.params.refToken);
  const agentRoles = ['agency', 'broker', 'inmobiliaria', 'constructora'];
  if (!agent || !agentRoles.includes(agent.role))
    return res.status(404).json({ error: 'Agente no encontrado' });
  res.json({ name: agent.name, agencyName: agent.agencyName || agent.companyName || agent.name });
});

// GET /api/listings/facets — per-facet counts for the current filter
// state. The frontend uses these to decorate filter dropdowns with
// "(N)" badges so the user can see how many results each option will
// produce. The query string accepts the same filters as GET /api/
// listings — counts are computed by *removing* one filter at a time
// so the counts shown next to each option don't depend on whether
// that option is currently selected (NN/G's "open faceted search"
// pattern).
router.get('/facets', (req, res) => {
  const all = store.getListings().filter(l => l.status !== 'pending' && l.status !== 'rejected');

  const FACETS = {
    type:          l => l.type,
    property_type: l => l.property_type,
    condition:     l => l.condition,
    bedrooms:      l => l.bedrooms,
    province:      l => l.province,
  };

  // Apply every active filter EXCEPT the one we're counting for.
  function applyFiltersExcept(skipKey) {
    return all.filter(l => {
      for (const k of Object.keys(FACETS)) {
        if (k === skipKey) continue;
        const want = String(req.query[k] || '').trim();
        if (!want) continue;
        if (k === 'bedrooms') {
          // Numeric "X+" filter
          const min = parseInt(want, 10);
          const have = parseInt(l.bedrooms, 10);
          if (!Number.isFinite(min) || !Number.isFinite(have) || have < min) return false;
        } else if (String(FACETS[k](l) || '') !== want) {
          return false;
        }
      }
      // Price range
      const pMin = parseFloat(req.query.priceMin);
      const pMax = parseFloat(req.query.priceMax);
      const p = parseFloat(l.price);
      if (Number.isFinite(pMin) && p < pMin) return false;
      if (Number.isFinite(pMax) && p > pMax) return false;
      return true;
    });
  }

  const facets = {};
  for (const key of Object.keys(FACETS)) {
    const subset = applyFiltersExcept(key);
    const counts = {};
    for (const l of subset) {
      const v = FACETS[key](l);
      if (v == null || v === '') continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    facets[key] = counts;
  }

  res.json({ facets, total: applyFiltersExcept(null).length });
});

// GET /api/agencies — list all agencies with listing counts
router.get('/agencies', (req, res) => {
  const listings = store.getListings();
  const map = {};
  listings.forEach(l => {
    (l.agencies || []).forEach(a => {
      if (!a.name) return;
      const slug = String(a.name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!map[slug]) map[slug] = { name: a.name, slug, count: 0 };
      map[slug].count++;
    });
  });
  const agencies = Object.values(map).sort((a, b) => b.count - a.count);
  res.json({ agencies });
});

// GET /api/inmobiliarias — list all REGISTERED inmobiliaria users.
// Unlike /api/agencies (which aggregates names across existing
// listings), this one queries the user table so the submit form can
// surface actual accounts in a searchable dropdown — letting brokers
// link a new listing to a specific inmobiliaria that has a user.
router.get('/inmobiliarias', (req, res) => {
  const inm   = store.getUsersByRole ? store.getUsersByRole('inmobiliaria') : [];
  const cons  = store.getUsersByRole ? store.getUsersByRole('constructora') : [];
  const users = [...(inm || []), ...(cons || [])];
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const list = users
    .map(u => ({
      id:          u.id,
      name:        u.name || u.companyName || u.email || '',
      companyName: u.companyName || u.agencyName || u.name || '',
      email:       u.email || '',
      phone:       u.phone || '',
      logo:        u.logoUrl || u.avatarUrl || null,
      role:        u.role,
    }))
    .filter(u => u.name); // drop anonymous records
  // Fuzzy filter by q if provided
  const filtered = q
    ? list.filter(u => {
        const hay = `${u.name} ${u.companyName} ${u.email}`.toLowerCase();
        return hay.includes(q);
      })
    : list;
  // Sort alphabetically for a stable dropdown
  filtered.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  res.json({ inmobiliarias: filtered });
});

// GET /api/listings/constructoras — list all construction companies with listing counts
router.get('/constructoras', (req, res) => {
  const listings = store.getListings();
  const map = {};
  listings.forEach(l => {
    if (!l.construction_company) return;
    const name = String(l.construction_company);
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!map[slug]) map[slug] = { name, slug, count: 0 };
    map[slug].count++;
  });
  const constructoras = Object.values(map).sort((a, b) => b.count - a.count);
  res.json({ constructoras });
});

// GET /api/agencies/:slug — agency details + their listings
router.get('/agencies/:slug', (req, res) => {
  const { slug } = req.params;
  const listings = store.getListings();
  const matched = listings.filter(l =>
    (l.agencies || []).some(a =>
      a.name && a.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
    )
  );
  if (!matched.length) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });
  const agencyObj = matched[0].agencies.find(a =>
    a.name && a.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') === slug
  );
  if (!agencyObj) return res.status(404).json({ error: 'Agencia no encontrada' });
  const agencyName = agencyObj.name;

  // Look up the registered user for this agency to get their refToken + profile
  const agencyUser = agencyObj.email ? store.getUserByEmail(agencyObj.email) : null;
  const refToken   = agencyUser?.refToken || null;

  // Enrich with company profile, team, posts, reviews
  let companyProfile = {};
  let team = [];
  let posts = [];
  let reviews = { items: [], average: null, count: 0 };

  if (agencyUser) {
    const rawProfile = typeof agencyUser.profile === 'string'
      ? (JSON.parse(agencyUser.profile || '{}')) : (agencyUser.profile || {});
    companyProfile = {
      ...rawProfile,
      companyLogo: agencyUser.avatarUrl || rawProfile.companyLogo || null,
      phone: agencyUser.phone || null,
      email: agencyUser.email || null,
    };

    // Team members (if inmobiliaria/constructora) — include owner as lead
    if (['inmobiliaria', 'constructora'].includes(agencyUser.role)) {
      // Owner first
      team.push({
        name: agencyUser.name, role: agencyUser.role,
        jobTitle: agencyUser.jobTitle || agencyUser.team_title || 'Director',
        avatarUrl: agencyUser.avatarUrl || null,
      });
      // Then team members
      const members = store.getUsersByInmobiliaria(agencyUser.id);
      for (const m of members) {
        team.push({
          name: m.name, role: m.role, jobTitle: m.jobTitle || m.team_title || 'Agente',
          avatarUrl: m.avatarUrl || null,
        });
      }
    }

    // Posts
    posts = store.getPublishedInmobPosts(agencyUser.id)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 20);

    // Reviews
    const approvedReviews = store.getApprovedInmobReviews(agencyUser.id);
    const avg = approvedReviews.length
      ? (approvedReviews.reduce((s, r) => s + r.rating, 0) / approvedReviews.length).toFixed(1)
      : null;
    reviews = { items: approvedReviews, average: avg ? parseFloat(avg) : null, count: approvedReviews.length };
  }

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 12);
  const total = matched.length;
  const items = matched.slice((page - 1) * limit, page * limit);

  res.json({
    name: agencyName, slug, refToken, inmobiliariaId: agencyUser?.id || null,
    profile: companyProfile, team, posts, reviews,
    listings: attachFavCounts(items), total, page, limit, pages: Math.ceil(total / limit),
  });
});

// GET /api/listings/:id
// Approved listings are visible to everyone. Non-approved listings
// (pending / edits_requested / rejected) are only returned to their
// owner or an admin so the owner can re-edit & resubmit them.
router.get('/:id', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  if (listing.status === 'approved') {
    // Enrich agency with current avatar if available
    if (listing.agency?.user_id) {
      const agentUser = store.getUserById(listing.agency.user_id);
      if (agentUser) listing.agency.avatarUrl = agentUser.avatarUrl || null;
    }
    // Rating aggregate from tour feedback — same shape as the list
    // endpoint emits, so iOS Listing decoder gets identical fields
    // whether it loaded from /api/listings or /api/listings/:id.
    const lTours = store.getToursByListing(listing.id)
      .filter(t => t.feedback_rating);
    if (lTours.length > 0) {
      const sum = lTours.reduce((s, t) => s + (t.feedback_rating || 0), 0);
      listing.rating_average = Math.round((sum / lTours.length) * 10) / 10;
      listing.rating_count   = lTours.length;
    }
    return res.json(listing);
  }

  // Non-approved: require auth and ownership (or admin)
  const { verifyJWT } = require('./auth');
  let user = null;
  let tokenPayload = null;
  try {
    const token = req.cookies?.hrdt || (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (token) {
      tokenPayload = verifyJWT(token);
      user = store.getUserById(tokenPayload.sub);
    }
  } catch {}

  // If user is authenticated, check whether their token has been revoked
  // (logout / blacklist). Without this, a revoked token could still read
  // pending/rejected listings via this endpoint.
  if (tokenPayload && tokenPayload.jti && store.isTokenRevoked(tokenPayload.jti)) {
    return res.status(401).json({ error: 'Sesión revocada' });
  }

  if (!user) return res.status(404).json({ error: 'Propiedad no encontrada' });

  const isOwner = listing.creator_user_id === user.id
               || (listing.email && listing.email.toLowerCase() === (user.email || '').toLowerCase());
  const isAdmin = user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return res.status(404).json({ error: 'Propiedad no encontrada' });
  }

  res.json(listing);
});

// POST /api/listings/:id/view — public, anonymous view counter (rate-limited per IP per hour)
router.post('/:id/view', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Not found' });

  const ip  = clientIp(req);
  const key = `${ip}::${listing.id}`;
  const now = Date.now();

  if ((now - (_viewSeen.get(key) || 0)) > VIEW_COOLDOWN) {
    _viewSeen.set(key, now);
    listing.views = (listing.views || 0) + 1;
    store.saveListing(listing);
  }

  res.json({ views: listing.views || 0 });
});

// POST /api/listings/:id/like — toggle like for the authenticated user.
// One like per user per listing (prevents the "infinity likes" bug where
// the iOS feed card was only incrementing a local counter). The per-user
// set of liked listing IDs is stored on the user record alongside favorites.
// Body: { liked: true|false }  (optional — defaults to toggle)
router.post('/:id/like', userAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  if (!Array.isArray(user.likedListings)) user.likedListings = [];
  const idx = user.likedListings.indexOf(listing.id);
  const alreadyLiked = idx >= 0;

  // Respect explicit liked:true/false when provided, otherwise toggle.
  let shouldLike;
  if (typeof req.body?.liked === 'boolean') {
    shouldLike = req.body.liked;
  } else {
    shouldLike = !alreadyLiked;
  }

  if (shouldLike && !alreadyLiked) {
    user.likedListings.push(listing.id);
    listing.likeCount = (listing.likeCount || 0) + 1;
  } else if (!shouldLike && alreadyLiked) {
    user.likedListings.splice(idx, 1);
    listing.likeCount = Math.max(0, (listing.likeCount || 0) - 1);
  }

  store.saveUser(user);
  store.saveListing(listing);

  res.json({
    liked:     shouldLike,
    likeCount: listing.likeCount || 0,
  });
});

// GET /api/listings/:id/like — return current like state for the authed user
router.get('/:id/like', userAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  const user = store.getUserById(req.user.sub);
  const liked = Array.isArray(user?.likedListings) && user.likedListings.includes(listing.id);
  res.json({ liked, likeCount: listing.likeCount || 0 });
});

// POST /api/listings/:id/inquiry — send client inquiry to all affiliated agencies
const rateLimit = require('express-rate-limit');
const inquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: false, legacyHeaders: false,
  message: { error: 'Demasiadas consultas. Intenta de nuevo en una hora.' } });
router.post('/:id/inquiry', inquiryLimiter, async (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const { name, phone, email, message, refToken } = req.body;
  if (!name || !phone || !email)
    return res.status(400).json({ error: 'Nombre, teléfono y correo son requeridos' });

  // Prevent self-inquiry — user can't send inquiry to themselves
  const submitterEmail = email.toLowerCase().trim();
  const ownerEmails = new Set();
  if (listing.email) ownerEmails.add(listing.email.toLowerCase());
  if (Array.isArray(listing.agencies)) {
    listing.agencies.forEach(a => { if (a.email) ownerEmails.add(a.email.toLowerCase()); });
  }
  if (ownerEmails.has(submitterEmail)) {
    return res.status(400).json({ error: 'No puedes enviar una consulta sobre tu propia propiedad.' });
  }

  // If refToken provided, route to referring agent (or org's agents for inmobiliaria)
  let agencyEmails = [];
  let agencyNames  = 'las inmobiliarias afiliadas';
  const refAgent   = refToken ? store.getUserByRefToken(refToken) : null;
  const agentRoles = ['agency', 'broker'];
  const orgRoles   = ['inmobiliaria', 'constructora'];

  if (refAgent && agentRoles.includes(refAgent.role)) {
    // Individual agent — route directly to them
    agencyEmails = [refAgent.email];
    agencyNames  = `${refAgent.name}${refAgent.agencyName ? ' de ' + refAgent.agencyName : ''}`;
  } else if (refAgent && orgRoles.includes(refAgent.role)) {
    // Inmobiliaria/Constructora — route to ALL agents in the organization
    const teamMembers = store.getUsersByInmobiliaria(refAgent.id);
    agencyEmails = [refAgent.email, ...teamMembers.map(m => m.email)].filter(Boolean);
    agencyEmails = [...new Set(agencyEmails)]; // dedupe
    agencyNames  = refAgent.companyName || refAgent.name;
  } else {
    // No valid refToken — fall back to listing's affiliated agencies
    const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
    agencyEmails   = agencies.map(a => a.email).filter(Boolean);
    agencyNames    = agencies.map(a => a.name).join(', ') || 'las inmobiliarias afiliadas';
    if (!agencyEmails.length && listing.email) agencyEmails.push(listing.email);
  }
  const listingUrl  = `${process.env.BASE_URL || 'http://localhost:3000'}/listing/${listing.id}`;

  const et = require('../utils/email-templates');
  const agentHtml = et.layout({
    title: 'Nueva consulta recibida',
    subtitle: listing.title,
    preheader: `Nueva consulta sobre ${listing.title}`,
    body: et.p('Un cliente esta interesado en esta propiedad.')
        + et.infoTable(
            et.infoRow('Cliente', name)
          + et.infoRow('Telefono', `<a href="tel:${phone}" style="color:#002D62;font-weight:700;">${phone}</a>`)
          + et.infoRow('Correo', `<a href="mailto:${email}" style="color:#002D62;">${email}</a>`)
          + (message ? et.infoRow('Mensaje', message) : '')
        )
        + et.alertBox('Esta consulta fue enviada a todas las inmobiliarias afiliadas. El primer agente en contactar al cliente tiene ventaja.', 'info')
        + et.button('Ver anuncio', listingUrl),
  });

  const clientHtml = et.layout({
    title: 'Consulta recibida',
    subtitle: 'HogaresRD',
    preheader: `Tu consulta sobre ${listing.title} fue enviada`,
    body: et.p('Hola <strong>' + et.esc(name) + '</strong>,')
        + et.p('Tu consulta sobre <strong>' + et.esc(listing.title) + '</strong> fue enviada exitosamente a ' + agencyNames + '. Un agente se pondra en contacto contigo pronto al numero <strong>' + phone + '</strong>.')
        + et.button('Ver propiedad', listingUrl)
        + et.divider()
        + et.small('Tambien puedes chatear directamente con el agente desde la pagina de la propiedad.'),
  });

  try {
    const sends = agencyEmails.map(to =>
      transporter.sendMail({
        to,
        subject: `Nueva consulta: ${listing.title}`,
        html:    agentHtml,
      })
    );
    sends.push(transporter.sendMail({
      to:      email,
      subject: 'Tu consulta fue enviada — HogaresRD',
      html:    clientHtml,
    }));
    await Promise.all(sends);
  } catch (err) {
    console.error('Inquiry email error:', err.message);
  }

  res.json({ success: true });
});

// ── PUT /api/listings/:id  — Owner edits their own listing ──────────────
// Allowed states for editing: 'pending', 'edits_requested', or 'approved'.
// - pending / edits_requested → after save, status flips to 'pending' so
//   the admin picks it back up in the moderation queue.
// - approved → saves in place; the change is live immediately. We still
//   log it in editsHistory so admins can audit.
router.put('/:id', userAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  const isAdmin    = user.role === 'admin';
  const isOwner    = listing.creator_user_id === user.id;
  const isOrgOwner = ['inmobiliaria', 'constructora'].includes(user?.role) && listing.inmobiliaria_id === user.id;

  if (!isOwner && !isOrgOwner && !isAdmin) {
    return res.status(403).json({ error: 'No autorizado para editar esta propiedad' });
  }

  const editableStates = ['pending', 'edits_requested', 'approved'];
  if (!editableStates.includes(listing.status)) {
    return res.status(400).json({ error: `No se puede editar una propiedad en estado '${listing.status}'` });
  }

  // ── Whitelist of editable fields ────────────────────────────────
  // Anything outside this list is ignored, so clients can't flip
  // ownership, status, or other admin-controlled flags. Field names
  // match the POST /submit handler so the edit form can reuse its
  // exact payload shape.
  const FIELDS = [
    // Basic
    'title', 'description', 'type', 'propertyType', 'condition',
    // Pricing — priceMax is the upper bound for price-range listings
    'price', 'priceMax', 'currency', 'priceDOP',
    // Specs
    'bedrooms', 'bathrooms', 'parking',
    'area_const', 'area_land',
    'floors', 'floor_num', 'yearBuilt',
    // Location
    'province', 'city', 'sector', 'address', 'referencePoint',
    'lat', 'lng',
    // Lists
    'amenities', 'tags', 'images', 'blueprints', 'feed_image', 'feed_focal',
    // Project
    'construction_company', 'units_total', 'units_available',
    'delivery_date', 'project_stage', 'unit_types',
    // Agencies
    'agencies',
    // Submitter contact (matches POST /submit: name/email/phone/role)
    'name', 'email', 'phone', 'role', 'contact_pref',
  ];

  const incoming = req.body || {};

  // Defensive normalization for image arrays. The submit form stores
  // photos as {url, label} objects, but a serialization bug in the
  // edit form previously stringified objects into "[object Object]"
  // strings and overwrote the real URLs. Reject anything that doesn't
  // look like a real URL — plain strings pass through, objects get
  // flattened to {url, label}, everything else is dropped.
  const MAX_MEDIA = 100; // guard against unbounded arrays
  const sanitizeMedia = (arr, fieldName) => {
    if (!Array.isArray(arr)) return arr;
    const out = [];
    for (const item of arr) {
      if (typeof item === 'string') {
        // Must look like a real path; reject "[object Object]" and friends
        if (item.startsWith('/') || item.startsWith('http')) {
          out.push(item);
        }
      } else if (item && typeof item === 'object' && typeof item.url === 'string') {
        if (item.url.startsWith('/') || item.url.startsWith('http')) {
          out.push({ url: item.url, label: typeof item.label === 'string' ? item.label : '' });
        }
      }
    }
    return out.slice(0, MAX_MEDIA);
  };
  if (Array.isArray(incoming.images)) incoming.images = sanitizeMedia(incoming.images, 'images');
  if (Array.isArray(incoming.blueprints)) incoming.blueprints = sanitizeMedia(incoming.blueprints, 'blueprints');

  // Cap user-supplied list fields so an attacker can't persist megabytes of
  // JSON via amenities/tags/unit_types/agencies. Each list item is also
  // truncated to a reasonable max length.
  if (Array.isArray(incoming.amenities))  incoming.amenities  = capArray(incoming.amenities,  50, 100);
  if (Array.isArray(incoming.tags))       incoming.tags       = capArray(incoming.tags,       20, 40);
  if (Array.isArray(incoming.unit_types)) incoming.unit_types = capArray(incoming.unit_types, 30, 200);
  if (Array.isArray(incoming.agencies)) {
    incoming.agencies = incoming.agencies.slice(0, 50).map(a => {
      if (!a || typeof a !== 'object') return a;
      const out = { ...a };
      if (typeof out.name === 'string')    out.name    = out.name.slice(0, 200);
      if (typeof out.contact === 'string') out.contact = out.contact.slice(0, 200);
      if (typeof out.email === 'string')   out.email   = out.email.slice(0, 200);
      if (typeof out.phone === 'string')   out.phone   = out.phone.slice(0, 200);
      return out;
    });
  }

  // Extra safety: if the sanitized images array is EMPTY but the
  // existing listing had images, block the update. This prevents a
  // buggy client from accidentally wiping all photos.
  if (Array.isArray(incoming.images) && incoming.images.length === 0
      && Array.isArray(listing.images) && listing.images.length > 0) {
    return res.status(400).json({
      error: 'No se puede eliminar todas las fotos de una propiedad. Sube al menos una foto válida.',
      code:  'images_cannot_be_empty',
    });
  }

  const changes  = [];
  for (const key of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      const newVal = incoming[key];
      if (JSON.stringify(listing[key]) !== JSON.stringify(newVal)) {
        listing[key] = newVal;
        changes.push(key);
      }
    }
  }

  if (changes.length === 0) {
    return res.status(400).json({ error: 'No hay cambios que guardar' });
  }

  listing.updatedAt = new Date().toISOString();
  listing.editsHistory = Array.isArray(listing.editsHistory) ? listing.editsHistory : [];
  listing.editsHistory.push({
    at:      listing.updatedAt,
    by:      isAdmin ? 'admin' : user.id,
    byRole:  user.role,
    changes,
    fromStatus: listing.status,
  });

  const wasInReview = listing.status === 'edits_requested' || listing.status === 'pending';
  if (wasInReview) {
    // Resubmitting: go back into the admin queue and clear the edits note
    listing.status           = 'pending';
    listing.resubmittedAt    = listing.updatedAt;
    listing.rejectedAt       = null;
    // Keep editsReason for history but clear the "active" reminder so the
    // owner's banner disappears after resubmit.
    listing.editsReasonActive = false;
  }

  store.saveListing(listing);
  res.json({
    success: true,
    listing,
    requeued: wasInReview,
    changes,
  });
});

// ── DELETE /api/listings/:id  — Owner deletes their own listing ─────────
router.delete('/:id', userAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  const isAdmin    = user.role === 'admin';
  const isOwner    = listing.creator_user_id === user.id;
  const isOrgOwner = ['inmobiliaria', 'constructora'].includes(user.role) && listing.inmobiliaria_id === user.id;

  if (!isOwner && !isOrgOwner && !isAdmin) {
    return res.status(403).json({ error: 'No autorizado para eliminar esta propiedad' });
  }

  store.deleteListing(req.params.id);
  res.json({ success: true });
});

// ── POST /:id/request-affiliation — Agent requests to affiliate with a listing
const crypto = require('crypto');
const { notify: pushNotify } = require('./push');
const et = require('../utils/email-templates');
const PRO_ROLES = ['broker', 'agency', 'inmobiliaria', 'constructora'];
const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';

router.post('/:id/request-affiliation', userAuth, (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes e inmobiliarias pueden solicitar afiliación' });

  // Check if already affiliated
  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  if (agencies.some(a => a.user_id === user.id))
    return res.status(400).json({ error: 'Ya estás afiliado a esta propiedad' });

  // Check for existing pending request
  const allSubmissions = store.getAllSubmissions();
  const pending = allSubmissions.find(s =>
    s.submission_type === 'agency_claim' &&
    s.claim_listing_id === listing.id &&
    s.status === 'pending' &&
    s.creator_user_id === user.id
  );
  if (pending)
    return res.status(400).json({ error: 'Ya tienes una solicitud pendiente para esta propiedad' });

  // Create agency claim submission
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  let claimId = `${l1}${l2}${num}`;
  if (store.getListingById(claimId)) claimId = 'CL_' + crypto.randomUUID().slice(0, 8);

  const submission = {
    id: claimId,
    creator_user_id: user.id,
    submission_type: 'agency_claim',
    claim_listing_id: listing.id,
    title: '', type: '', property_type: '', condition: '', price: '', currency: 'DOP',
    description: '', province: '', city: '', sector: '', address: '',
    bedrooms: '', bathrooms: '', area: '', parking: '',
    amenities: [], images: [], blueprints: [], tags: [], unit_types: [],
    agencies: [{
      name:         user.companyName || user.agencyName || user.name,
      user_id:      user.id,
      inmobiliaria: user.inmobiliaria_id || (PRO_ROLES.slice(2).includes(user.role) ? user.id : null),
      email:        user.email || '',
      phone:        user.phone || '',
      agent:        user.name || '',
    }],
    name:  user.name || '',
    email: user.email || '',
    phone: user.phone || '',
    role:  user.role,
    status: 'pending',
    submittedAt: new Date().toISOString(),
  };

  store.saveListing(submission);

  // Notify admin
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';
  transporter.sendMail({
    to: ADMIN_EMAIL,
    subject: `Solicitud de afiliación — ${user.name} → ${listing.title}`,
    html: et.layout({
      title: 'Nueva solicitud de afiliación',
      body: et.p(`<strong>${et.esc(user.name)}</strong> (${et.esc(user.role)}) solicita afiliarse a:`)
        + et.infoTable(
            et.infoRow('Propiedad', et.esc(listing.title))
          + et.infoRow('ID', listing.id)
          + et.infoRow('Agente', et.esc(user.name))
          + et.infoRow('Email', et.esc(user.email))
          + et.infoRow('Teléfono', et.esc(user.phone || ''))
        )
        + et.button('Revisar en Admin', `${BASE_URL}/${process.env.ADMIN_PATH || 'admin'}`),
    }),
  }).catch(() => {});

  res.json({ ok: true, message: 'Solicitud enviada. El equipo de HogaresRD revisará tu solicitud.' });
});

// ══════════════════════════════════════════════════════════════════
// ── POST /:id/feed-image — Generate portrait feed crop from focal point
// ══════════════════════════════════════════════════════════════════
const sharp = require('sharp');
const { uploadToSpaces, isConfigured: spacesConfigured } = require('../utils/spaces');

router.post('/:id/feed-image', userAuth, async (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  // Auth: listing owner, org member, or admin
  const user = store.getUserById(req.user.sub);
  const isOwner = listing.creator_user_id === req.user.sub;
  const isOrg = user?.inmobiliaria_id && listing.inmobiliaria_id === user.inmobiliaria_id;
  const isAdmin = user?.role === 'admin';
  if (!isOwner && !isOrg && !isAdmin)
    return res.status(403).json({ error: 'No autorizado' });

  const { feedImageUrl } = req.body;
  const useCustomUpload = typeof feedImageUrl === 'string' && feedImageUrl.length > 0;

  try {
    let sourceBuf;
    let feedFocal;

    if (useCustomUpload) {
      // ── Custom portrait upload — fetch user-supplied image directly ──
      const fullUrl = feedImageUrl.startsWith('http')
        ? feedImageUrl
        : `${process.env.BASE_URL || 'https://hogaresrd.com'}${feedImageUrl}`;
      const imgRes = await fetch(fullUrl);
      if (!imgRes.ok) throw new Error('No se pudo descargar la imagen subida');
      sourceBuf = Buffer.from(await imgRes.arrayBuffer());
      feedFocal = { source: 'custom', url: feedImageUrl };
    } else {
      // ── Focal-point crop from an existing listing photo ──
      const { imageIndex = 0, x = 0.5, y = 0.5 } = req.body;
      if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || x > 1 || y < 0 || y > 1)
        return res.status(400).json({ error: 'Coordenadas inválidas (x, y deben ser 0–1)' });

      const images = Array.isArray(listing.images) ? listing.images : [];
      if (images.length === 0)
        return res.status(400).json({ error: 'La propiedad no tiene imágenes' });
      const idx = Math.min(Math.max(0, Math.floor(imageIndex)), images.length - 1);
      const imgEntry = images[idx];
      const imgUrl = typeof imgEntry === 'string' ? imgEntry : imgEntry?.url;
      if (!imgUrl) return res.status(400).json({ error: 'Imagen no encontrada' });

      const fullUrl = imgUrl.startsWith('http') ? imgUrl : `${process.env.BASE_URL || 'https://hogaresrd.com'}${imgUrl}`;
      const imgRes = await fetch(fullUrl);
      if (!imgRes.ok) throw new Error('No se pudo descargar la imagen fuente');
      sourceBuf = Buffer.from(await imgRes.arrayBuffer());
      feedFocal = { imageIndex: idx, x, y };
    }

    // ── Generate 1080x1920 portrait output ──
    // For focal-point crops we extract a 9:16 region centered on the focal point.
    // For custom uploads we cover-fit (resize+center-crop) to guarantee 9:16 even
    // if the user accidentally uploaded a non-portrait image.
    const targetW = 1080, targetH = 1920;
    let feedBuf;

    if (useCustomUpload) {
      feedBuf = await sharp(sourceBuf)
        .rotate()
        .resize(targetW, targetH, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
    } else {
      const meta = await sharp(sourceBuf).metadata();
      const ratio = targetW / targetH; // 0.5625
      const { x, y } = feedFocal;
      let cropW, cropH;
      if (meta.width / meta.height > ratio) {
        cropH = meta.height;
        cropW = Math.round(cropH * ratio);
      } else {
        cropW = meta.width;
        cropH = Math.round(cropW / ratio);
      }
      const left = Math.max(0, Math.min(Math.round(x * meta.width - cropW / 2), meta.width - cropW));
      const top  = Math.max(0, Math.min(Math.round(y * meta.height - cropH / 2), meta.height - cropH));
      feedBuf = await sharp(sourceBuf)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(targetW, targetH)
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
    }

    // Upload to CDN or save locally
    const feedKey = `feed/${listing.id}_feed.jpg`;
    let feedUrl;
    if (spacesConfigured()) {
      feedUrl = await uploadToSpaces(feedBuf, feedKey, 'image/jpeg');
    }
    if (!feedUrl) {
      const fsp = require('fs').promises;
      const path = require('path');
      const dir = path.join(__dirname, '..', 'public', 'uploads', 'feed');
      await fsp.mkdir(dir, { recursive: true });
      const localPath = path.join(dir, `${listing.id}_feed.jpg`);
      await fsp.writeFile(localPath, feedBuf);
      feedUrl = `/uploads/feed/${listing.id}_feed.jpg`;
    }

    // Cache-bust so re-uploads replace the previous frame in CDNs / clients
    const versioned = `${feedUrl}${feedUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
    listing.feed_image = versioned;
    listing.feed_focal = feedFocal;
    store.saveListing(listing);

    res.json({ feed_image: versioned, feed_focal: listing.feed_focal });
  } catch (e) {
    console.error('[feed-image] Error generating feed crop:', e.message);
    res.status(500).json({ error: 'Error generando imagen del feed: ' + e.message });
  }
});

// GET /api/listings/:id/reviews — property-level reviews
//
// Aggregates tour-feedback ratings (rating + comment) for the
// given listing. Mirrors Airbnb / Zillow's pattern of surfacing
// post-visit feedback as a property review. We don't ship a
// separate review table — every "review" is a tour with feedback,
// so the source of truth stays consistent with what the broker
// already sees in their tour history.
//
// Public endpoint (no auth) so guests can see ratings while
// browsing. Reviewer's full name is reduced to first name only
// to balance social proof with client privacy.
router.get('/:id/reviews', (req, res) => {
  const listing = store.getListingById(req.params.id);
  if (!listing || listing.status !== 'approved') {
    return res.status(404).json({ error: 'Propiedad no encontrada' });
  }
  const tours = store.getToursByListing(req.params.id);
  const withFeedback = tours.filter(t => t.feedback_rating && t.feedback_at);

  // Sort newest first; surface up to 50 entries.
  withFeedback.sort((a, b) => (b.feedback_at || '').localeCompare(a.feedback_at || ''));
  const reviews = withFeedback.slice(0, 50).map(t => ({
    id:           t.id,
    rating:       t.feedback_rating,
    comment:      (t.feedback_comment || '').trim(),
    feedback_at:  t.feedback_at,
    reviewer_name: ((t.client_name || 'Visitante').split(' ')[0] || 'Visitante'),
  }));

  const sum = withFeedback.reduce((s, t) => s + (t.feedback_rating || 0), 0);
  const average = withFeedback.length
    ? Math.round((sum / withFeedback.length) * 10) / 10
    : null;

  res.json({
    reviews,
    average,
    count: withFeedback.length,
  });
});

module.exports = router;
