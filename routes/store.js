const Database = require('better-sqlite3');
const path     = require('path');

// ── Database setup ────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'data', 'hogaresrd.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF');
// Performance pragmas for higher concurrency + throughput:
db.pragma('busy_timeout = 5000');      // Wait up to 5s on write lock instead of failing
db.pragma('cache_size = -64000');      // 64 MB page cache (negative = KiB)
db.pragma('temp_store = MEMORY');      // Keep temp tables in RAM
db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped I/O for reads

const ACTIVITY_CAP = 200;

// ── Schema ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                       TEXT PRIMARY KEY,
    email                    TEXT UNIQUE COLLATE NOCASE,
    passwordHash             TEXT,
    password                 TEXT,
    name                     TEXT,
    phone                    TEXT,
    role                     TEXT,
    emailVerified            INTEGER DEFAULT 0,
    marketingOptIn           INTEGER DEFAULT 0,
    createdAt                TEXT,
    lastLoginAt              TEXT,
    licenseNumber            TEXT,
    refToken                 TEXT,
    stripeCustomerId         TEXT,
    inmobiliaria_id          TEXT,
    inmobiliaria_name        TEXT,
    inmobiliaria_join_status TEXT,
    inmobiliaria_joined_at   TEXT,
    inmobiliaria_pending_id  TEXT,
    inmobiliaria_pending_name TEXT,
    loginAttempts            INTEGER DEFAULT 0,
    loginLockedUntil         TEXT,
    lockedUntil              TEXT,
    jobTitle                 TEXT,
    notes                    TEXT,
    twoFAEnabled             INTEGER DEFAULT 0,
    biometricTokenHash       TEXT,
    favorites                TEXT DEFAULT '[]',
    agency                   TEXT,
    join_requests            TEXT DEFAULT '[]',
    secretary_invites        TEXT,
    subscription             TEXT,
    profile                  TEXT,
    _extra                   TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS activity (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT,
    type      TEXT,
    listingId TEXT,
    timestamp TEXT,
    data      TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_activity_userId ON activity(userId);
  CREATE INDEX IF NOT EXISTS idx_activity_type   ON activity(type);

  CREATE TABLE IF NOT EXISTS submissions (
    id                 TEXT PRIMARY KEY,
    title              TEXT,
    type               TEXT,
    condition          TEXT,
    description        TEXT,
    price              TEXT,
    area_const         TEXT,
    area_land          TEXT,
    bedrooms           TEXT,
    bathrooms          TEXT,
    parking            TEXT,
    province           TEXT,
    city               TEXT,
    sector             TEXT,
    address            TEXT,
    lat                TEXT,
    lng                TEXT,
    name               TEXT,
    email              TEXT,
    phone              TEXT,
    role               TEXT,
    status             TEXT DEFAULT 'pending',
    submittedAt        TEXT,
    approvedAt         TEXT,
    rejectedAt         TEXT,
    updatedAt          TEXT,
    views              INTEGER DEFAULT 0,
    floors             TEXT,
    units_total        TEXT,
    units_available    TEXT,
    project_stage      TEXT,
    delivery_date      TEXT,
    submission_type    TEXT,
    claim_listing_id   TEXT,
    amenities          TEXT DEFAULT '[]',
    agencies           TEXT DEFAULT '[]',
    images             TEXT DEFAULT '[]',
    blueprints         TEXT DEFAULT '[]',
    tags               TEXT DEFAULT '[]',
    unit_types         TEXT DEFAULT '[]',
    unit_inventory     TEXT DEFAULT '[]',
    construction_company TEXT,
    _extra             TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
  CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(type);
  CREATE INDEX IF NOT EXISTS idx_submissions_province ON submissions(province);
  CREATE INDEX IF NOT EXISTS idx_submissions_city ON submissions(city);
  CREATE INDEX IF NOT EXISTS idx_submissions_condition ON submissions(condition);

  CREATE TABLE IF NOT EXISTS applications (
    id                  TEXT PRIMARY KEY,
    listing_id          TEXT,
    listing_title       TEXT,
    listing_price       TEXT,
    listing_type        TEXT,
    status              TEXT,
    status_reason       TEXT,
    inmobiliaria_id     TEXT,
    created_at          TEXT,
    updated_at          TEXT,
    financing           TEXT,
    pre_approved        INTEGER DEFAULT 0,
    budget              TEXT,
    timeline            TEXT,
    intent              TEXT,
    contact_method      TEXT,
    notes               TEXT,
    broker_id           TEXT,
    client_name         TEXT,
    client_email        TEXT,
    client_phone        TEXT,
    client              TEXT,
    broker              TEXT,
    payment             TEXT,
    payment_plan        TEXT,
    documents_requested TEXT DEFAULT '[]',
    documents_uploaded  TEXT DEFAULT '[]',
    tours               TEXT DEFAULT '[]',
    timeline_events     TEXT DEFAULT '[]',
    assigned_unit       TEXT,
    _extra              TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_applications_broker_id ON applications(broker_id);
  CREATE INDEX IF NOT EXISTS idx_applications_inmobiliaria ON applications(inmobiliaria_id);

  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti       TEXT PRIMARY KEY,
    exp       INTEGER,
    revokedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id       TEXT PRIMARY KEY,
    clientId TEXT,
    brokerId TEXT,
    data     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_clientId ON conversations(clientId);
  CREATE INDEX IF NOT EXISTS idx_conversations_brokerId ON conversations(brokerId);

  CREATE TABLE IF NOT EXISTS meta_leads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    leadgenId  TEXT UNIQUE,
    data       TEXT
  );

  CREATE TABLE IF NOT EXISTS availability (
    id                TEXT PRIMARY KEY,
    broker_id         TEXT,
    day_of_week       INTEGER,
    start_time        TEXT,
    end_time          TEXT,
    slot_duration_min INTEGER,
    max_concurrent    INTEGER DEFAULT 1,
    active            INTEGER DEFAULT 1,
    type              TEXT,
    specific_date     TEXT,
    created_at        TEXT,
    updated_at        TEXT,
    _extra            TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_availability_broker ON availability(broker_id);

  CREATE TABLE IF NOT EXISTS tours (
    id              TEXT PRIMARY KEY,
    listing_id      TEXT,
    listing_title   TEXT,
    broker_id       TEXT,
    client_id       TEXT,
    client_name     TEXT,
    client_email    TEXT,
    client_phone    TEXT,
    requested_date  TEXT,
    requested_time  TEXT,
    status          TEXT,
    broker_notes    TEXT,
    client_notes    TEXT,
    created_at      TEXT,
    updated_at      TEXT,
    _extra          TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_tours_broker  ON tours(broker_id);
  CREATE INDEX IF NOT EXISTS idx_tours_client  ON tours(client_id);
  CREATE INDEX IF NOT EXISTS idx_tours_listing ON tours(listing_id);

  CREATE TABLE IF NOT EXISTS twofa_sessions (
    id   TEXT PRIMARY KEY,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    userId      TEXT PRIMARY KEY,
    web         TEXT DEFAULT '[]',
    ios         TEXT DEFAULT '[]',
    preferences TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS saved_searches (
    id              TEXT PRIMARY KEY,
    userId          TEXT NOT NULL,
    name            TEXT NOT NULL,
    filters         TEXT DEFAULT '{}',
    notify          INTEGER DEFAULT 1,
    lastMatchIds    TEXT DEFAULT '[]',
    lastNotifiedAt  TEXT,
    matchCount      INTEGER DEFAULT 0,
    createdAt       TEXT,
    updatedAt       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_saved_searches_userId ON saved_searches(userId);

  CREATE TABLE IF NOT EXISTS blog_posts (
    id          TEXT PRIMARY KEY,
    slug        TEXT UNIQUE,
    title       TEXT,
    excerpt     TEXT,
    content     TEXT,
    category    TEXT DEFAULT 'general',
    cover_image TEXT,
    author      TEXT DEFAULT 'Equipo HogaresRD',
    read_time   INTEGER DEFAULT 5,
    featured    INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'draft',
    views       INTEGER DEFAULT 0,
    published_at TEXT,
    created_at  TEXT,
    updated_at  TEXT,
    _extra      TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_blog_status ON blog_posts(status);
  CREATE INDEX IF NOT EXISTS idx_blog_slug   ON blog_posts(slug);

  CREATE TABLE IF NOT EXISTS page_content (
    id      TEXT PRIMARY KEY,
    page    TEXT NOT NULL,
    section TEXT NOT NULL,
    data    TEXT DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_page_content_uniq ON page_content(page, section);

  CREATE TABLE IF NOT EXISTS reports (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    target_id       TEXT,
    target_name     TEXT,
    reporter_id     TEXT,
    reporter_name   TEXT,
    reporter_email  TEXT,
    reason          TEXT NOT NULL,
    details         TEXT,
    attachment      TEXT,
    status          TEXT DEFAULT 'pending',
    admin_notes     TEXT,
    created_at      TEXT,
    updated_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_reports_type   ON reports(type);
`);

// ── FTS5 full-text search index ──────────────────────────────────────────
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
    id UNINDEXED,
    title,
    description,
    city,
    sector,
    province,
    address,
    content='submissions',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );
`);

// Rebuild FTS index on startup (fast for <50k rows)
try {
  db.exec("INSERT INTO listings_fts(listings_fts) VALUES('rebuild')");
} catch(e) {
  console.log('[Store] FTS rebuild skipped:', e.message);
}

// ── In-memory listings cache ────────────────────────────────────────────
let _listingsCache = null;    // Map<id, hydratedListing>
let _listingsCacheTs = 0;     // timestamp of last cache build
const CACHE_TTL = 60 * 1000;  // 1 minute TTL

function _invalidateCache() {
  _listingsCache = null;
  _listingsCacheTs = 0;
}

function _ensureCache() {
  const now = Date.now();
  if (_listingsCache && (now - _listingsCacheTs) < CACHE_TTL) return _listingsCache;
  const rows = db.prepare("SELECT * FROM submissions WHERE status = 'approved'").all();
  _listingsCache = new Map();
  for (const row of rows) {
    const hydrated = hydrateSubmission(row);
    if (hydrated) _listingsCache.set(hydrated.id, hydrated);
  }
  _listingsCacheTs = now;
  return _listingsCache;
}

// ── JSON columns per table ────────────────────────────────────────────────
const USER_JSON_COLS     = ['favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile', '_extra'];
const USER_BOOL_COLS     = ['emailVerified', 'marketingOptIn', 'twoFAEnabled'];
const USER_KNOWN_COLS    = [
  'id', 'email', 'passwordHash', 'password', 'name', 'phone', 'role',
  'emailVerified', 'marketingOptIn', 'createdAt', 'lastLoginAt', 'licenseNumber',
  'refToken', 'stripeCustomerId', 'inmobiliaria_id', 'inmobiliaria_name',
  'inmobiliaria_join_status', 'inmobiliaria_joined_at', 'inmobiliaria_pending_id',
  'inmobiliaria_pending_name', 'loginAttempts', 'loginLockedUntil', 'lockedUntil',
  'jobTitle', 'notes', 'twoFAEnabled', 'biometricTokenHash',
  'favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile',
];

const SUBMISSION_JSON_COLS  = ['amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'unit_inventory', 'construction_company', '_extra'];
const SUBMISSION_KNOWN_COLS = [
  'id', 'title', 'type', 'condition', 'description', 'price', 'area_const', 'area_land',
  'bedrooms', 'bathrooms', 'parking', 'province', 'city', 'sector', 'address', 'lat', 'lng',
  'name', 'email', 'phone', 'role', 'status', 'submittedAt', 'approvedAt', 'rejectedAt',
  'updatedAt', 'views', 'floors', 'units_total', 'units_available', 'project_stage',
  'delivery_date', 'submission_type', 'claim_listing_id',
  'amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'unit_inventory', 'construction_company',
];

const APP_JSON_COLS  = ['client', 'broker', 'payment', 'payment_plan', 'documents_requested', 'documents_uploaded', 'tours', 'timeline_events', 'assigned_unit', '_extra'];
const APP_BOOL_COLS  = ['pre_approved'];
const APP_KNOWN_COLS = [
  'id', 'listing_id', 'listing_title', 'listing_price', 'listing_type', 'status',
  'status_reason', 'inmobiliaria_id', 'created_at', 'updated_at', 'financing',
  'pre_approved', 'budget', 'timeline', 'intent', 'contact_method', 'notes',
  'broker_id', 'client_name', 'client_email', 'client_phone',
  'client', 'broker', 'payment', 'payment_plan', 'documents_requested',
  'documents_uploaded', 'tours', 'timeline_events', 'assigned_unit',
];

const AVAIL_JSON_COLS  = ['_extra'];
const AVAIL_BOOL_COLS  = ['active'];
const AVAIL_KNOWN_COLS = [
  'id', 'broker_id', 'day_of_week', 'start_time', 'end_time', 'slot_duration_min',
  'max_concurrent', 'active', 'type', 'specific_date', 'created_at', 'updated_at',
];

const TOUR_JSON_COLS  = ['_extra'];
const TOUR_KNOWN_COLS = [
  'id', 'listing_id', 'listing_title', 'broker_id', 'client_id', 'client_name',
  'client_email', 'client_phone', 'requested_date', 'requested_time', 'status',
  'broker_notes', 'client_notes', 'created_at', 'updated_at',
];

// ── Hydration helpers ─────────────────────────────────────────────────────

function _jsonParse(val, fallback) {
  if (val == null) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function _jsonStringify(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function hydrateUser(row) {
  if (!row) return null;
  const obj = { ...row };
  // Parse JSON columns
  for (const col of USER_JSON_COLS) {
    if (col === '_extra') continue;
    const fallback = (col === 'favorites' || col === 'join_requests') ? [] : null;
    obj[col] = _jsonParse(obj[col], fallback);
  }
  // Booleans
  for (const col of USER_BOOL_COLS) {
    if (obj[col] !== undefined && obj[col] !== null) obj[col] = !!obj[col];
  }
  // Merge _extra into top-level
  const extra = _jsonParse(obj._extra, {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

function dehydrateUser(user) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(user)) {
    if (USER_KNOWN_COLS.includes(k)) {
      if (USER_JSON_COLS.includes(k) && k !== '_extra') {
        row[k] = _jsonStringify(v);
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
  for (const col of SUBMISSION_JSON_COLS) {
    if (col === '_extra') continue;
    const fallback = ['amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'unit_inventory'].includes(col) ? [] : null;
    obj[col] = _jsonParse(obj[col], fallback);
  }
  const extra = _jsonParse(obj._extra, {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

function dehydrateSubmission(sub) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(sub)) {
    if (SUBMISSION_KNOWN_COLS.includes(k)) {
      if (SUBMISSION_JSON_COLS.includes(k) && k !== '_extra') {
        row[k] = _jsonStringify(v);
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

function hydrateApplication(row) {
  if (!row) return null;
  const obj = { ...row };
  for (const col of APP_JSON_COLS) {
    if (col === '_extra') continue;
    const fallback = ['documents_requested', 'documents_uploaded', 'tours', 'timeline_events'].includes(col) ? [] : null;
    obj[col] = _jsonParse(obj[col], fallback);
  }
  for (const col of APP_BOOL_COLS) {
    if (obj[col] !== undefined && obj[col] !== null) obj[col] = !!obj[col];
  }
  const extra = _jsonParse(obj._extra, {});
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
        row[k] = _jsonStringify(v);
      } else if (APP_BOOL_COLS.includes(k)) {
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

function hydrateAvailability(row) {
  if (!row) return null;
  const obj = { ...row };
  for (const col of AVAIL_BOOL_COLS) {
    if (obj[col] !== undefined && obj[col] !== null) obj[col] = !!obj[col];
  }
  const extra = _jsonParse(obj._extra, {});
  delete obj._extra;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) obj[k] = v;
  }
  return obj;
}

function dehydrateAvailability(slot) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(slot)) {
    if (AVAIL_KNOWN_COLS.includes(k)) {
      if (AVAIL_BOOL_COLS.includes(k)) {
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

function hydrateTour(row) {
  if (!row) return null;
  const obj = { ...row };
  const extra = _jsonParse(obj._extra, {});
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

// ── Generic upsert builder ───────────────────────────────────────────────

function buildUpsert(table, row, pkCol) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== pkCol).map(c => `${c} = excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(${pkCol}) DO UPDATE SET ${updates}`;
  return { sql, values: cols.map(c => row[c] === undefined ? null : row[c]) };
}

// ── Prepared statements ──────────────────────────────────────────────────

const stmts = {
  getAllUsers:           db.prepare('SELECT * FROM users'),
  getUserById:          db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail:       db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  getUserByRefToken:    db.prepare('SELECT * FROM users WHERE refToken = ?'),
  getUsersByRole:       db.prepare('SELECT * FROM users WHERE role = ?'),
  getUsersByInmobiliaria: db.prepare(
    "SELECT * FROM users WHERE role IN ('broker', 'agency', 'secretary') AND inmobiliaria_id = ?"
  ),
  getSecretariesByInmobiliaria: db.prepare(
    "SELECT * FROM users WHERE role = 'secretary' AND inmobiliaria_id = ?"
  ),

  // Activity
  getActivityByUser:    db.prepare('SELECT * FROM activity WHERE userId = ? ORDER BY id ASC'),
  getListingActivity:   db.prepare(
    "SELECT * FROM activity WHERE type = 'view_listing' AND listingId IS NOT NULL AND timestamp >= ?"
  ),
  insertActivity:       db.prepare(
    'INSERT INTO activity (userId, type, listingId, timestamp, data) VALUES (@userId, @type, @listingId, @timestamp, @data)'
  ),
  countActivityByUser:  db.prepare('SELECT COUNT(*) as cnt FROM activity WHERE userId = ?'),
  deleteOldestActivity: db.prepare(
    'DELETE FROM activity WHERE id IN (SELECT id FROM activity WHERE userId = ? ORDER BY id ASC LIMIT ?)'
  ),

  // Submissions
  getAllSubmissions:     db.prepare('SELECT * FROM submissions'),
  getApprovedSubmissions: db.prepare("SELECT * FROM submissions WHERE status = 'approved'"),
  getSubmissionById:    db.prepare('SELECT * FROM submissions WHERE id = ?'),

  // Applications
  getAllApplications:   db.prepare('SELECT * FROM applications'),
  getApplicationById:  db.prepare('SELECT * FROM applications WHERE id = ?'),
  getAppsByBroker:     db.prepare(
    "SELECT * FROM applications WHERE broker_id = ? OR json_extract(broker, '$.user_id') = ?"
  ),
  getAppsByClient:     db.prepare(
    "SELECT * FROM applications WHERE client_name = ? OR client_email = ? COLLATE NOCASE OR json_extract(client, '$.user_id') = ? OR json_extract(client, '$.email') = ? COLLATE NOCASE"
  ),
  getAppsByInmobiliaria: db.prepare('SELECT * FROM applications WHERE inmobiliaria_id = ?'),

  // Revoked tokens
  insertRevokedToken:  db.prepare(
    'INSERT OR REPLACE INTO revoked_tokens (jti, exp, revokedAt) VALUES (?, ?, ?)'
  ),
  pruneRevokedTokens:  db.prepare('DELETE FROM revoked_tokens WHERE exp <= ?'),
  isTokenRevoked:      db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ? AND exp > ?'),

  // Conversations
  getAllConversations:  db.prepare('SELECT * FROM conversations'),
  getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  getConvsByClient:    db.prepare('SELECT * FROM conversations WHERE clientId = ?'),
  getConvsForBroker:   db.prepare('SELECT * FROM conversations WHERE brokerId IS NULL OR brokerId = ?'),

  // Meta leads
  getAllMetaLeads:      db.prepare('SELECT * FROM meta_leads ORDER BY id DESC'),
  getMetaLeadByLeadgenId: db.prepare('SELECT 1 FROM meta_leads WHERE leadgenId = ?'),
  insertMetaLead:      db.prepare('INSERT INTO meta_leads (leadgenId, data) VALUES (?, ?)'),

  // Availability
  getAllAvailability:   db.prepare('SELECT * FROM availability'),
  getAvailByBroker:    db.prepare('SELECT * FROM availability WHERE broker_id = ?'),
  deleteAvailSlot:     db.prepare('DELETE FROM availability WHERE id = ?'),

  // Tours
  getAllTours:          db.prepare('SELECT * FROM tours'),
  getTourById:         db.prepare('SELECT * FROM tours WHERE id = ?'),
  getToursByBroker:    db.prepare('SELECT * FROM tours WHERE broker_id = ?'),
  getToursByClient:    db.prepare('SELECT * FROM tours WHERE client_id = ?'),
  getToursByListing:   db.prepare('SELECT * FROM tours WHERE listing_id = ?'),
  getBookedSlots:      db.prepare(
    "SELECT * FROM tours WHERE broker_id = ? AND requested_date = ? AND status IN ('confirmed', 'pending')"
  ),

  // 2FA Sessions
  getAllTwoFA:          db.prepare('SELECT * FROM twofa_sessions'),
  getTwoFAById:        db.prepare('SELECT * FROM twofa_sessions WHERE id = ?'),
  deleteTwoFA:         db.prepare('DELETE FROM twofa_sessions WHERE id = ?'),

  // Push subscriptions
  getAllPush:           db.prepare('SELECT * FROM push_subscriptions'),
  getPushByUser:       db.prepare('SELECT * FROM push_subscriptions WHERE userId = ?'),

  // Saved searches
  getSavedSearchesByUser: db.prepare('SELECT * FROM saved_searches WHERE userId = ? ORDER BY createdAt DESC'),
  getSavedSearchById:     db.prepare('SELECT * FROM saved_searches WHERE id = ?'),
  getAllSavedSearches:     db.prepare('SELECT * FROM saved_searches WHERE notify = 1'),
  deleteSavedSearch:       db.prepare('DELETE FROM saved_searches WHERE id = ? AND userId = ?'),
};

// ── Users ─────────────────────────────────────────────────────────────────

function getUsers() {
  return stmts.getAllUsers.all().map(hydrateUser);
}

function getUserById(id) {
  return hydrateUser(stmts.getUserById.get(id));
}

function getUserByEmail(email) {
  return hydrateUser(stmts.getUserByEmail.get(email));
}

function getUserByRefToken(token) {
  return hydrateUser(stmts.getUserByRefToken.get(token));
}

function saveUser(user) {
  const row = dehydrateUser(user);
  const { sql, values } = buildUpsert('users', row, 'id');
  db.prepare(sql).run(...values);
}

function getUsersByRole(role) {
  return stmts.getUsersByRole.all(role).map(hydrateUser);
}

function getUsersByInmobiliaria(inmobiliariaId) {
  return stmts.getUsersByInmobiliaria.all(inmobiliariaId).map(hydrateUser);
}

function getSecretariesByInmobiliaria(inmobiliariaId) {
  return stmts.getSecretariesByInmobiliaria.all(inmobiliariaId).map(hydrateUser);
}

// ── Activity ──────────────────────────────────────────────────────────────

function getActivityByUser(userId, limit = 200) {
  const rows = stmts.getActivityByUser.all(userId);
  return rows.slice(-limit).map(r => {
    const obj = { userId: r.userId, type: r.type, listingId: r.listingId, timestamp: r.timestamp };
    const data = _jsonParse(r.data, {});
    if (data && typeof data === 'object') {
      Object.assign(obj, data);
    }
    return obj;
  });
}

function getListingActivity(sinceMs) {
  // sinceMs is a Date object or timestamp - convert to ISO string for comparison
  const sinceStr = (sinceMs instanceof Date) ? sinceMs.toISOString() : new Date(sinceMs).toISOString();
  return stmts.getListingActivity.all(sinceStr).map(r => {
    const obj = { userId: r.userId, type: r.type, listingId: r.listingId, timestamp: r.timestamp };
    const data = _jsonParse(r.data, {});
    if (data && typeof data === 'object') {
      Object.assign(obj, data);
    }
    return obj;
  });
}

function appendActivity(event) {
  const knownCols = ['userId', 'type', 'listingId', 'timestamp'];
  const params = {
    userId: event.userId || null,
    type: event.type || null,
    listingId: event.listingId || null,
    timestamp: event.timestamp || null,
    data: '{}',
  };
  // Everything else goes into data
  const dataObj = {};
  for (const [k, v] of Object.entries(event)) {
    if (!knownCols.includes(k)) {
      dataObj[k] = v;
    }
  }
  params.data = JSON.stringify(dataObj);
  stmts.insertActivity.run(params);

  // Enforce per-user cap
  const { cnt } = stmts.countActivityByUser.get(event.userId);
  if (cnt > ACTIVITY_CAP) {
    stmts.deleteOldestActivity.run(event.userId, cnt - ACTIVITY_CAP);
  }
}

// ── Listings (submissions) ────────────────────────────────────────────────

function getListings(filters = {}) {
  // ── Fast path: full-text search with FTS5 ──────────────────
  if (filters.q) {
    // Clean the query for FTS5: escape quotes, add prefix matching
    const raw = String(filters.q).replace(/"/g, '').trim();
    if (!raw) return getListings({ ...filters, q: undefined });

    // Build FTS query: each word gets prefix matching
    const terms = raw.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ');
    try {
      const ftsRows = db.prepare(
        "SELECT id FROM listings_fts WHERE listings_fts MATCH ?"
      ).all(terms);
      const matchedIds = new Set(ftsRows.map(r => r.id));

      if (!matchedIds.size) return [];

      // Get from cache and apply remaining filters
      const cache = _ensureCache();
      let results = [];
      for (const id of matchedIds) {
        const l = cache.get(id);
        if (l) results.push(l);
      }

      // Apply the same filters as below (except q)
      const subFilters = { ...filters };
      delete subFilters.q;
      results = _applyInMemoryFilters(results, subFilters);
      return results;
    } catch(e) {
      // FTS query syntax error — fall back to LIKE search
      console.log('[Store] FTS error, falling back to LIKE:', e.message);
      const cache = _ensureCache();
      const q = raw.toLowerCase();
      let results = [];
      for (const l of cache.values()) {
        if ((l.title || '').toLowerCase().includes(q) ||
            (l.description || '').toLowerCase().includes(q) ||
            (l.city || '').toLowerCase().includes(q) ||
            (l.sector || '').toLowerCase().includes(q) ||
            (l.province || '').toLowerCase().includes(q) ||
            (l.address || '').toLowerCase().includes(q)) {
          results.push(l);
        }
      }
      const subFilters = { ...filters };
      delete subFilters.q;
      return _applyInMemoryFilters(results, subFilters);
    }
  }

  // ── No text search: use cache with in-memory filtering ─────
  const cache = _ensureCache();
  let results = Array.from(cache.values());
  return _applyInMemoryFilters(results, filters);
}

// Apply structured filters to an array of listings
function _applyInMemoryFilters(listings, filters) {
  let results = listings;

  if (filters.province) {
    results = results.filter(l => l.province === filters.province);
  }
  if (filters.city) {
    results = results.filter(l => l.city === filters.city);
  }
  if (filters.type) {
    results = results.filter(l => l.type === filters.type);
  }
  if (filters.condition) {
    results = results.filter(l => l.condition === filters.condition);
  }
  if (filters.propertyType) {
    // propertyType maps to the condition field for some types, or tags
    const pt = filters.propertyType.toLowerCase();
    results = results.filter(l => {
      const lType = (l.type || '').toLowerCase();
      const lCondition = (l.condition || '').toLowerCase();
      const tags = Array.isArray(l.tags) ? l.tags.map(t => t.toLowerCase()) : [];
      return lType === pt || lCondition === pt || tags.includes(pt);
    });
  }
  if (filters.priceMax) {
    const max = parseFloat(filters.priceMax) || 0;
    results = results.filter(l => Number(l.price) <= max);
  }
  if (filters.priceMin) {
    const min = parseFloat(filters.priceMin) || 0;
    results = results.filter(l => Number(l.price) >= min);
  }
  if (filters.bedroomsMin) {
    const min = Number(filters.bedroomsMin);
    results = results.filter(l => Number(l.bedrooms) >= min);
  }

  return results;
}

function getAllSubmissions() {
  return stmts.getAllSubmissions.all().map(hydrateSubmission);
}

function getListingById(id) {
  return hydrateSubmission(stmts.getSubmissionById.get(id));
}

function saveListing(listing) {
  const row = dehydrateSubmission(listing);
  const { sql, values } = buildUpsert('submissions', row, 'id');
  db.prepare(sql).run(...values);
  _invalidateCache();

  // Update FTS index for this listing
  try {
    const rowid = db.prepare('SELECT rowid FROM submissions WHERE id = ?').get(listing.id);
    if (rowid) {
      db.prepare("INSERT INTO listings_fts(listings_fts, rowid, id, title, description, city, sector, province, address) VALUES('delete', ?, ?, ?, ?, ?, ?, ?, ?)").run(
        rowid.rowid, listing.id, listing.title || '', listing.description || '',
        listing.city || '', listing.sector || '', listing.province || '', listing.address || ''
      );
      db.prepare('INSERT INTO listings_fts(rowid, id, title, description, city, sector, province, address) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
        rowid.rowid, listing.id, listing.title || '', listing.description || '',
        listing.city || '', listing.sector || '', listing.province || '', listing.address || ''
      );
    }
  } catch(e) {
    console.log('[Store] FTS update error:', e.message);
  }
}

// ── Applications ──────────────────────────────────────────────────────────

function getApplications() {
  return stmts.getAllApplications.all().map(hydrateApplication);
}

function getApplicationById(id) {
  return hydrateApplication(stmts.getApplicationById.get(id));
}

function getApplicationsByBroker(uid) {
  return stmts.getAppsByBroker.all(uid, uid).map(hydrateApplication);
}

function getApplicationsByClient(uidOrEmail) {
  return stmts.getAppsByClient.all(uidOrEmail, uidOrEmail, uidOrEmail, uidOrEmail).map(hydrateApplication);
}

function getApplicationsByInmobiliaria(inmobiliariaId) {
  return stmts.getAppsByInmobiliaria.all(inmobiliariaId).map(hydrateApplication);
}

function saveApplication(app) {
  const row = dehydrateApplication(app);
  const { sql, values } = buildUpsert('applications', row, 'id');
  db.prepare(sql).run(...values);
}

// ── Revoked Tokens ────────────────────────────────────────────────────────

function revokeToken(jti, exp) {
  if (!jti) return;
  const now = Math.floor(Date.now() / 1000);
  // Prune expired entries
  stmts.pruneRevokedTokens.run(now);
  stmts.insertRevokedToken.run(jti, exp, new Date().toISOString());
}

function isTokenRevoked(jti) {
  if (!jti) return false;
  const now = Math.floor(Date.now() / 1000);
  return !!stmts.isTokenRevoked.get(jti, now);
}

// ── Conversations ─────────────────────────────────────────────────────────

function hydrateConversation(row) {
  if (!row) return null;
  return _jsonParse(row.data, null);
}

function getConversations() {
  return stmts.getAllConversations.all().map(hydrateConversation).filter(Boolean);
}

function getConversationById(id) {
  return hydrateConversation(stmts.getConversationById.get(id));
}

function getConversationsByClient(clientId) {
  return stmts.getConvsByClient.all(clientId).map(hydrateConversation).filter(Boolean);
}

function getConversationsForBroker(brokerId) {
  return stmts.getConvsForBroker.all(brokerId).map(hydrateConversation).filter(Boolean);
}

function saveConversation(conv) {
  const sql = `INSERT INTO conversations (id, clientId, brokerId, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET clientId = excluded.clientId, brokerId = excluded.brokerId, data = excluded.data`;
  db.prepare(sql).run(conv.id, conv.clientId || null, conv.brokerId || null, JSON.stringify(conv));
}

// ── Meta Leads ────────────────────────────────────────────────────────────

function getMetaLeads() {
  return stmts.getAllMetaLeads.all().map(r => _jsonParse(r.data, null)).filter(Boolean);
}

function appendMetaLead(lead) {
  if (lead.leadgenId && stmts.getMetaLeadByLeadgenId.get(lead.leadgenId)) return;
  stmts.insertMetaLead.run(lead.leadgenId || null, JSON.stringify(lead));
}

// ── Availability ──────────────────────────────────────────────────────────

function getAvailability() {
  return stmts.getAllAvailability.all().map(hydrateAvailability);
}

function getAvailabilityByBroker(brokerId) {
  return stmts.getAvailByBroker.all(brokerId).map(hydrateAvailability);
}

function saveAvailabilitySlot(slot) {
  const row = dehydrateAvailability(slot);
  const { sql, values } = buildUpsert('availability', row, 'id');
  db.prepare(sql).run(...values);
}

function deleteAvailabilitySlot(id) {
  stmts.deleteAvailSlot.run(id);
}

// ── Tours ─────────────────────────────────────────────────────────────────

function getTours() {
  return stmts.getAllTours.all().map(hydrateTour);
}

function getTourById(id) {
  return hydrateTour(stmts.getTourById.get(id));
}

function getToursByBroker(brokerId) {
  return stmts.getToursByBroker.all(brokerId).map(hydrateTour);
}

function getToursByClient(clientId) {
  return stmts.getToursByClient.all(clientId).map(hydrateTour);
}

function getToursByListing(listingId) {
  return stmts.getToursByListing.all(listingId).map(hydrateTour);
}

function getBookedSlots(brokerId, date) {
  return stmts.getBookedSlots.all(brokerId, date).map(hydrateTour);
}

function saveTour(tour) {
  const row = dehydrateTour(tour);
  const { sql, values } = buildUpsert('tours', row, 'id');
  db.prepare(sql).run(...values);
}

// ── 2FA Sessions ──────────────────────────────────────────────────────────

function getTwoFASessions() {
  return stmts.getAllTwoFA.all().map(r => _jsonParse(r.data, null)).filter(Boolean);
}

function getTwoFASession(id) {
  const row = stmts.getTwoFAById.get(id);
  if (!row) return null;
  return _jsonParse(row.data, null);
}

function saveTwoFASession(session) {
  const sql = `INSERT INTO twofa_sessions (id, data) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data`;
  db.prepare(sql).run(session.id, JSON.stringify(session));
}

function deleteTwoFASession(id) {
  stmts.deleteTwoFA.run(id);
}

function cleanExpiredTwoFASessions() {
  const now = new Date();
  const all = stmts.getAllTwoFA.all();
  for (const row of all) {
    const session = _jsonParse(row.data, null);
    if (session && new Date(session.expiresAt) <= now) {
      stmts.deleteTwoFA.run(row.id);
    }
  }
}

// ── Push Subscriptions ───────────────────────────────────────────────────

function getPushSubscriptions() {
  const rows = stmts.getAllPush.all();
  const result = {};
  for (const row of rows) {
    result[row.userId] = {
      web: _jsonParse(row.web, []),
      ios: _jsonParse(row.ios, []),
      preferences: _jsonParse(row.preferences, {}),
    };
  }
  return result;
}

function getPushSubscriptionsByUser(userId) {
  const row = stmts.getPushByUser.get(userId);
  if (!row) return { web: [], ios: [], preferences: {} };
  return {
    web: _jsonParse(row.web, []),
    ios: _jsonParse(row.ios, []),
    preferences: _jsonParse(row.preferences, {}),
  };
}

function savePushSubscription(userId, data) {
  const current = getPushSubscriptionsByUser(userId);

  if (data.type === 'web' && data.subscription) {
    const exists = current.web.some(s => s.endpoint === data.subscription.endpoint);
    if (!exists) current.web.push(data.subscription);
  } else if (data.type === 'ios' && data.deviceToken) {
    if (!current.ios.includes(data.deviceToken)) {
      current.ios.push(data.deviceToken);
    }
  }

  const sql = `INSERT INTO push_subscriptions (userId, web, ios, preferences)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET web = excluded.web, ios = excluded.ios, preferences = excluded.preferences`;
  db.prepare(sql).run(userId, JSON.stringify(current.web), JSON.stringify(current.ios), JSON.stringify(current.preferences));
}

function removePushSubscription(userId, type, identifier) {
  const current = getPushSubscriptionsByUser(userId);
  if (type === 'web') {
    current.web = current.web.filter(s => s.endpoint !== identifier);
  } else if (type === 'ios') {
    current.ios = current.ios.filter(t => t !== identifier);
  }
  const sql = `INSERT INTO push_subscriptions (userId, web, ios, preferences)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET web = excluded.web, ios = excluded.ios, preferences = excluded.preferences`;
  db.prepare(sql).run(userId, JSON.stringify(current.web), JSON.stringify(current.ios), JSON.stringify(current.preferences));
}

function getPushPreferences(userId) {
  const row = stmts.getPushByUser.get(userId);
  if (!row) return {};
  return _jsonParse(row.preferences, {});
}

function savePushPreferences(userId, prefs) {
  const current = getPushSubscriptionsByUser(userId);
  const sql = `INSERT INTO push_subscriptions (userId, web, ios, preferences)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET preferences = excluded.preferences`;
  db.prepare(sql).run(userId, JSON.stringify(current.web), JSON.stringify(current.ios), JSON.stringify(prefs));
}

// ── Saved Searches ───────────────────────────────────────────────────────

function hydrateSavedSearch(row) {
  if (!row) return null;
  const obj = { ...row };
  obj.filters      = _jsonParse(obj.filters, {});
  obj.lastMatchIds = _jsonParse(obj.lastMatchIds, []);
  obj.notify       = !!obj.notify;
  return obj;
}

function getSavedSearchesByUser(userId) {
  return stmts.getSavedSearchesByUser.all(userId).map(hydrateSavedSearch);
}

function getSavedSearchById(id) {
  return hydrateSavedSearch(stmts.getSavedSearchById.get(id));
}

function getAllNotifiableSavedSearches() {
  return stmts.getAllSavedSearches.all().map(hydrateSavedSearch);
}

function saveSavedSearch(search) {
  const row = {
    id:             search.id,
    userId:         search.userId,
    name:           search.name,
    filters:        _jsonStringify(search.filters),
    notify:         search.notify ? 1 : 0,
    lastMatchIds:   _jsonStringify(search.lastMatchIds || []),
    lastNotifiedAt: search.lastNotifiedAt || null,
    matchCount:     search.matchCount || 0,
    createdAt:      search.createdAt || new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  };
  const { sql, values } = buildUpsert('saved_searches', row, 'id');
  db.prepare(sql).run(...values);
}

function deleteSavedSearch(id, userId) {
  return stmts.deleteSavedSearch.run(id, userId);
}

// ── Blog Posts ────────────────────────────────────────────────────────────────

function hydrateBlogPost(row) {
  if (!row) return null;
  const obj = { ...row };
  obj.featured = !!obj.featured;
  obj._extra   = _jsonParse(obj._extra, {});
  return obj;
}

function getBlogPosts(status) {
  const rows = status
    ? db.prepare('SELECT * FROM blog_posts WHERE status = ? ORDER BY published_at DESC, created_at DESC').all(status)
    : db.prepare('SELECT * FROM blog_posts ORDER BY published_at DESC, created_at DESC').all();
  return rows.map(hydrateBlogPost);
}

function getBlogPostById(id) {
  return hydrateBlogPost(db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id));
}

function getBlogPostBySlug(slug) {
  return hydrateBlogPost(db.prepare('SELECT * FROM blog_posts WHERE slug = ?').get(slug));
}

function saveBlogPost(post) {
  const row = {
    id:          post.id,
    slug:        post.slug,
    title:       post.title       || '',
    excerpt:     post.excerpt     || '',
    content:     post.content     || '',
    category:    post.category    || 'general',
    cover_image: post.cover_image || '',
    author:      post.author      || 'Equipo HogaresRD',
    read_time:   post.read_time   || 5,
    featured:    post.featured    ? 1 : 0,
    status:      post.status      || 'draft',
    views:       post.views       || 0,
    published_at:post.published_at || null,
    created_at:  post.created_at  || new Date().toISOString(),
    updated_at:  new Date().toISOString(),
    _extra:      _jsonStringify(post._extra || {}),
  };
  const { sql, values } = buildUpsert('blog_posts', row, 'id');
  db.prepare(sql).run(...values);
}

function deleteBlogPost(id) {
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
}

function incrementBlogViews(slug) {
  db.prepare('UPDATE blog_posts SET views = views + 1 WHERE slug = ?').run(slug);
}

// ── Page Content ──────────────────────────────────────────────────────────────

function getAllPageContent() {
  return db.prepare('SELECT * FROM page_content').all()
    .map(r => ({ ...r, data: _jsonParse(r.data, {}) }));
}

function getPageSection(page, section) {
  const row = db.prepare('SELECT * FROM page_content WHERE page = ? AND section = ?').get(page, section);
  return row ? { ...row, data: _jsonParse(row.data, {}) } : null;
}

function savePageSection(id, page, section, data) {
  db.prepare(`INSERT INTO page_content (id, page, section, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(page, section) DO UPDATE SET data = excluded.data, id = excluded.id`)
    .run(id, page, section, _jsonStringify(data));
}

// ── Reports ──────────────────────────────────────────────────────────────

function getReports(status) {
  if (status) return db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC').all(status);
  return db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
}

function getReportById(id) {
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) || null;
}

function saveReport(report) {
  const cols = ['id', 'type', 'target_id', 'target_name', 'reporter_id', 'reporter_name',
    'reporter_email', 'reason', 'details', 'attachment', 'status', 'admin_notes', 'created_at', 'updated_at'];
  const row = {};
  for (const col of cols) row[col] = report[col] === undefined ? null : report[col];
  const placeholders = cols.map(c => '@' + c).join(', ');
  db.prepare(`INSERT OR REPLACE INTO reports (${cols.join(', ')}) VALUES (${placeholders})`).run(row);
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  getUsers, getUserById, getUserByEmail, getUserByRefToken, saveUser,
  getActivityByUser, getListingActivity, appendActivity,
  getListings, getListingById, saveListing, invalidateListingsCache: _invalidateCache,
  getAllSubmissions,
  getApplications, getApplicationById, getApplicationsByBroker,
  getApplicationsByClient, getApplicationsByInmobiliaria, saveApplication,
  getConversations, getConversationById, getConversationsByClient,
  getConversationsForBroker, saveConversation,
  getMetaLeads, appendMetaLead,
  getUsersByRole, getUsersByInmobiliaria, getSecretariesByInmobiliaria,
  revokeToken, isTokenRevoked,
  getAvailability, getAvailabilityByBroker, saveAvailabilitySlot, deleteAvailabilitySlot,
  getTours, getTourById, getToursByBroker, getToursByClient, getToursByListing,
  getBookedSlots, saveTour,
  getTwoFASessions, getTwoFASession, saveTwoFASession, deleteTwoFASession, cleanExpiredTwoFASessions,
  getPushSubscriptions, getPushSubscriptionsByUser, savePushSubscription,
  removePushSubscription, getPushPreferences, savePushPreferences,
  getSavedSearchesByUser, getSavedSearchById, getAllNotifiableSavedSearches,
  saveSavedSearch, deleteSavedSearch,
  getBlogPosts, getBlogPostById, getBlogPostBySlug, saveBlogPost, deleteBlogPost, incrementBlogViews,
  getAllPageContent, getPageSection, savePageSection,
  getReports, getReportById, saveReport,
  /** Run fn inside a SQLite transaction. Rolls back on throw. Use for
   * multi-step reads+writes that must be atomic (e.g., inventory unit
   * assign flows). */
  withTransaction: (fn) => db.transaction(fn)(),
};
