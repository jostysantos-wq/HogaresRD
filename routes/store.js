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
const path = require('path');
const fs   = require('fs');
const appEvents = require('./app-events');
const { encrypt: _enc, decrypt: _dec } = require('../utils/encryption');

// ── Connection ───────────────────────────────────────────────────────────
// Strip sslmode from URL — pg driver treats sslmode=require as verify-full
// in newer versions, rejecting DO's managed database CA. Set ssl separately.
const _rawUrl = process.env.DATABASE_URL || '';
const _connStr = _rawUrl.replace(/[?&]sslmode=[^&]*/g, '');

// SSL configuration: use CA cert if available for proper verification
const _sslConfig = (() => {
  if (!_rawUrl.includes('sslmode')) return false;
  // If a CA certificate is provided, use it for proper verification
  const caPath = process.env.DB_CA_CERT || path.join(__dirname, '..', 'ca-certificate.crt');
  if (fs.existsSync(caPath)) {
    console.log('[store-pg] Using CA certificate for SSL verification');
    return { ca: fs.readFileSync(caPath).toString(), rejectUnauthorized: true };
  }
  // Fallback: SSL without certificate verification (log warning)
  console.warn('[store-pg] WARNING: SSL enabled but no CA certificate found — using rejectUnauthorized:false');
  return { rejectUnauthorized: false };
})();

const pool = new Pool({
  connectionString: _connStr,
  ssl: _sslConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[store-pg] Pool error:', err.message));

// Track DB write failures for monitoring — logged to error tracker
let _dbWriteFailures = 0;
function _dbWriteError(label, err) {
  _dbWriteFailures++;
  console.error(`[store-pg] ${label} error:`, err.message);
  // Append to error log if error-tracker is available
  try {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, '..', 'data', 'errors.log');
    const entry = JSON.stringify({
      level: 'error', type: 'db_write_failure', timestamp: new Date().toISOString(),
      message: `${label}: ${err.message}`, statusCode: null,
    });
    fs.appendFileSync(logFile, entry + '\n');
  } catch {}
}
function getDbWriteFailureCount() { return _dbWriteFailures; }

// Pool checkout with a 10s saturation timeout. The pool itself has a
// 5s connection timeout (TCP/handshake), but a saturated pool can
// still leave a request waiting indefinitely for an idle client.
// Race the checkout so atomic helpers can surface a 503 instead of
// hanging the request thread.
async function _connectWithTimeout(timeoutMs = 10000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DB pool saturated')), timeoutMs);
  });
  try {
    return await Promise.race([pool.connect(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Errors ──────────────────────────────────────────────────────────────
// Thrown by claimXxxAtomic helpers when an optimistic-concurrency check
// fails (the row's updated_at moved between the read and the write).
// Routes catch this and surface a 409 to the client so they can refresh.
class ConflictError extends Error {
  constructor(msg) {
    super(msg || 'conflict');
    this.name = 'ConflictError';
  }
}

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
const USER_BOOL_COLS  = ['emailVerified', 'marketingOptIn', 'twoFAEnabled', 'doNotSell'];

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
  'jobTitle', 'notes', 'twoFAEnabled', 'biometricTokenHash', 'doNotSell',
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
  'id', 'title', 'type', 'propertyType', 'condition', 'description', 'price', 'area_const', 'area_land',
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
  // Top-level shallow spread isn't enough — the snapshot-stripping below
  // mutates nested commission.history entries in place. Without a deep
  // clone, the first read permanently scrubs the cached row's history,
  // so subsequent reads return commission snapshots with no history.
  // structuredClone (Node 17+) is the cheapest faithful deep clone here.
  const obj = typeof structuredClone === 'function'
    ? structuredClone(row)
    : JSON.parse(JSON.stringify(row));
  if (obj.pre_approved !== undefined) obj.pre_approved = !!obj.pre_approved;
  const extra = typeof obj._extra === 'string' ? _jsonParse(obj._extra, {}) : (obj._extra || {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  // Strip 'history' from commission snapshots to break any circular refs.
  // Safe to mutate now that obj is a deep clone of the cached row.
  if (Array.isArray(obj.commission?.history)) {
    for (const entry of obj.commission.history) {
      if (entry.snapshotBefore) delete entry.snapshotBefore.history;
      if (entry.snapshotAfter)  delete entry.snapshotAfter.history;
    }
  }
  // Defensive defaults — survive DB migration gaps where JSON columns are null
  if (!obj.documents_requested) obj.documents_requested = [];
  if (!obj.documents_uploaded)  obj.documents_uploaded  = [];
  if (!obj.tours)               obj.tours               = [];
  if (!obj.timeline_events)     obj.timeline_events     = [];
  if (!obj.broker)  obj.broker  = { user_id: null, name: '', email: '', phone: '' };
  if (!obj.client)  obj.client  = { user_id: null, name: '', email: '', phone: '' };
  if (!obj.payment) obj.payment = { amount: null, currency: 'DOP', verification_status: 'none' };
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
let _notifications = [];
let _metaLeads = [];
let _leadQueue = [];
let _contributionScores = [];
let _deletionRequests = [];
let _privacyLog = [];
let _inmobPosts = [];
let _inmobReviews = [];
// D2: in-memory queue for status escalations awaiting owner approval.
// Low-volume, ephemeral, no DB table — survives until process restart.
// Each row: { id, application_id, requested_status, reason, requested_by,
// requested_by_name, requested_at, inmobiliaria_id }.
let _pendingApprovals = [];
let _cacheReady = false;

// ── Initial cache load ──────────────────────────────────────────────────
async function _loadCache() {
  try {
    // Ensure cascade tables exist (idempotent)
    await exec(`
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS creator_user_id TEXT;
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "propertyType" TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "doNotSell" INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS lead_queue (
        id TEXT PRIMARY KEY, inquiry_type TEXT NOT NULL, inquiry_id TEXT NOT NULL,
        listing_id TEXT NOT NULL, buyer_name TEXT, buyer_phone TEXT, buyer_email TEXT,
        current_tier INTEGER DEFAULT 1, status TEXT DEFAULT 'active',
        claimed_by TEXT, claimed_at TEXT, tier1_notified_at TEXT, tier2_notified_at TEXT,
        tier3_notified_at TEXT, auto_responded_at TEXT, created_at TEXT NOT NULL,
        org_scope_id TEXT,
        _extra JSONB DEFAULT '{}'
      );
      ALTER TABLE lead_queue ADD COLUMN IF NOT EXISTS org_scope_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_lead_queue_org_scope ON lead_queue (org_scope_id);
      -- Data migration: backfill org_scope_id from the legacy _extra.inmobiliaria_scope
      -- key. Idempotent: only fills empty rows. The old field handled both
      -- inmobiliaria and constructora, so the rename is purely a clarity fix.
      UPDATE lead_queue
         SET org_scope_id = (_extra->>'inmobiliaria_scope')
       WHERE org_scope_id IS NULL
         AND _extra ? 'inmobiliaria_scope';
      CREATE TABLE IF NOT EXISTS contribution_scores (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, listing_id TEXT NOT NULL,
        role TEXT DEFAULT 'affiliate', score INTEGER DEFAULT 0,
        score_breakdown JSONB DEFAULT '{}', avg_response_ms INTEGER,
        response_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        _extra JSONB DEFAULT '{}'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_user_listing ON contribution_scores (user_id, listing_id);
      CREATE TABLE IF NOT EXISTS privacy_log (
        id TEXT PRIMARY KEY, user_id TEXT, user_email TEXT,
        request_type TEXT NOT NULL, status TEXT DEFAULT 'completed',
        source TEXT DEFAULT 'manual', details JSONB DEFAULT '{}',
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS inmobiliaria_posts (
        id TEXT PRIMARY KEY, inmobiliaria_id TEXT NOT NULL,
        post_type TEXT DEFAULT 'update', title TEXT, content TEXT NOT NULL,
        image TEXT, published INTEGER DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inmobiliaria_reviews (
        id TEXT PRIMARY KEY, inmobiliaria_id TEXT NOT NULL,
        reviewer_name TEXT NOT NULL, reviewer_email TEXT,
        rating INTEGER NOT NULL, comment TEXT,
        status TEXT DEFAULT 'pending', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_email TEXT NOT NULL,
        user_name TEXT, user_role TEXT, reason TEXT,
        status TEXT DEFAULT 'pending', processed_at TEXT, processed_by TEXT,
        data_summary JSONB DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, listing_id TEXT,
        action TEXT NOT NULL, data JSONB DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log (user_id, created_at);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        type TEXT NOT NULL, title TEXT, body TEXT, url TEXT,
        data JSONB DEFAULT '{}', read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created
        ON notifications (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON notifications (user_id) WHERE read_at IS NULL;
      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id       TEXT NOT NULL,
        sender_role     TEXT NOT NULL,
        sender_name     TEXT NOT NULL,
        text            TEXT NOT NULL,
        timestamp       TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id);
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_count INTEGER DEFAULT 0;
    `);

    const [users, subs, apps, convs, tours, avail, twofa, push, revoked,
           searches, blog, pages, reports, tasks, meta, lq, cs, delReqs, privLog, iPost, iReview, notifs] = await Promise.all([
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
      query('SELECT * FROM deletion_requests'),
      query('SELECT * FROM privacy_log'),
      query('SELECT * FROM inmobiliaria_posts'),
      query('SELECT * FROM inmobiliaria_reviews'),
      query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5000'),
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
    _deletionRequests = delReqs;
    _privacyLog = privLog;
    _inmobPosts = iPost;
    _inmobReviews = iReview;
    _notifications = notifs;
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

// Stripe webhooks fire on every renewal at scale; the linear scan
// fallback in routes/stripe.js findUser() becomes a hotspot. Keep this
// O(N) for now (the row count is small) but expose a named helper so
// future indexing can land in one place.
function getUserByStripeCustomerId(customerId) {
  if (!customerId) return null;
  const row = _users.find(u => u.stripeCustomerId === customerId);
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
  pool.query(sql, values).catch(err => _dbWriteError('saveUser', err));
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
  pool.query('DELETE FROM users WHERE id = $1', [id]).catch(err => _dbWriteError('deleteUser', err));
  _users = _users.filter(u => u.id !== id);
}

/**
 * Delete a user and ALL associated data from both DB and cache.
 * Returns a summary of what was deleted.
 */
async function deleteUserCascade(userId) {
  const summary = { conversations: 0, tours: 0, tasks: 0, savedSearches: 0, pushSubs: 0, availability: 0 };

  // 1. Conversations (camelCase columns in DB)
  const userConvs = _conversations.filter(c => {
    const h = hydrateConversation(c);
    return h && (h.clientId === userId || h.brokerId === userId);
  });
  for (const c of userConvs) {
    pool.query('DELETE FROM conversations WHERE id = $1', [c.id]).catch(err => _dbWriteError('deleteConv', err));
  }
  _conversations = _conversations.filter(c => !userConvs.some(uc => uc.id === c.id));
  summary.conversations = userConvs.length;

  // 2. Tours (snake_case columns)
  const userTours = _tours.filter(t => t.client_id === userId || t.broker_id === userId);
  for (const t of userTours) {
    pool.query('DELETE FROM tours WHERE id = $1', [t.id]).catch(err => _dbWriteError('deleteTour', err));
  }
  _tours = _tours.filter(t => !userTours.some(ut => ut.id === t.id));
  summary.tours = userTours.length;

  // 3. Tasks
  const userTasks = getTasksByUser(userId);
  for (const t of userTasks) deleteTask(t.id);
  summary.tasks = userTasks.length;

  // 4. Saved searches
  const userSearches = getSavedSearchesByUser(userId);
  for (const s of userSearches) deleteSavedSearch(s.id);
  summary.savedSearches = userSearches.length;

  // 5. Push subscriptions (camelCase column)
  pool.query('DELETE FROM push_subscriptions WHERE "userId" = $1', [userId]).catch(err => _dbWriteError('deletePushSubs', err));
  _pushSubs = _pushSubs.filter(s => s.userId !== userId);
  summary.pushSubs = 1;

  // 6. Availability slots
  pool.query('DELETE FROM availability_slots WHERE broker_id = $1', [userId]).catch(err => _dbWriteError('deleteAvail', err));
  _availability = _availability.filter(s => s.broker_id !== userId);
  summary.availability = 1;

  // 7. Anonymize applications where the user is the client.
  // Applications are business records that the broker needs to keep, so we
  // replace PII with placeholders instead of deleting the whole record.
  const clientApps = _applications.filter(a => {
    const client = typeof a.client === 'string' ? _jsonParse(a.client, {}) : (a.client || {});
    return client.user_id === userId;
  });
  const ANON = { user_id: null, name: 'Usuario eliminado', email: '', phone: '' };
  for (const raw of clientApps) {
    const app = hydrateApplication(raw);
    if (!app) continue;
    app.client = { ...ANON };
    app.client_name  = ANON.name;
    app.client_email = '';
    app.client_phone = '';
    // Scrub PII from timeline events (actor names referencing the client)
    if (Array.isArray(app.timeline_events)) {
      for (const ev of app.timeline_events) {
        if (ev.actor === userId) {
          ev.actor_name = ANON.name;
          ev.actor = null;
        }
      }
    }
    saveApplication(app);
  }
  summary.applications = clientApps.length;

  // 8. 2FA sessions
  _twofa = _twofa.filter(s => {
    const data = typeof s.data === 'string' ? _jsonParse(s.data, {}) : (s.data || {});
    return data.userId !== userId;
  });

  // 9. User record
  deleteUser(userId);

  return summary;
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
  let items = _submissions.filter(s => s.status === 'approved' && s.submission_type !== 'agency_claim').map(hydrateSubmission);

  if (filters.type) {
    if (filters.type === 'proyecto') {
      // "proyecto" is a virtual type — matches listings by project conditions
      const projectConditions = ['En planos', 'Nueva construcción', 'Nueva construccion', 'proyecto_nuevo', 'planos', 'construccion', 'En construcción', 'En construccion'];
      items = items.filter(i => projectConditions.includes(i.condition));
    } else {
      items = items.filter(i => i.type === filters.type);
    }
  }
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

// `client` is an optional 2nd arg — when invoked inside `withTransaction`,
// the route passes the pg client so the write joins the surrounding
// BEGIN/COMMIT. The helper returns the underlying query promise in
// that case so the caller can `await` it before COMMIT runs. Without
// `client` (the default for ~25 other call sites) it falls back to the
// legacy fire-and-forget pool path so this stays a non-breaking change.
// TODO(transactional-rewrite): migrate the remaining saveX call sites
// (subscriptions, conversations, payments, etc.) onto awaited tx writes.
function saveListing(listing, client) {
  const row = dehydrateSubmission(listing);
  const { sql, values } = buildUpsert('submissions', row, 'id');
  // Parse JSON strings back to objects for cache consistency
  const cacheRow = { ...row };
  for (const col of SUBMISSION_JSON_COLS) {
    if (typeof cacheRow[col] === 'string') {
      try { cacheRow[col] = JSON.parse(cacheRow[col]); } catch {}
    }
  }
  function commitCache() {
    const idx = _submissions.findIndex(s => s.id === listing.id);
    if (idx >= 0) _submissions[idx] = cacheRow;
    else _submissions.push(cacheRow);
    _invalidateCache();
  }
  if (client) {
    // P1 #15: defer cache mutation until the inner write resolves so a
    // ROLLBACK in the surrounding withTransaction doesn't leave a
    // phantom row in the in-memory submissions cache. See the longer
    // comment above saveApplication for the trade-off.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveListing', err));
  commitCache();
  return null;
}

function deleteListing(id) {
  pool.query('DELETE FROM submissions WHERE id = $1', [id]).catch(err => console.error('[store-pg] deleteListing error:', err.message));
  _submissions = _submissions.filter(s => s.id !== id);
  _invalidateCache();

  // Flag any non-terminal applications that point to the deleted listing.
  // We don't change their status (the snapshot fields like listing_title /
  // listing_price stay frozen, which is the desired audit behavior); we
  // just stamp listing_deleted_at and append a timeline event so brokers
  // can see why the property is gone. addEvent's logic is inlined here
  // (rather than imported from applications.js) to avoid a circular
  // require — applications.js already requires store.js.
  const TERMINAL_STATUSES = new Set(['rechazado', 'completado']);
  for (const a of _applications) {
    if (a.listing_id !== id) continue;
    if (TERMINAL_STATUSES.has(a.status)) continue;
    const nowIso = new Date().toISOString();
    a.listing_deleted_at = nowIso;
    if (!Array.isArray(a.timeline_events)) a.timeline_events = [];
    a.timeline_events.push({
      id: require('crypto').randomUUID(),
      type: 'listing_deleted',
      description: 'La propiedad asociada fue eliminada',
      actor: 'system',
      actor_name: 'Sistema',
      data: {},
      created_at: nowIso,
    });
    a.updated_at = nowIso;
    // Persist the flag — fire-and-forget through the regular write path.
    try { saveApplication(a); } catch (err) { _dbWriteError('deleteListing/saveApplication', err); }
  }
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

// Encrypt financial amounts before saving to DB
function _encryptAppFinancials(app) {
  if (app.commission) {
    for (const k of ['sale_amount', 'agent_amount', 'inmobiliaria_amount', 'agent_net']) {
      if (app.commission[k] != null && typeof app.commission[k] === 'number') {
        app.commission[k] = _enc(String(app.commission[k]));
      }
    }
  }
  if (app.payment_plan) {
    if (app.payment_plan.total_amount != null && typeof app.payment_plan.total_amount === 'number') {
      app.payment_plan.total_amount = _enc(String(app.payment_plan.total_amount));
    }
    if (Array.isArray(app.payment_plan.installments)) {
      for (const inst of app.payment_plan.installments) {
        if (inst.amount != null && typeof inst.amount === 'number') {
          inst.amount = _enc(String(inst.amount));
        }
      }
    }
  }
}

// `client` is an optional 2nd arg — when invoked inside `withTransaction`,
// the route passes the pg client so the write joins the surrounding
// BEGIN/COMMIT and the function returns the query promise for the caller
// to await. Without `client` it falls back to fire-and-forget (current
// behavior for the other ~25 saveApplication call sites).
// TODO(transactional-rewrite): migrate the remaining saveApplication
// call sites onto awaited tx writes.
// TODO(transactional-commission): callers in routes/applications.js that
// mutate `commission` and `payment` together (e.g. status_change paths
// that void/approve commission alongside payment_plan updates) MUST
// pass a `client` from `withTransaction(...)` so both writes commit
// atomically. Today most of those sites still call saveApplication(app)
// fire-and-forget, leaving a small window where commission state can
// land in the DB while the paired payment update is still in-flight.
//
// P1 #15 (cache vs DB commit): when `client` is non-null we DO NOT
// mutate the in-memory cache until the inner client.query() resolves.
// That means a transaction that throws after BEGIN but before our
// query no longer leaves a phantom cache row. There is still a small
// window between the inner query resolving and the surrounding COMMIT
// — if that COMMIT fails (network / constraint), the cache momentarily
// holds an "in-tx but never committed" row until the process is
// restarted. We accept that trade-off because: (a) the inner query
// succeeding means PG validated our row, so it's far less likely to
// fail at COMMIT than to fail at row-write; (b) suppressing all cache
// updates until COMMIT would require threading the COMMIT step
// through every save helper and is too invasive to land in this fix.
//
// P1 #29 (ciphertext in cache): the encrypted row goes to the DB ONLY.
// The in-memory cache holds the plaintext clone so subsequent reads
// (getApplicationsByBroker, /commissions/summary) see real numbers.
function saveApplication(app, client) {
  // Two clones: one we encrypt for the DB, one we keep plaintext for
  // the cache. Both are deep clones so callers' mutations don't bleed.
  const dbClone = JSON.parse(JSON.stringify(app));
  _encryptAppFinancials(dbClone);
  const dbRow = dehydrateApplication(dbClone);
  const { sql, values } = buildUpsert('applications', dbRow, 'id');

  // Cache row is built from the plaintext clone — same JSON-rehydration
  // pass as before so callers can navigate nested fields without parse.
  const cacheClone = JSON.parse(JSON.stringify(app));
  const cacheRow = dehydrateApplication(cacheClone);
  for (const col of APP_JSON_COLS) {
    if (typeof cacheRow[col] === 'string') {
      try { cacheRow[col] = JSON.parse(cacheRow[col]); } catch {}
    }
  }

  function commitCache() {
    const idx = _applications.findIndex(a => a.id === app.id);
    if (idx >= 0) _applications[idx] = cacheRow;
    else _applications.push(cacheRow);
    // Notify any open SSE streams subscribed to this application.
    // Fire-and-forget — the bus is in-process and never blocks.
    appEvents.publish(app.id);
  }

  if (client) {
    // Defer cache mutation until the inner write resolves so a
    // mutator that throws after BEGIN never leaves phantom rows.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }

  // Non-tx path: fire-and-forget (unchanged), cache update is immediate
  // because there is no surrounding tx to roll us back.
  pool.query(sql, values).catch(err => _dbWriteError('saveApplication', err));
  commitCache();
  return null;
}

/**
 * Optimistic-concurrency wrapper for application mutations.
 *
 * Use this to wrap any handler that flips application status / pushes
 * documents / payment fields, when two agents could be acting on the
 * same row simultaneously (broker + secretary, dual tabs, etc.). The
 * caller passes the `updated_at` they observed when they read the app;
 * if the row moved in between, we throw `ConflictError` so the route
 * can surface a 409 instead of silently overwriting the other write.
 *
 * Production path: SELECT ... FOR UPDATE inside a real transaction so
 * the row is locked while the mutator runs and saveApplication writes
 * to the same client.
 *
 * Test/dev path (no DATABASE_URL): mutator runs against the in-memory
 * cache without DB locks — still does the updated_at check so test
 * coverage of the conflict path is real.
 *
 * @param {string}   id                 application id
 * @param {string}   expectedUpdatedAt  updated_at observed before the claim
 * @param {function} mutator            async (app, client) => void
 * @returns {Promise<object>}           the mutated app (post-save)
 */
async function claimApplicationAtomic(id, expectedUpdatedAt, mutator) {
  // ── Test / dev short-circuit ────────────────────────────────────────
  if (!_rawUrl) {
    const app = getApplicationById(id);
    if (!app) throw new ConflictError('application_not_found');
    if ((app.updated_at || null) !== (expectedUpdatedAt || null)) {
      throw new ConflictError('updated_at mismatch');
    }
    await mutator(app, null);
    app.updated_at = new Date().toISOString();
    saveApplication(app);
    return app;
  }

  // ── Real Postgres path ──────────────────────────────────────────────
  const client = await _connectWithTimeout();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM applications WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new ConflictError('application_not_found');
    }
    const app = hydrateApplication(rows[0]);
    if ((app.updated_at || null) !== (expectedUpdatedAt || null)) {
      await client.query('ROLLBACK');
      throw new ConflictError('updated_at mismatch');
    }
    await mutator(app, client);
    app.updated_at = new Date().toISOString();
    await saveApplication(app, client);
    await client.query('COMMIT');
    return app;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    if (client) client.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CONVERSATION FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════

function hydrateConversation(row) {
  if (!row) return null;
  if (row.data) {
    const d = typeof row.data === 'string' ? _jsonParse(row.data, {}) : row.data;
    // Strip messages from hydrated result — they now live in the messages table.
    // Safety net for old data blobs that still contain an embedded messages array.
    const { messages: _m, ...rest } = d;
    return { ...rest, id: row.id, message_count: row.message_count || 0 };
  }
  return row;
}

/// Strip messages array before serialising to the data column.
function _stripMessagesFromData(conv) {
  if (!conv) return {};
  const { messages, message_count, ...rest } = conv;
  return rest;
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

function getConversationsByInmobiliaria(inmobiliariaId) {
  return _conversations.map(hydrateConversation).filter(c => c && c.inmobiliariaId === inmobiliariaId);
}

async function claimConversationAtomic(convId, brokerId, brokerName, now, systemMessage) {
  const client = await _connectWithTimeout();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, "clientId", "brokerId", data, message_count FROM conversations WHERE id = $1 AND "brokerId" IS NULL FOR UPDATE',
      [convId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null; // already claimed
    }
    const row = rows[0];
    const conv = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const { messages: _m, ...cleanConv } = conv;
    cleanConv.brokerId = brokerId;
    cleanConv.brokerName = brokerName;
    cleanConv.updatedAt = now;
    const newCount = (row.message_count || 0) + 1;
    const jsonData = JSON.stringify(cleanConv);
    await client.query(
      'UPDATE conversations SET "brokerId" = $2, data = $3, message_count = $4 WHERE id = $1',
      [convId, brokerId, jsonData, newCount]
    );
    // Insert system message into messages table within same transaction
    await client.query(
      `INSERT INTO messages (id, conversation_id, sender_id, sender_role, sender_name, text, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [systemMessage.id, convId, systemMessage.senderId, systemMessage.senderRole,
       systemMessage.senderName, systemMessage.text, systemMessage.timestamp]
    );
    await client.query('COMMIT');
    // Update in-memory cache — message_count lives on the row, NOT inside data
    const cacheRow = { id: convId, clientId: row.clientId, brokerId, message_count: newCount, data: cleanConv };
    const idx = _conversations.findIndex(c => c.id === convId);
    if (idx >= 0) _conversations[idx] = cacheRow;
    else _conversations.push(cacheRow);
    return { ...cleanConv, id: convId, message_count: newCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
}

// `client` is an optional 2nd arg — when invoked inside `withTransaction`,
// the route passes the pg client so the write joins the surrounding
// BEGIN/COMMIT and the function returns the query promise for the caller
// to await. Without `client` it falls back to fire-and-forget (current
// behavior for the other call sites). Mirrors the saveListing /
// saveApplication overload.
function saveConversation(conv, client) {
  const jsonData = JSON.stringify(_stripMessagesFromData(conv));
  // message_count is set on INSERT (new conversations) but NOT overwritten on UPDATE —
  // addMessage() is the sole authority for incrementing the counter.
  const sql = `INSERT INTO conversations (id, "clientId", "brokerId", data, message_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET "clientId" = $2, "brokerId" = $3, data = $4`;
  const params = [conv.id, conv.clientId, conv.brokerId, jsonData, conv.message_count || 0];
  if (client) {
    // P1 #15: defer cache update until inner query resolves so a tx
    // ROLLBACK does not leave a phantom conversation row in the cache.
    return client.query(sql, params).then((result) => {
      _updateConversationCache(conv);
      return result;
    });
  }
  pool.query(sql, params).catch(err => _dbWriteError('saveConversation', err));
  _updateConversationCache(conv);
  return null;
}

/// Awaitable version of saveConversation — use for critical writes
/// where DB confirmation is required before responding to the client.
async function saveConversationAsync(conv) {
  const jsonData = JSON.stringify(_stripMessagesFromData(conv));
  await pool.query(
    `INSERT INTO conversations (id, "clientId", "brokerId", data, message_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET "clientId" = $2, "brokerId" = $3, data = $4`,
    [conv.id, conv.clientId, conv.brokerId, jsonData, conv.message_count || 0]
  );
  _updateConversationCache(conv);
}

function _updateConversationCache(conv) {
  const { messages, ...rest } = conv;
  const cacheRow = { id: conv.id, clientId: conv.clientId, brokerId: conv.brokerId, message_count: conv.message_count || 0, data: rest };
  const idx = _conversations.findIndex(c => c.id === conv.id);
  if (idx >= 0) _conversations[idx] = cacheRow;
  else _conversations.push(cacheRow);
}

/// Atomic transfer request — uses FOR UPDATE to prevent duplicate pending requests.
async function addTransferRequestAtomic(convId, transferReq) {
  const client = await _connectWithTimeout();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, "clientId", "brokerId", data FROM conversations WHERE id = $1 FOR UPDATE',
      [convId]
    );
    if (rows.length === 0) { await client.query('ROLLBACK'); return null; }
    const row = rows[0];
    const conv = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (!Array.isArray(conv.transfer_requests)) conv.transfer_requests = [];
    const hasPending = conv.transfer_requests.some(r => r.status === 'pending');
    if (hasPending) { await client.query('ROLLBACK'); return { duplicate: true }; }
    conv.transfer_requests.push(transferReq);
    conv.updatedAt = transferReq.createdAt;
    const jsonData = JSON.stringify(_stripMessagesFromData(conv));
    await client.query(
      'UPDATE conversations SET data = $2 WHERE id = $1',
      [convId, jsonData]
    );
    await client.query('COMMIT');
    _updateConversationCache(conv);
    return { ...conv, id: convId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MESSAGE FUNCTIONS (separate messages table)
// ══════════════════════════════════════════════════════════════════════════

/// Fire-and-forget insert. Also bumps message_count on conversations.
function addMessage(conversationId, msg) {
  pool.query(
    `INSERT INTO messages (id, conversation_id, sender_id, sender_role, sender_name, text, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [msg.id, conversationId, msg.senderId, msg.senderRole, msg.senderName, msg.text, msg.timestamp]
  ).catch(err => _dbWriteError('addMessage', err));
  pool.query(
    'UPDATE conversations SET message_count = COALESCE(message_count, 0) + 1 WHERE id = $1',
    [conversationId]
  ).catch(err => _dbWriteError('addMessage:count', err));
  // Bump in-memory cache
  const cached = _conversations.find(c => c.id === conversationId);
  if (cached) cached.message_count = (cached.message_count || 0) + 1;
}

/// Awaitable insert — use when the caller must confirm the write succeeded.
async function addMessageAsync(conversationId, msg) {
  await pool.query(
    `INSERT INTO messages (id, conversation_id, sender_id, sender_role, sender_name, text, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [msg.id, conversationId, msg.senderId, msg.senderRole, msg.senderName, msg.text, msg.timestamp]
  );
  await pool.query(
    'UPDATE conversations SET message_count = COALESCE(message_count, 0) + 1 WHERE id = $1',
    [conversationId]
  );
  const cached = _conversations.find(c => c.id === conversationId);
  if (cached) cached.message_count = (cached.message_count || 0) + 1;
}

/// Fetch messages for a conversation with optional pagination.
/// @param {string} conversationId
/// @param {{ since?: string, limit?: number }} opts
///   since: ISO-8601 timestamp — only messages after this time
///   limit: max rows (default 50)
/// @returns {Promise<Array>} messages ordered by timestamp ASC
function _hydrateMessages(rows) {
  // pg returns TIMESTAMPTZ as JS Date — convert to ISO string to match old JSONB shape
  for (const r of rows) {
    if (r.timestamp instanceof Date) r.timestamp = r.timestamp.toISOString();
  }
  return rows;
}

async function getMessages(conversationId, { since, limit = 50 } = {}) {
  if (since) {
    const { rows } = await pool.query(
      `SELECT id, sender_id AS "senderId", sender_role AS "senderRole",
              sender_name AS "senderName", text, timestamp
       FROM messages WHERE conversation_id = $1 AND timestamp > $2
       ORDER BY timestamp ASC`,
      [conversationId, since]
    );
    return _hydrateMessages(rows);
  }
  // Initial load: last N messages — subquery to get newest N, then re-sort ASC
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT id, sender_id AS "senderId", sender_role AS "senderRole",
              sender_name AS "senderName", text, timestamp
       FROM messages WHERE conversation_id = $1
       ORDER BY timestamp DESC LIMIT $2
     ) sub ORDER BY timestamp ASC`,
    [conversationId, limit]
  );
  return _hydrateMessages(rows);
}

/// Total message count for a conversation (reads denormalized column, falls back to COUNT).
async function getMessageCount(conversationId) {
  const cached = _conversations.find(c => c.id === conversationId);
  if (cached && typeof cached.message_count === 'number') return cached.message_count;
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id = $1',
    [conversationId]
  );
  return rows[0]?.count || 0;
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

function saveTour(tour, client = null) {
  const row = dehydrateTour(tour);
  const { sql, values } = buildUpsert('tours', row, 'id');
  const cacheRow = { ...row };
  if (typeof cacheRow._extra === 'string') { try { cacheRow._extra = JSON.parse(cacheRow._extra); } catch { cacheRow._extra = {}; } }
  function commitCache() {
    const idx = _tours.findIndex(t => t.id === tour.id);
    if (idx >= 0) _tours[idx] = cacheRow;
    else _tours.push(cacheRow);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves so ROLLBACK
    // does not leave phantom rows.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveTour', err));
  commitCache();
  return null;
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
  ).catch(err => _dbWriteError('saveAvailabilitySlot', err));
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

function savePushSubscription(userId, current, client = null) {
  const web = JSON.stringify(current.web || []);
  const ios = JSON.stringify(current.ios || []);
  const prefs = JSON.stringify(current.preferences || {});
  const sql = `INSERT INTO push_subscriptions ("userId", web, ios, preferences) VALUES ($1, $2, $3, $4)
     ON CONFLICT ("userId") DO UPDATE SET web = $2, ios = $3, preferences = $4`;
  const values = [userId, web, ios, prefs];
  const row = { userId, web: current.web, ios: current.ios, preferences: current.preferences };
  function commitCache() {
    const idx = _pushSubs.findIndex(p => p.userId === userId);
    if (idx >= 0) _pushSubs[idx] = row;
    else _pushSubs.push(row);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(() => {});
  commitCache();
  return null;
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

function saveSavedSearch(search, client = null) {
  const cols = Object.keys(search);
  const vals = cols.map(c => typeof search[c] === 'object' ? JSON.stringify(search[c]) : search[c]);
  const { sql, values } = buildUpsert('saved_searches', Object.fromEntries(cols.map((c, i) => [c, vals[i]])), 'id');
  function commitCache() {
    const idx = _savedSearches.findIndex(s => s.id === search.id);
    if (idx >= 0) _savedSearches[idx] = search;
    else _savedSearches.push(search);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(() => {});
  commitCache();
  return null;
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

function saveBlogPost(post, client = null) {
  // Deep clone so we can dehydrate (_extra → JSON string) into the DB row
  // without mutating the caller's object. Previously the cache stored the
  // input reference after we already stringified its _extra in place, which
  // meant subsequent saves of the same object re-stringified an already-
  // stringified value and leaked DB-row shape into in-memory data.
  const cloned = typeof structuredClone === 'function'
    ? structuredClone(post)
    : JSON.parse(JSON.stringify(post));
  const row = { ...cloned };
  if (row._extra && typeof row._extra === 'object') row._extra = JSON.stringify(row._extra);
  const { sql, values } = buildUpsert('blog_posts', row, 'id');
  // Cache the un-mutated parsed form so getBlogPostById returns a clean
  // object (not the row with a stringified _extra).
  function commitCache() {
    const idx = _blogPosts.findIndex(p => p.id === post.id);
    if (idx >= 0) _blogPosts[idx] = cloned;
    else _blogPosts.push(cloned);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(() => {});
  commitCache();
  return null;
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

function saveReport(report, client = null) {
  const sql = `INSERT INTO reports (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`;
  const values = [report.id, JSON.stringify(report)];
  function commitCache() {
    const idx = _reports.findIndex(r => r.id === report.id);
    if (idx >= 0) _reports[idx] = { id: report.id, data: report };
    else _reports.push({ id: report.id, data: report });
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(() => {});
  commitCache();
  return null;
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

function saveTask(task, client = null) {
  const row = {};
  const extra = {};
  const TASK_COLS = ['id','title','description','status','priority','due_date','assigned_to','assigned_by','application_id','listing_id','source_event','completed_at','created_at','updated_at'];
  for (const [k, v] of Object.entries(task)) {
    if (TASK_COLS.includes(k)) row[k] = v === undefined ? null : v;
    else extra[k] = v;
  }
  row._extra = JSON.stringify(extra);
  const { sql, values } = buildUpsert('tasks', row, 'id');
  const cacheRow = { ...row, _extra: extra }; // store parsed object in cache
  function commitCache() {
    const idx = _tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) _tasks[idx] = cacheRow;
    else _tasks.push(cacheRow);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveTask', err));
  commitCache();
  return null;
}

function deleteTask(id) {
  pool.query('DELETE FROM tasks WHERE id = $1', [id]).catch(err => _dbWriteError('deleteTask', err));
  _tasks = _tasks.filter(t => t.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — in-app notification history that drives the iOS badge
//                 and the future notifications inbox UI.
// ══════════════════════════════════════════════════════════════════════════

function _hydrateNotification(row) {
  if (!row) return null;
  const obj = { ...row };
  if (typeof obj.data === 'string') obj.data = _jsonParse(obj.data, {});
  if (!obj.data) obj.data = {};
  return obj;
}

function getNotificationsByUser(userId, { limit = 50, unreadOnly = false } = {}) {
  let rows = _notifications.filter(n => n.user_id === userId);
  if (unreadOnly) rows = rows.filter(n => !n.read_at);
  rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return rows.slice(0, limit).map(_hydrateNotification);
}

function getUnreadNotificationCount(userId) {
  let count = 0;
  for (const n of _notifications) {
    if (n.user_id === userId && !n.read_at) count++;
  }
  return count;
}

function saveNotification(notif, client = null) {
  const NOTIF_COLS = ['id', 'user_id', 'type', 'title', 'body', 'url', 'data', 'read_at', 'created_at'];
  const row = {};
  for (const col of NOTIF_COLS) {
    if (notif[col] !== undefined) row[col] = notif[col];
  }
  if (row.data && typeof row.data !== 'string') row.data = JSON.stringify(row.data);
  const { sql, values } = buildUpsert('notifications', row, 'id');
  // Cache: parse data back to object
  const cacheRow = { ...row, data: typeof row.data === 'string' ? _jsonParse(row.data, {}) : (row.data || {}) };
  function commitCache() {
    const idx = _notifications.findIndex(n => n.id === notif.id);
    if (idx >= 0) _notifications[idx] = cacheRow;
    else _notifications.unshift(cacheRow); // newest first to match load order
    // Soft cap on cache to avoid unbounded growth — DB still has full history
    if (_notifications.length > 5000) _notifications = _notifications.slice(0, 5000);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveNotification', err));
  commitCache();
  return null;
}

function markNotificationRead(id, userId) {
  const idx = _notifications.findIndex(n => n.id === id && n.user_id === userId);
  if (idx < 0) return false;
  if (_notifications[idx].read_at) return true; // already read
  const readAt = new Date().toISOString();
  _notifications[idx].read_at = readAt;
  pool.query('UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3',
    [readAt, id, userId]).catch(err => _dbWriteError('markNotificationRead', err));
  return true;
}

function markAllNotificationsRead(userId) {
  const readAt = new Date().toISOString();
  let touched = 0;
  for (const n of _notifications) {
    if (n.user_id === userId && !n.read_at) { n.read_at = readAt; touched++; }
  }
  if (touched > 0) {
    pool.query('UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL',
      [readAt, userId]).catch(err => _dbWriteError('markAllNotificationsRead', err));
  }
  return touched;
}

function deleteNotification(id, userId) {
  const idx = _notifications.findIndex(n => n.id === id && n.user_id === userId);
  if (idx < 0) return false;
  _notifications.splice(idx, 1);
  pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2',
    [id, userId]).catch(err => _dbWriteError('deleteNotification', err));
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════════════════════════════════

async function getActivityByUser(userId, opts = {}) {
  const { limit = 10, days = 30, action = null } = opts;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    let sql = 'SELECT user_id, listing_id, action, data, created_at FROM activity_log WHERE user_id = $1 AND created_at >= $2';
    const params = [userId, since];
    if (action) { sql += ' AND action = $3'; params.push(action); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows || [];
  } catch (err) {
    console.error('[store] getActivityByUser error:', err.message);
    return [];
  }
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

function saveLeadQueueItem(item, client = null) {
  const row = {};
  const extra = {};
  const LQ_COLS = ['id','inquiry_type','inquiry_id','listing_id','buyer_name','buyer_phone','buyer_email',
    'current_tier','status','claimed_by','claimed_at','tier1_notified_at','tier2_notified_at',
    'tier3_notified_at','auto_responded_at','created_at','org_scope_id'];
  for (const [k, v] of Object.entries(item)) {
    if (LQ_COLS.includes(k)) row[k] = v === undefined ? null : v;
    else extra[k] = v;
  }
  row._extra = JSON.stringify(extra);
  const { sql, values } = buildUpsert('lead_queue', row, 'id');
  const cacheRow = { ...row, _extra: extra };
  function commitCache() {
    const idx = _leadQueue.findIndex(r => r.id === item.id);
    if (idx >= 0) _leadQueue[idx] = cacheRow;
    else _leadQueue.push(cacheRow);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveLeadQueueItem', err));
  commitCache();
  return null;
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

function saveContributionScore(cs, client = null) {
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
  const cacheRow = { ...row };
  if (typeof cacheRow._extra === 'string') { try { cacheRow._extra = JSON.parse(cacheRow._extra); } catch { cacheRow._extra = {}; } }
  if (typeof cacheRow.score_breakdown === 'string') { try { cacheRow.score_breakdown = JSON.parse(cacheRow.score_breakdown); } catch { cacheRow.score_breakdown = {}; } }
  function commitCache() {
    const idx = _contributionScores.findIndex(r => r.id === cs.id);
    if (idx >= 0) _contributionScores[idx] = cacheRow;
    else _contributionScores.push(cacheRow);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveContributionScore', err));
  commitCache();
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// TRANSACTION SUPPORT
// ══════════════════════════════════════════════════════════════════════════

async function withTransaction(fn) {
  // No DATABASE_URL → no real DB available (test/dev). Fall back to
  // non-transactional execution so callers still work; saveX helpers
  // accept a null client and use the fire-and-forget pool path.
  // TODO(transactional-rewrite): the inventory.js callers still treat
  // withTransaction synchronously — they will need an async refactor
  // before their writes are truly transactional in production.
  if (!_rawUrl) {
    return await fn(null);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // await works for both sync (returns value) and async (returns Promise)
    // callbacks, so existing sync callers stay backwards compatible.
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// INMOBILIARIA POSTS
// ══════════════════════════════════════════════════════════════════════════

function getInmobPosts(inmId) { return _inmobPosts.filter(p => p.inmobiliaria_id === inmId); }
function getInmobPostById(id) { return _inmobPosts.find(p => p.id === id) || null; }
function getPublishedInmobPosts(inmId) { return _inmobPosts.filter(p => p.inmobiliaria_id === inmId && p.published); }

function saveInmobPost(post, client = null) {
  const { sql, values } = buildUpsert('inmobiliaria_posts', post, 'id');
  function commitCache() {
    const idx = _inmobPosts.findIndex(p => p.id === post.id);
    if (idx >= 0) _inmobPosts[idx] = post;
    else _inmobPosts.push(post);
  }
  if (client) {
    // P1 #15: defer cache update until inner query resolves.
    return client.query(sql, values).then((result) => {
      commitCache();
      return result;
    });
  }
  pool.query(sql, values).catch(err => _dbWriteError('saveInmobPost', err));
  commitCache();
  return null;
}

function deleteInmobPost(id) {
  pool.query('DELETE FROM inmobiliaria_posts WHERE id = $1', [id]).catch(err => _dbWriteError('deleteInmobPost', err));
  _inmobPosts = _inmobPosts.filter(p => p.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// INMOBILIARIA REVIEWS
// ══════════════════════════════════════════════════════════════════════════

function getInmobReviews(inmId) { return _inmobReviews.filter(r => r.inmobiliaria_id === inmId); }
function getApprovedInmobReviews(inmId) { return _inmobReviews.filter(r => r.inmobiliaria_id === inmId && r.status === 'approved'); }
function getInmobReviewById(id) { return _inmobReviews.find(r => r.id === id) || null; }

function saveInmobReview(review) {
  const { sql, values } = buildUpsert('inmobiliaria_reviews', review, 'id');
  pool.query(sql, values).catch(err => _dbWriteError('saveInmobReview', err));
  const idx = _inmobReviews.findIndex(r => r.id === review.id);
  if (idx >= 0) _inmobReviews[idx] = review;
  else _inmobReviews.push(review);
}

function deleteInmobReview(id) {
  pool.query('DELETE FROM inmobiliaria_reviews WHERE id = $1', [id]).catch(err => _dbWriteError('deleteInmobReview', err));
  _inmobReviews = _inmobReviews.filter(r => r.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// PENDING APPROVALS (D2 — secretary-recommended status changes)
// In-memory only. Each row: { id, application_id, requested_status, reason,
// requested_by, requested_by_name, requested_at, inmobiliaria_id }.
// ══════════════════════════════════════════════════════════════════════════

function getPendingApprovals(inmobiliariaId) {
  if (!inmobiliariaId) return _pendingApprovals.slice();
  return _pendingApprovals.filter(p => p.inmobiliaria_id === inmobiliariaId);
}

function addPendingApproval(approval) {
  if (!approval || !approval.id) return;
  // Replace existing same-id if any (idempotent)
  const idx = _pendingApprovals.findIndex(p => p.id === approval.id);
  if (idx >= 0) _pendingApprovals[idx] = approval;
  else _pendingApprovals.push(approval);
}

function removePendingApproval(id) {
  _pendingApprovals = _pendingApprovals.filter(p => p.id !== id);
}

function removePendingApprovalsForApp(applicationId) {
  _pendingApprovals = _pendingApprovals.filter(p => p.application_id !== applicationId);
}

// P1 #26: list pending approvals for a specific application — used by
// PUT /:id/status to scope the removal to rows whose requested_status
// matches the just-applied status, instead of nuking every pending row
// on the app.
function getPendingApprovalsForApp(applicationId) {
  return _pendingApprovals.filter(p => p.application_id === applicationId);
}

// ══════════════════════════════════════════════════════════════════════════
// PRIVACY LOG (CCPA compliance — 24-month retention)
// ══════════════════════════════════════════════════════════════════════════

function getPrivacyLog() { return _privacyLog; }

function appendPrivacyLog(entry) {
  const row = { ...entry };
  if (typeof row.details === 'object') row.details = JSON.stringify(row.details);
  const { sql, values } = buildUpsert('privacy_log', row, 'id');
  pool.query(sql, values).catch(err => _dbWriteError('appendPrivacyLog', err));
  const cacheRow = { ...row };
  if (typeof cacheRow.details === 'string') { try { cacheRow.details = JSON.parse(cacheRow.details); } catch {} }
  _privacyLog.push(cacheRow);
}

// ══════════════════════════════════════════════════════════════════════════
// DELETION REQUESTS
// ══════════════════════════════════════════════════════════════════════════

function getDeletionRequests() { return _deletionRequests; }
function getDeletionRequestById(id) { return _deletionRequests.find(r => r.id === id) || null; }

function saveDeletionRequest(req) {
  const row = { ...req };
  if (typeof row.data_summary === 'object') row.data_summary = JSON.stringify(row.data_summary);
  const { sql, values } = buildUpsert('deletion_requests', row, 'id');
  pool.query(sql, values).catch(err => _dbWriteError('saveDeletionRequest', err));
  const cacheRow = { ...row };
  if (typeof cacheRow.data_summary === 'string') { try { cacheRow.data_summary = JSON.parse(cacheRow.data_summary); } catch {} }
  const idx = _deletionRequests.findIndex(r => r.id === req.id);
  if (idx >= 0) _deletionRequests[idx] = cacheRow;
  else _deletionRequests.push(cacheRow);
}

function deleteDeletionRequest(id) {
  pool.query('DELETE FROM deletion_requests WHERE id = $1', [id]).catch(err => _dbWriteError('deleteDeletionRequest', err));
  _deletionRequests = _deletionRequests.filter(r => r.id !== id);
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════

module.exports = {
  getUsers, getUserById, getUserByEmail, getUserByRefToken, getUserByStripeCustomerId, saveUser, deleteUser, deleteUserCascade,
  getActivityByUser, getListingActivity, appendActivity,
  getListings, getListingById, saveListing, deleteListing, invalidateListingsCache: _invalidateCache,
  getAllSubmissions,
  getApplications, getApplicationById, getApplicationsByBroker,
  getApplicationsByClient, getApplicationsByInmobiliaria, saveApplication,
  claimApplicationAtomic, ConflictError,
  getConversations, getConversationById, getConversationsByClient,
  getConversationsForBroker, getConversationsByInmobiliaria, saveConversation, saveConversationAsync,
  claimConversationAtomic, addTransferRequestAtomic,
  addMessage, addMessageAsync, getMessages, getMessageCount,
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
  getNotificationsByUser, getUnreadNotificationCount,
  saveNotification, markNotificationRead, markAllNotificationsRead, deleteNotification,
  withTransaction,
  getInmobPosts, getInmobPostById, getPublishedInmobPosts, saveInmobPost, deleteInmobPost,
  getInmobReviews, getApprovedInmobReviews, getInmobReviewById, saveInmobReview, deleteInmobReview,
  getPendingApprovals, addPendingApproval, removePendingApproval, removePendingApprovalsForApp,
  getPendingApprovalsForApp,
  getPrivacyLog, appendPrivacyLog,
  getDeletionRequests, getDeletionRequestById, saveDeletionRequest, deleteDeletionRequest,
  getDbWriteFailureCount,
  // Internal refs for memory management (used by cleanup cron + health check)
  _twofa, _leadQueue, _revokedTokens, _tasks,
  get _cacheReady() { return _cacheReady; },
  // PostgreSQL pool for direct queries if needed
  pool,
};
