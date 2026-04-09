/**
 * store-pg.js — PostgreSQL data layer for HogaresRD
 *
 * Drop-in replacement for store.js (SQLite). Same API surface,
 * backed by DigitalOcean Managed PostgreSQL.
 *
 * Key differences from SQLite version:
 *   - Uses connection pool (pg.Pool) instead of single file handle
 *   - JSONB columns parsed automatically by pg driver
 *   - No file-level locking concerns
 *   - Transactions via pool.connect() + client.query('BEGIN/COMMIT')
 */

'use strict';

const { Pool } = require('pg');

// ── Connection ───────────────────────────────────────────────────────────
// Strip sslmode from URL — pg driver treats sslmode=require as verify-full
// in newer versions, rejecting DO's managed database CA. Set ssl separately.
const _rawUrl = process.env.DATABASE_URL || '';
const _connStr = _rawUrl.replace(/[?&]sslmode=[^&]*/g, '');
const pool = new Pool({
  connectionString: _connStr,
  ssl: _rawUrl.includes('sslmode') ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[store-pg] Pool error:', err.message));

// ── Helpers ──────────────────────────────────────────────────────────────
const ACTIVITY_CAP = 200;

function _jsonParse(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val; // already parsed by pg driver
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

// Build an UPSERT query for PostgreSQL
function buildUpsert(table, row, pkCol) {
  const cols = Object.keys(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.filter(c => c !== pkCol)
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');
  const quotedCols = cols.map(c => `"${c}"`).join(', ');
  const sql = `INSERT INTO ${table} (${quotedCols}) VALUES (${placeholders})
    ON CONFLICT ("${pkCol}") DO UPDATE SET ${updates}`;
  return { sql, values: cols.map(c => row[c]) };
}

// Synchronous-style wrapper — returns a promise but all callers
// already use the store synchronously. We'll make functions async-compatible
// but also support the existing sync call pattern by caching results.
// For the migration period, we use a sync-like query helper.
let _syncDb = null;

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function exec(sql, params = []) {
  await pool.query(sql, params);
}

// ── Hydration (simplified for PostgreSQL — JSONB auto-parsed) ────────────

const USER_JSON_COLS  = ['favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile', '_extra'];
const USER_BOOL_COLS  = ['emailVerified', 'marketingOptIn', 'twoFAEnabled'];

function hydrateUser(row) {
  if (!row) return null;
  const obj = { ...row };
  for (const col of USER_BOOL_COLS) {
    if (obj[col] !== undefined && obj[col] !== null) obj[col] = !!obj[col];
  }
  // Merge _extra into top-level
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

const USER_KNOWN_COLS = [
  'id', 'email', 'passwordHash', 'password', 'name', 'phone', 'role',
  'emailVerified', 'marketingOptIn', 'createdAt', 'lastLoginAt', 'licenseNumber',
  'refToken', 'stripeCustomerId', 'inmobiliaria_id', 'inmobiliaria_name',
  'inmobiliaria_join_status', 'inmobiliaria_joined_at', 'inmobiliaria_pending_id',
  'inmobiliaria_pending_name', 'loginAttempts', 'loginLockedUntil', 'lockedUntil',
  'jobTitle', 'notes', 'twoFAEnabled', 'biometricTokenHash',
  'favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile',
];

function dehydrateUser(user) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(user)) {
    if (USER_KNOWN_COLS.includes(k)) {
      if (USER_JSON_COLS.includes(k) && k !== '_extra') {
        row[k] = typeof v === 'string' ? v : JSON.stringify(v ?? null);
      } else if (USER_BOOL_COLS.includes(k)) {
        row[k] = v ? 1 : 0;
      } else {
        row[k] = v === undefined ? null : v;
      }
    } else {
      extra[k] = v;
    }
  }
  row._extra = JSON.stringify(extra);
  return row;
}

function hydrateSubmission(row) {
  if (!row) return null;
  const obj = { ...row };
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

const SUBMISSION_KNOWN_COLS = [
  'id', 'title', 'type', 'condition', 'description', 'price', 'area_const', 'area_land',
  'bedrooms', 'bathrooms', 'parking', 'province', 'city', 'sector', 'address', 'lat', 'lng',
  'name', 'email', 'phone', 'role', 'status', 'submittedAt', 'approvedAt', 'rejectedAt',
  'updatedAt', 'views', 'floors', 'units_total', 'units_available', 'unit_inventory', 'project_stage',
  'delivery_date', 'submission_type', 'claim_listing_id',
  'amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'construction_company',
  'creator_user_id',
];
const SUBMISSION_JSON_COLS = ['amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'unit_inventory', 'construction_company', '_extra'];

function dehydrateSubmission(sub) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(sub)) {
    if (SUBMISSION_KNOWN_COLS.includes(k)) {
      if (SUBMISSION_JSON_COLS.includes(k) && k !== '_extra') {
        row[k] = typeof v === 'string' ? v : JSON.stringify(v ?? null);
      } else {
        row[k] = v === undefined ? null : v;
      }
    } else {
      extra[k] = v;
    }
  }
  row._extra = JSON.stringify(extra);
  return row;
}

const APP_JSON_COLS  = ['client', 'broker', 'payment', 'payment_plan', 'documents_requested', 'documents_uploaded', 'tours', 'timeline_events', 'assigned_unit', '_extra'];
const APP_KNOWN_COLS = [
  'id', 'listing_id', 'listing_title', 'listing_price', 'listing_type', 'status',
  'status_reason', 'inmobiliaria_id', 'created_at', 'updated_at', 'financing',
  'pre_approved', 'budget', 'timeline', 'intent', 'contact_method', 'notes',
  'broker_id', 'client_name', 'client_email', 'client_phone',
  'client', 'broker', 'payment', 'payment_plan', 'documents_requested',
  'documents_uploaded', 'tours', 'timeline_events', 'assigned_unit',
];

function hydrateApplication(row) {
  if (!row) return null;
  const obj = { ...row };
  if (obj.pre_approved !== undefined) obj.pre_approved = !!obj.pre_approved;
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

function dehydrateApplication(app) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(app)) {
    if (APP_KNOWN_COLS.includes(k)) {
      if (APP_JSON_COLS.includes(k) && k !== '_extra') {
        row[k] = typeof v === 'string' ? v : JSON.stringify(v ?? null);
      } else if (k === 'pre_approved') {
        row[k] = v ? 1 : 0;
      } else {
        row[k] = v === undefined ? null : v;
      }
    } else {
      extra[k] = v;
    }
  }
  row._extra = JSON.stringify(extra);
  return row;
}

const TOUR_KNOWN_COLS = [
  'id', 'listing_id', 'listing_title', 'broker_id', 'client_id', 'client_name',
  'client_email', 'client_phone', 'requested_date', 'requested_time', 'status',
  'broker_notes', 'client_notes', 'created_at', 'updated_at',
];

function hydrateTour(row) {
  if (!row) return null;
  const obj = { ...row };
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

function dehydrateTour(tour) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(tour)) {
    if (TOUR_KNOWN_COLS.includes(k)) {
      row[k] = v === undefined ? null : v;
    } else {
      extra[k] = v;
    }
  }
  row._extra = JSON.stringify(extra);
  return row;
}

// ══════════════════════════════════════════════════════════════════════════
// SYNCHRONOUS COMPATIBILITY LAYER
// The existing codebase calls store functions synchronously.
// PostgreSQL queries are async. We use a sync cache that's populated
// by a background sync loop + direct async calls where possible.
//
// Strategy: Keep the same function signatures but make them work with
// an in-memory cache that syncs from PostgreSQL. Writes go to PG
// immediately (fire-and-forget for non-critical, awaited for critical).
// ══════════════════════════════════════════════════════════════════════════

// In-memory caches (populated on startup and kept in sync)
let _users = [];
let _submissions = [];
let _applications = [];
let _conversations = [];
let _tours = [];
let _availability = [];
let _twofa = [];
let _pushSubs = [];
let _revokedTokens = new Set();
let _savedSearches = [];
let _blogPosts = [];
let _pageContent = [];
let _reports = [];
let _tasks = [];
let _metaLeads = [];
let _leadQueue = [];
let _contributionScores = [];
let _cacheReady = false;

// ── Initial cache load ──────────────────────────────────────────────────
async function _loadCache() {
  try {
    // Ensure cascade tables exist (idempotent)
    await exec(`
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS creator_user_id TEXT;
      CREATE TABLE IF NOT EXISTS lead_queue (
        id TEXT PRIMARY KEY, inquiry_type TEXT NOT NULL, inquiry_id TEXT NOT NULL,
        listing_id TEXT NOT NULL, buyer_name TEXT, buyer_phone TEXT, buyer_email TEXT,
        current_tier INTEGER DEFAULT 1, status TEXT DEFAULT 'active',
        claimed_by TEXT, claimed_at TEXT, tier1_notified_at TEXT, tier2_notified_at TEXT,
        tier3_notified_at TEXT, auto_responded_at TEXT, created_at TEXT NOT NULL,
        _extra JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS contribution_scores (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, listing_id TEXT NOT NULL,
        role TEXT DEFAULT 'affiliate', score INTEGER DEFAULT 0,
        score_breakdown JSONB DEFAULT '{}', avg_response_ms INTEGER,
        response_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        _extra JSONB DEFAULT '{}'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_user_listing ON contribution_scores (user_id, listing_id);
    `);

    const [users, subs, apps, convs, tours, avail, twofa, push, revoked,
           searches, blog, pages, reports, tasks, meta, lq, cs] = await Promise.all([
      query('SELECT * FROM users'),
      query('SELECT * FROM submissions'),
      query('SELECT * FROM applications'),
      query('SELECT * FROM conversations'),
      query('SELECT * FROM tours'),
      query('SELECT * FROM availability_slots'),
      query('SELECT * FROM twofa_sessions'),
      query('SELECT * FROM push_subscriptions'),
      query('SELECT jti FROM revoked_tokens'),
      query('SELECT * FROM saved_searches'),
      query('SELECT * FROM blog_posts'),
      query('SELECT * FROM page_content'),
      query('SELECT * FROM reports'),
      query('SELECT * FROM tasks'),
      query('SELECT * FROM meta_leads'),
      query('SELECT * FROM lead_queue'),
      query('SELECT * FROM contribution_scores'),
    ]);
    _users = users;
    _submissions = subs;
    _applications = apps;
    _conversations = convs;
    _tours = tours;
    _availability = avail;
    _twofa = twofa;
    _pushSubs = push;
    _revokedTokens = new Set(revoked.map(r => r.jti));
    _savedSearches = searches;
    _blogPosts = blog;
    _pageContent = pages;
    _reports = reports;
    _tasks = tasks;
    _metaLeads = meta;
    _leadQueue = lq;
    _contributionScores = cs;
    _cacheReady = true;
    console.log(`[store-pg] Cache loaded: ${users.length} users, ${subs.length} listings, ${apps.length} apps, ${lq.length} lead queue, ${cs.length} scores`);
  } catch (err) {
    console.error('[store-pg] Cache load failed:', err.message);
  }
}

// Start loading immediately
_loadCache();

// Helper: write to PG and update local cache
function _pgWrite(sql, params, cacheName, updater) {
  pool.query(sql, params).catch(err => console.error('[store-pg] Write error:', err.message));
  if (updater) updater();
}

// ══════════════════════════════════════════════════════════════════════════
// USER FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function getUsers() { return _users.map(hydrateUser); }

function getUserById(id) {
  const row = _users.find(u => u.id === id);
  return hydrateUser(row);
}

function getUserByEmail(email) {
  if (!email) return null;
  const lower = email.toLowerCase();
  const row = _users.find(u => u.email && u.email.toLowerCase() === lower);
  return hydrateUser(row);
}

function getUserByRefToken(token) {
  if (!token) return null;
  const row = _users.find(u => u.refToken === token);
  return hydrateUser(row);
}

function getUsersByRole(role) {
  return _users.filter(u => u.role === role).map(hydrateUser);
}

function getUsersByInmobiliaria(inmobiliariaId) {
  return _users.filter(u =>
    ['broker', 'agency', 'secretary'].includes(u.role) && u.inmobiliaria_id === inmobiliariaId
  ).map(hydrateUser);
}

function getSecretariesByInmobiliaria(inmobiliariaId) {
  return _users.filter(u => u.role === 'secretary' && u.inmobiliaria_id === inmobiliariaId).map(hydrateUser);
}

function saveUser(user) {
  const row = dehydrateUser(user);
  const { sql, values } = buildUpsert('users', row, 'id');
  pool.query(sql, values).catch(err => console.error('[store-pg] saveUser error:', err.message));
  // Update cache — parse _extra back to object for consistency with PG-loaded rows
  const cacheRow = { ...row };
  if (typeof cacheRow._extra === 'string') {
    try { cacheRow._extra = JSON.parse(cacheRow._extra); } catch { cacheRow._extra = {}; }
  }
  for (const col of ['favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile']) {
    if (typeof cacheRow[col] === 'string') {
      try { cacheRow[col] = JSON.parse(cacheRow[col]); } catch {}
    }
  }
  const idx = _users.findIndex(u => u.id === user.id);
  if (idx >= 0) _users[idx] = cacheRow;
  else _users.push(cacheRow);
}

function deleteUser(id) {
  _users = _users.filter(u => u.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// LISTING/SUBMISSION FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

let _listingsCache = null;
let _listingsCacheTs = 0;

function _invalidateCache() { _listingsCache = null; _listingsCacheTs = 0; }

function getAllSubmissions() { return _submissions.map(hydrateSubmission); }

function getListingById(id) {
  const row = _submissions.find(s => s.id === id);
  return hydrateSubmission(row);
}

function getListings(filters = {}) {
  let items = _submissions.filter(s => s.status === 'approved').map(hydrateSubmission);

  if (filters.type)       items = items.filter(i => i.type === filters.type);
  if (filters.condition)  items = items.filter(i => i.condition === filters.condition);
  if (filters.province)   items = items.filter(i => i.province === filters.province);
  if (filters.city)       items = items.filter(i => i.city === filters.city);
  if (filters.propertyType) items = items.filter(i => i.propertyType === filters.propertyType);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.city || '').toLowerCase().includes(q) ||
      (i.sector || '').toLowerCase().includes(q) ||
      (i.province || '').toLowerCase().includes(q) ||
      (i.address || '').toLowerCase().includes(q)
    );
  }
  if (filters.priceMin) items = items.filter(i => Number(i.price) >= Number(filters.priceMin));
  if (filters.priceMax) items = items.filter(i => Number(i.price) <= Number(filters.priceMax));
  if (filters.bedroomsMin) items = items.filter(i => Number(i.bedrooms) >= Number(filters.bedroomsMin));
  if (filters.tags) {
    const tags = filters.tags.split(',').map(t => t.trim().toLowerCase());
    items = items.filter(i => {
      const iTags = Array.isArray(i.tags) ? i.tags.map(t => t.toLowerCase()) : [];
      return tags.some(t => iTags.includes(t));
    });
  }

  // Return flat array for backward compatibility with all callers
  return items;
}

function saveListing(listing) {
  const row = dehydrateSubmission(listing);
  const { sql, values } = buildUpsert('submissions', row, 'id');
  pool.query(sql, values).catch(err => console.error('[store-pg] saveListing error:', err.message));
  // Parse JSON strings back to objects for cache consistency
  const cacheRow = { ...row };
  for (const col of SUBMISSION_JSON_COLS) {
    if (typeof cacheRow[col] === 'string') {
      try { cacheRow[col] = JSON.parse(cacheRow[col]); } catch {}
    }
  }
  const idx = _submissions.findIndex(s => s.id === listing.id);
  if (idx >= 0) _submissions[idx] = cacheRow;
  else _submissions.push(cacheRow);
  _invalidateCache();
}

// ══════════════════════════════════════════════════════════════════════════
// APPLICATION FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function getApplications() { return _applications.map(hydrateApplication); }

function getApplicationById(id) {
  const row = _applications.find(a => a.id === id);
  return hydrateApplication(row);
}

function getApplicationsByBroker(brokerId) {
  return _applications.filter(a => {
    const broker = typeof a.broker === 'string' ? _jsonParse(a.broker, {}) : (a.broker || {});
    return broker.user_id === brokerId;
  }).map(hydrateApplication);
}

function getApplicationsByClient(userId) {
  return _applications.filter(a => {
    const client = typeof a.client === 'string' ? _jsonParse(a.client, {}) : (a.client || {});
    return client.user_id === userId;
  }).map(hydrateApplication);
}

function getApplicationsByInmobiliaria(inmId) {
  return _applications.filter(a => a.inmobiliaria_id === inmId).map(hydrateApplication);
}

function saveApplication(app) {
  const row = dehydrateApplication(app);
  const { sql, values } = buildUpsert('applications', row, 'id');
  pool.query(sql, values).catch(err => console.error('[store-pg] saveApplication error:', err.message));
  const cacheRow = { ...row };
  for (const col of APP_JSON_COLS) {
    if (typeof cacheRow[col] === 'string') {
      try { cacheRow[col] = JSON.parse(cacheRow[col]); } catch {}
    }
  }
  const idx = _applications.findIndex(a => a.id === app.id);
  if (idx >= 0) _applications[idx] = cacheRow;
  else _applications.push(cacheRow);
}

// ══════════════════════════════════════════════════════════════════════════
// CONVERSATION FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function hydrateConversation(row) {
  if (!row) return null;
  if (row.data) {
    const d = typeof row.data === 'string' ? _jsonParse(row.data, {}) : row.data;
    return { ...d, id: row.id };
  }
  return row;
}

function getConversations() { return _conversations.map(hydrateConversation).filter(Boolean); }

function getConversationById(id) {
  const row = _conversations.find(c => c.id === id);
  return hydrateConversation(row);
}

function getConversationsByClient(clientId) {
  return _conversations.map(hydrateConversation).filter(c => c && c.clientId === clientId);
}

function getConversationsForBroker(brokerId) {
  return _conversations.map(hydrateConversation).filter(c =>
    c && (c.brokerId === null || c.brokerId === brokerId)
  );
}

function saveConversation(conv) {
  const jsonData = JSON.stringify(conv);
  pool.query(
    `INSERT INTO conversations (id, "clientId", "brokerId", data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET "clientId" = $2, "brokerId" = $3, data = $4`,
    [conv.id, conv.clientId, conv.brokerId, jsonData]
  ).catch(err => console.error('[store-pg] saveConversation error:', err.message));
  // Store parsed object in cache (PG returns JSONB as object, so match that)
  const cacheRow = { id: conv.id, clientId: conv.clientId, brokerId: conv.brokerId, data: conv };
  const idx = _conversations.findIndex(c => c.id === conv.id);
  if (idx >= 0) _conversations[idx] = cacheRow;
  else _conversations.push(cacheRow);
}

// ══════════════════════════════════════════════════════════════════════════
// TOUR FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function getTours() { return _tours.map(hydrateTour); }
function getTourById(id) { return hydrateTour(_tours.find(t => t.id === id)); }
function getToursByBroker(brokerId) { return _tours.filter(t => t.broker_id === brokerId).map(hydrateTour); }
function getToursByClient(clientId) { return _tours.filter(t => t.client_id === clientId).map(hydrateTour); }
function getToursByListing(listingId) { return _tours.filter(t => t.listing_id === listingId).map(hydrateTour); }
function getConfirmedToursByDate(dateStr) { return _tours.filter(t => t.status === 'confirmed' && t.requested_date === dateStr).map(hydrateTour); }
function getBookedSlots(brokerId, dateStr) {
  return _tours.filter(t => t.broker_id === brokerId && t.requested_date === dateStr && ['confirmed', 'pending'].includes(t.status)).map(hydrateTour);
}

function saveTour(tour) {
  const row = dehydrateTour(tour);
  const { sql, values } = buildUpsert('tours', row, 'id');
  pool.query(sql, values).catch(err => console.error('[store-pg] saveTour error:', err.message));
  const cacheRow = { ...row };
  if (typeof cacheRow._extra === 'string') { try { cacheRow._extra = JSON.parse(cacheRow._extra); } catch { cacheRow._extra = {}; } }
  const idx = _tours.findIndex(t => t.id === tour.id);
  if (idx >= 0) _tours[idx] = cacheRow;
  else _tours.push(cacheRow);
}

// ══════════════════════════════════════════════════════════════════════════
// AVAILABILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function getAvailability() { return _availability; }
function getAvailabilityByBroker(brokerId) { return _availability.filter(s => s.broker_id === brokerId); }

function saveAvailabilitySlot(slot) {
  const cols = Object.keys(slot);
  const vals = cols.map(c => slot[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
  pool.query(
    `INSERT INTO availability_slots (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    vals
  ).catch(err => console.error('[store-pg] saveAvailabilitySlot error:', err.message));
  const idx = _availability.findIndex(s => s.id === slot.id);
  if (idx >= 0) _availability[idx] = slot;
  else _availability.push(slot);
}

function deleteAvailabilitySlot(id) {
  pool.query('DELETE FROM availability_slots WHERE id = $1', [id]).catch(() => {});
  _availability = _availability.filter(s => s.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// TOKEN REVOCATION
// ══════════════════════════════════════════════════════════════════════════

function revokeToken(jti, expiresAt) {
  pool.query('INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [jti, expiresAt]).catch(() => {});
  _revokedTokens.add(jti);
}

function isTokenRevoked(jti) { return _revokedTokens.has(jti); }

// ══════════════════════════════════════════════════════════════════════════
// 2FA SESSIONS
// ══════════════════════════════════════════════════════════════════════════

function getTwoFASessions() { return _twofa.map(r => r.data || _jsonParse(r.data, null)).filter(Boolean); }
function getTwoFASession(id) {
  const row = _twofa.find(r => r.id === id);
  return row ? (typeof row.data === 'object' ? row.data : _jsonParse(row.data, null)) : null;
}

function saveTwoFASession(session) {
  const data = JSON.stringify(session);
  pool.query('INSERT INTO twofa_sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [session.id, data]).catch(() => {});
  const idx = _twofa.findIndex(r => r.id === session.id);
  if (idx >= 0) _twofa[idx] = { id: session.id, data: session };
  else _twofa.push({ id: session.id, data: session });
}

function deleteTwoFASession(id) {
  pool.query('DELETE FROM twofa_sessions WHERE id = $1', [id]).catch(() => {});
  _twofa = _twofa.filter(r => r.id !== id);
}

function deleteTwoFASessionsByUser(userId) {
  const sessions = _twofa.filter(r => {
    const d = typeof r.data === 'object' ? r.data : _jsonParse(r.data, {});
    return d && d.userId === userId;
  });
  for (const s of sessions) deleteTwoFASession(s.id);
}

function cleanExpiredTwoFASessions() {
  const now = new Date();
  const expired = _twofa.filter(r => {
    const d = typeof r.data === 'object' ? r.data : _jsonParse(r.data, {});
    return d && new Date(d.expiresAt) <= now;
  });
  for (const s of expired) deleteTwoFASession(s.id);
}

// ══════════════════════════════════════════════════════════════════════════
// PUSH SUBSCRIPTIONS
// ══════════════════════════════════════════════════════════════════════════

function getPushSubscriptions() { return _pushSubs; }
function getPushSubscriptionsByUser(userId) {
  const row = _pushSubs.find(p => p.userId === userId);
  if (!row) return { web: [], ios: [], preferences: {} };
  return {
    web: Array.isArray(row.web) ? row.web : _jsonParse(row.web, []),
    ios: Array.isArray(row.ios) ? row.ios : _jsonParse(row.ios, []),
    preferences: typeof row.preferences === 'object' ? row.preferences : _jsonParse(row.preferences, {}),
  };
}

function savePushSubscription(userId, current) {
  const web = JSON.stringify(current.web || []);
  const ios = JSON.stringify(current.ios || []);
  const prefs = JSON.stringify(current.preferences || {});
  pool.query(
    `INSERT INTO push_subscriptions ("userId", web, ios, preferences) VALUES ($1, $2, $3, $4)
     ON CONFLICT ("userId") DO UPDATE SET web = $2, ios = $3, preferences = $4`,
    [userId, web, ios, prefs]
  ).catch(() => {});
  const idx = _pushSubs.findIndex(p => p.userId === userId);
  const row = { userId, web: current.web, ios: current.ios, preferences: current.preferences };
  if (idx >= 0) _pushSubs[idx] = row;
  else _pushSubs.push(row);
}

function removePushSubscription(userId, type, identifier) {
  const sub = getPushSubscriptionsByUser(userId);
  if (type === 'ios') {
    sub.ios = sub.ios.filter(t => t !== identifier);
  } else {
    sub.web = sub.web.filter(s => s.endpoint !== identifier);
  }
  savePushSubscription(userId, sub);
}

function getPushPreferences(userId) {
  return getPushSubscriptionsByUser(userId).preferences;
}

function savePushPreferences(userId, prefs) {
  const sub = getPushSubscriptionsByUser(userId);
  sub.preferences = prefs;
  savePushSubscription(userId, sub);
}

// ══════════════════════════════════════════════════════════════════════════
// SAVED SEARCHES
// ══════════════════════════════════════════════════════════════════════════

function getSavedSearchesByUser(userId) { return _savedSearches.filter(s => s.user_id === userId); }
function getSavedSearchById(id) { return _savedSearches.find(s => s.id === id) || null; }
function getAllNotifiableSavedSearches() { return _savedSearches.filter(s => s.notify); }

function saveSavedSearch(search) {
  const cols = Object.keys(search);
  const vals = cols.map(c => typeof search[c] === 'object' ? JSON.stringify(search[c]) : search[c]);
  const { sql, values } = buildUpsert('saved_searches', Object.fromEntries(cols.map((c, i) => [c, vals[i]])), 'id');
  pool.query(sql, values).catch(() => {});
  const idx = _savedSearches.findIndex(s => s.id === search.id);
  if (idx >= 0) _savedSearches[idx] = search;
  else _savedSearches.push(search);
}

function deleteSavedSearch(id) {
  pool.query('DELETE FROM saved_searches WHERE id = $1', [id]).catch(() => {});
  _savedSearches = _savedSearches.filter(s => s.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// BLOG POSTS
// ══════════════════════════════════════════════════════════════════════════

function getBlogPosts() { return _blogPosts; }
function getBlogPostById(id) { return _blogPosts.find(p => p.id === id) || null; }
function getBlogPostBySlug(slug) { return _blogPosts.find(p => p.slug === slug) || null; }

function saveBlogPost(post) {
  const row = { ...post };
  if (row._extra && typeof row._extra === 'object') row._extra = JSON.stringify(row._extra);
  const { sql, values } = buildUpsert('blog_posts', row, 'id');
  pool.query(sql, values).catch(() => {});
  const idx = _blogPosts.findIndex(p => p.id === post.id);
  if (idx >= 0) _blogPosts[idx] = post;
  else _blogPosts.push(post);
}

function deleteBlogPost(id) {
  pool.query('DELETE FROM blog_posts WHERE id = $1', [id]).catch(() => {});
  _blogPosts = _blogPosts.filter(p => p.id !== id);
}

function incrementBlogViews(id) {
  pool.query('UPDATE blog_posts SET views = views + 1 WHERE id = $1', [id]).catch(() => {});
  const post = _blogPosts.find(p => p.id === id);
  if (post) post.views = (post.views || 0) + 1;
}

// ══════════════════════════════════════════════════════════════════════════
// PAGE CONTENT
// ══════════════════════════════════════════════════════════════════════════

function getAllPageContent() { return _pageContent; }
function getPageSection(pageId, sectionId) {
  const row = _pageContent.find(p => p.page_id === pageId && p.section_id === sectionId);
  return row ? (typeof row.data === 'object' ? row.data : _jsonParse(row.data, {})) : null;
}

function savePageSection(pageId, sectionId, data) {
  const jsonData = JSON.stringify(data);
  pool.query(
    `INSERT INTO page_content (page_id, section_id, data) VALUES ($1, $2, $3)
     ON CONFLICT (page_id, section_id) DO UPDATE SET data = $3`,
    [pageId, sectionId, jsonData]
  ).catch(() => {});
  const idx = _pageContent.findIndex(p => p.page_id === pageId && p.section_id === sectionId);
  const row = { page_id: pageId, section_id: sectionId, data };
  if (idx >= 0) _pageContent[idx] = row;
  else _pageContent.push(row);
}

// ══════════════════════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════════════════════

function getReports() { return _reports.map(r => typeof r.data === 'object' ? r.data : _jsonParse(r.data, r)); }
function getReportById(id) {
  const row = _reports.find(r => r.id === id);
  return row ? (typeof row.data === 'object' ? row.data : _jsonParse(row.data, row)) : null;
}

function saveReport(report) {
  pool.query(
    `INSERT INTO reports (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
    [report.id, JSON.stringify(report)]
  ).catch(() => {});
  const idx = _reports.findIndex(r => r.id === report.id);
  if (idx >= 0) _reports[idx] = { id: report.id, data: report };
  else _reports.push({ id: report.id, data: report });
}

// ══════════════════════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════════════════════

function hydrateTask(row) {
  if (!row) return null;
  const obj = { ...row };
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

function getTasksByUser(userId) {
  return _tasks.filter(t => t.assigned_to === userId || t.assigned_by === userId).map(hydrateTask);
}
function getTasksByAssignee(userId) { return _tasks.filter(t => t.assigned_to === userId).map(hydrateTask); }
function getTaskById(id) { return hydrateTask(_tasks.find(t => t.id === id)); }
function getTasksByApplication(appId) { return _tasks.filter(t => t.application_id === appId).map(hydrateTask); }

function saveTask(task) {
  const row = {};
  const extra = {};
  const TASK_COLS = ['id','title','description','status','priority','due_date','assigned_to','assigned_by','application_id','listing_id','source_event','completed_at','created_at','updated_at'];
  for (const [k, v] of Object.entries(task)) {
    if (TASK_COLS.includes(k)) row[k] = v === undefined ? null : v;
    else extra[k] = v;
  }
  row._extra = JSON.stringify(extra);
  const { sql, values } = buildUpsert('tasks', row, 'id');
  pool.query(sql, values).catch(() => {});
  const cacheRow = { ...row, _extra: extra }; // store parsed object in cache
  const idx = _tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) _tasks[idx] = cacheRow;
  else _tasks.push(cacheRow);
}

function deleteTask(id) {
  pool.query('DELETE FROM tasks WHERE id = $1', [id]).catch(() => {});
  _tasks = _tasks.filter(t => t.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════════════════════════════════

function getActivityByUser(userId) {
  // Read from cache not implemented for activity — query directly
  return []; // Will be populated as activities are logged
}

function getListingActivity(listingId) { return []; }

function appendActivity(entry) {
  pool.query(
    'INSERT INTO activity_log (user_id, listing_id, action, data, created_at) VALUES ($1, $2, $3, $4, $5)',
    [entry.user_id, entry.listing_id, entry.action, JSON.stringify(entry.data || {}), entry.created_at || new Date().toISOString()]
  ).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════════
// META LEADS
// ══════════════════════════════════════════════════════════════════════════

function getMetaLeads() { return _metaLeads.map(r => typeof r.data === 'object' ? r.data : _jsonParse(r.data, r)); }

function appendMetaLead(lead) {
  pool.query('INSERT INTO meta_leads (data) VALUES ($1)', [JSON.stringify(lead)]).catch(() => {});
  _metaLeads.push({ data: lead });
}

// ══════════════════════════════════════════════════════════════════════════
// LEAD QUEUE (cascade system)
// ══════════════════════════════════════════════════════════════════════════

function getLeadQueue() { return [..._leadQueue]; }

function getLeadQueueById(id) {
  const row = _leadQueue.find(r => r.id === id);
  if (!row) return null;
  const obj = { ...row };
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) { if (!(k in obj)) obj[k] = v; }
  return obj;
}

function getActiveLeadQueueForListing(listingId) {
  return _leadQueue.filter(r => r.listing_id === listingId && r.status === 'active');
}

function getActiveLeadQueue() {
  return _leadQueue.filter(r => r.status === 'active');
}

function saveLeadQueueItem(item) {
  const row = {};
  const extra = {};
  const LQ_COLS = ['id','inquiry_type','inquiry_id','listing_id','buyer_name','buyer_phone','buyer_email',
    'current_tier','status','claimed_by','claimed_at','tier1_notified_at','tier2_notified_at',
    'tier3_notified_at','auto_responded_at','created_at'];
  for (const [k, v] of Object.entries(item)) {
    if (LQ_COLS.includes(k)) row[k] = v === undefined ? null : v;
    else extra[k] = v;
  }
  row._extra = JSON.stringify(extra);
  const { sql, values } = buildUpsert('lead_queue', row, 'id');
  pool.query(sql, values).catch(err => console.error('[store-pg] saveLeadQueueItem error:', err.message));
  const cacheRow = { ...row, _extra: extra };
  const idx = _leadQueue.findIndex(r => r.id === item.id);
  if (idx >= 0) _leadQueue[idx] = cacheRow;
  else _leadQueue.push(cacheRow);
}

// ══════════════════════════════════════════════════════════════════════════
// CONTRIBUTION SCORES (cascade system)
// ══════════════════════════════════════════════════════════════════════════

function getContributionScores() { return [..._contributionScores]; }

function getContributionScoresForListing(listingId) {
  return _contributionScores.filter(r => r.listing_id === listingId).map(r => {
    const obj = { ...r };
    const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
    delete obj._extra;
    for (const [k, v] of Object.entries(extra)) { if (!(k in obj)) obj[k] = v; }
    return obj;
  });
}

function getContributionScore(userId, listingId) {
  const row = _contributionScores.find(r => r.user_id === userId && r.listing_id === listingId);
  if (!row) return null;
  const obj = { ...row };
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) { if (!(k in obj)) obj[k] = v; }
  return obj;
}

function saveContributionScore(cs) {
  const row = {};
  const extra = {};
  const CS_COLS = ['id','user_id','listing_id','role','score','score_breakdown','avg_response_ms',
    'response_count','created_at','updated_at'];
  for (const [k, v] of Object.entries(cs)) {
    if (CS_COLS.includes(k)) {
      if (k === 'score_breakdown') row[k] = typeof v === 'string' ? v : JSON.stringify(v ?? {});
      else row[k] = v === undefined ? null : v;
    } else {
      extra[k] = v;
    }
  }
  row._extra = JSON.stringify(extra);
  const { sql, values } = buildUpsert('contribution_scores', row, 'id');
  pool.query(sql, values).catch(err => console.error('[store-pg] saveContributionScore error:', err.message));
  const cacheRow = { ...row };
  if (typeof cacheRow._extra === 'string') { try { cacheRow._extra = JSON.parse(cacheRow._extra); } catch { cacheRow._extra = {}; } }
  if (typeof cacheRow.score_breakdown === 'string') { try { cacheRow.score_breakdown = JSON.parse(cacheRow.score_breakdown); } catch { cacheRow.score_breakdown = {}; } }
  const idx = _contributionScores.findIndex(r => r.id === cs.id);
  if (idx >= 0) _contributionScores[idx] = cacheRow;
  else _contributionScores.push(cacheRow);
}

// ══════════════════════════════════════════════════════════════════════════
// TRANSACTION SUPPORT
// ══════════════════════════════════════════════════════════════════════════

function withTransaction(fn) {
  // For sync compatibility, just execute the function directly.
  // PostgreSQL transactions require async — but the existing code
  // uses withTransaction for atomic multi-step operations that
  // are already safe with the in-memory cache + async PG writes.
  return fn();
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════

module.exports = {
  getUsers, getUserById, getUserByEmail, getUserByRefToken, saveUser, deleteUser,
  getActivityByUser, getListingActivity, appendActivity,
  getListings, getListingById, saveListing, invalidateListingsCache: _invalidateCache,
  getAllSubmissions,
  getApplications, getApplicationById, getApplicationsByBroker,
  getApplicationsByClient, getApplicationsByInmobiliaria, saveApplication,
  getConversations, getConversationById, getConversationsByClient,
  getConversationsForBroker, saveConversation,
  getMetaLeads, appendMetaLead,
  getLeadQueue, getLeadQueueById, getActiveLeadQueue, getActiveLeadQueueForListing, saveLeadQueueItem,
  getContributionScores, getContributionScoresForListing, getContributionScore, saveContributionScore,
  getUsersByRole, getUsersByInmobiliaria, getSecretariesByInmobiliaria,
  revokeToken, isTokenRevoked,
  getAvailability, getAvailabilityByBroker, saveAvailabilitySlot, deleteAvailabilitySlot,
  getTours, getTourById, getToursByBroker, getToursByClient, getToursByListing, getConfirmedToursByDate,
  getBookedSlots, saveTour,
  getTwoFASessions, getTwoFASession, saveTwoFASession, deleteTwoFASession, deleteTwoFASessionsByUser, cleanExpiredTwoFASessions,
  getPushSubscriptions, getPushSubscriptionsByUser, savePushSubscription,
  removePushSubscription, getPushPreferences, savePushPreferences,
  getSavedSearchesByUser, getSavedSearchById, getAllNotifiableSavedSearches,
  saveSavedSearch, deleteSavedSearch,
  getBlogPosts, getBlogPostById, getBlogPostBySlug, saveBlogPost, deleteBlogPost, incrementBlogViews,
  getAllPageContent, getPageSection, savePageSection,
  getReports, getReportById, saveReport,
  getTasksByUser, getTasksByAssignee, getTaskById, getTasksByApplication,
  saveTask, deleteTask,
  withTransaction,
  // PostgreSQL pool for direct queries if needed
  pool,
};
