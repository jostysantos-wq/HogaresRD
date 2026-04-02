#!/usr/bin/env node
/**
 * Migration script: JSON flat files -> SQLite (better-sqlite3)
 *
 * Reads all JSON data files from data/, creates the hogaresrd.db SQLite
 * database, and imports every record using the same schema as store.js.
 *
 * Usage:
 *   node scripts/migrate-json-to-sqlite.js
 *
 * Safety: refuses to run if hogaresrd.db already exists.
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'hogaresrd.db');

// ── Safety check ──────────────────────────────────────────────────────────
if (fs.existsSync(DB_PATH)) {
  console.error(`\n  ERROR: ${DB_PATH} already exists.`);
  console.error('  Delete it manually if you want to re-run the migration.\n');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function readJSON(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`  Warning: could not parse ${filename}: ${err.message}`);
    return null;
  }
}

function jsonStr(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function boolInt(val) {
  return val ? 1 : 0;
}

// ── Create database + schema ──────────────────────────────────────────────

console.log('\nCreating SQLite database at', DB_PATH, '...\n');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF');

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
    construction_company TEXT,
    _extra             TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

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
`);

console.log('  Tables created.\n');

// ── Known columns for each table ──────────────────────────────────────────

const USER_KNOWN_COLS = [
  'id', 'email', 'passwordHash', 'password', 'name', 'phone', 'role',
  'emailVerified', 'marketingOptIn', 'createdAt', 'lastLoginAt', 'licenseNumber',
  'refToken', 'stripeCustomerId', 'inmobiliaria_id', 'inmobiliaria_name',
  'inmobiliaria_join_status', 'inmobiliaria_joined_at', 'inmobiliaria_pending_id',
  'inmobiliaria_pending_name', 'loginAttempts', 'loginLockedUntil', 'lockedUntil',
  'jobTitle', 'notes', 'twoFAEnabled', 'biometricTokenHash',
  'favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile',
];
const USER_JSON_COLS = ['favorites', 'agency', 'join_requests', 'secretary_invites', 'subscription', 'profile'];
const USER_BOOL_COLS = ['emailVerified', 'marketingOptIn', 'twoFAEnabled'];

const SUBMISSION_KNOWN_COLS = [
  'id', 'title', 'type', 'condition', 'description', 'price', 'area_const', 'area_land',
  'bedrooms', 'bathrooms', 'parking', 'province', 'city', 'sector', 'address', 'lat', 'lng',
  'name', 'email', 'phone', 'role', 'status', 'submittedAt', 'approvedAt', 'rejectedAt',
  'updatedAt', 'views', 'floors', 'units_total', 'units_available', 'project_stage',
  'delivery_date', 'submission_type', 'claim_listing_id',
  'amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'construction_company',
];
const SUBMISSION_JSON_COLS = ['amenities', 'agencies', 'images', 'blueprints', 'tags', 'unit_types', 'construction_company'];

const APP_KNOWN_COLS = [
  'id', 'listing_id', 'listing_title', 'listing_price', 'listing_type', 'status',
  'status_reason', 'inmobiliaria_id', 'created_at', 'updated_at', 'financing',
  'pre_approved', 'budget', 'timeline', 'intent', 'contact_method', 'notes',
  'broker_id', 'client_name', 'client_email', 'client_phone',
  'client', 'broker', 'payment', 'payment_plan', 'documents_requested',
  'documents_uploaded', 'tours', 'timeline_events',
];
const APP_JSON_COLS = ['client', 'broker', 'payment', 'payment_plan', 'documents_requested', 'documents_uploaded', 'tours', 'timeline_events'];
const APP_BOOL_COLS = ['pre_approved'];

const AVAIL_KNOWN_COLS = [
  'id', 'broker_id', 'day_of_week', 'start_time', 'end_time', 'slot_duration_min',
  'max_concurrent', 'active', 'type', 'specific_date', 'created_at', 'updated_at',
];
const AVAIL_BOOL_COLS = ['active'];

const TOUR_KNOWN_COLS = [
  'id', 'listing_id', 'listing_title', 'broker_id', 'client_id', 'client_name',
  'client_email', 'client_phone', 'requested_date', 'requested_time', 'status',
  'broker_notes', 'client_notes', 'created_at', 'updated_at',
];

const ACTIVITY_KNOWN_COLS = ['userId', 'type', 'listingId', 'timestamp'];

// ── Generic dehydrate ─────────────────────────────────────────────────────

function dehydrate(obj, knownCols, jsonCols, boolCols) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(obj)) {
    if (knownCols.includes(k)) {
      if (jsonCols.includes(k)) {
        row[k] = jsonStr(v);
      } else if (boolCols.includes(k)) {
        row[k] = boolInt(v);
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

function buildInsert(table, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return { sql, values: cols.map(c => row[c] === undefined ? null : row[c]) };
}

// ── Migration ─────────────────────────────────────────────────────────────

const counts = {};

const migrate = db.transaction(() => {

  // ── Users ───────────────────────────────────────────────────────────
  const users = readJSON('users.json');
  counts.users = 0;
  if (Array.isArray(users)) {
    for (const u of users) {
      const row = dehydrate(u, USER_KNOWN_COLS, USER_JSON_COLS, USER_BOOL_COLS);
      const { sql, values } = buildInsert('users', row);
      db.prepare(sql).run(...values);
      counts.users++;
    }
  }

  // ── Activity ────────────────────────────────────────────────────────
  const activity = readJSON('activity.json');
  counts.activity = 0;
  if (Array.isArray(activity)) {
    const stmt = db.prepare(
      'INSERT INTO activity (userId, type, listingId, timestamp, data) VALUES (?, ?, ?, ?, ?)'
    );
    for (const evt of activity) {
      const dataObj = {};
      for (const [k, v] of Object.entries(evt)) {
        if (!ACTIVITY_KNOWN_COLS.includes(k)) {
          dataObj[k] = v;
        }
      }
      stmt.run(
        evt.userId || null,
        evt.type || null,
        evt.listingId || null,
        evt.timestamp || null,
        JSON.stringify(dataObj)
      );
      counts.activity++;
    }
  }

  // ── Submissions ─────────────────────────────────────────────────────
  const submissions = readJSON('submissions.json');
  counts.submissions = 0;
  if (Array.isArray(submissions)) {
    for (const s of submissions) {
      const row = dehydrate(s, SUBMISSION_KNOWN_COLS, SUBMISSION_JSON_COLS, []);
      const { sql, values } = buildInsert('submissions', row);
      db.prepare(sql).run(...values);
      counts.submissions++;
    }
  }

  // ── Applications ────────────────────────────────────────────────────
  const applications = readJSON('applications.json');
  counts.applications = 0;
  if (Array.isArray(applications)) {
    for (const a of applications) {
      // Handle both shapes: some have client as object, some have flat fields
      // Extract broker_id from broker object if not already flat
      const obj = { ...a };
      if (obj.broker && typeof obj.broker === 'object' && !obj.broker_id) {
        obj.broker_id = obj.broker.user_id || null;
      }
      // Extract client fields from client object if not already flat
      if (obj.client && typeof obj.client === 'object') {
        if (!obj.client_name) obj.client_name = obj.client.name || null;
        if (!obj.client_email) obj.client_email = obj.client.email || null;
        if (!obj.client_phone) obj.client_phone = obj.client.phone || null;
      }
      const row = dehydrate(obj, APP_KNOWN_COLS, APP_JSON_COLS, APP_BOOL_COLS);
      const { sql, values } = buildInsert('applications', row);
      db.prepare(sql).run(...values);
      counts.applications++;
    }
  }

  // ── Revoked Tokens ──────────────────────────────────────────────────
  const revoked = readJSON('revoked_tokens.json');
  counts.revoked_tokens = 0;
  if (Array.isArray(revoked)) {
    const stmt = db.prepare('INSERT OR REPLACE INTO revoked_tokens (jti, exp, revokedAt) VALUES (?, ?, ?)');
    for (const t of revoked) {
      stmt.run(t.jti, t.exp, t.revokedAt || null);
      counts.revoked_tokens++;
    }
  }

  // ── Conversations ──────────────────────────────────────────────────
  const conversations = readJSON('conversations.json');
  counts.conversations = 0;
  if (Array.isArray(conversations)) {
    const stmt = db.prepare('INSERT OR REPLACE INTO conversations (id, clientId, brokerId, data) VALUES (?, ?, ?, ?)');
    for (const c of conversations) {
      stmt.run(c.id, c.clientId || null, c.brokerId || null, JSON.stringify(c));
      counts.conversations++;
    }
  }

  // ── Meta Leads ─────────────────────────────────────────────────────
  const metaLeads = readJSON('meta_leads.json');
  counts.meta_leads = 0;
  if (Array.isArray(metaLeads)) {
    const stmt = db.prepare('INSERT INTO meta_leads (leadgenId, data) VALUES (?, ?)');
    for (const l of metaLeads) {
      stmt.run(l.leadgenId || null, JSON.stringify(l));
      counts.meta_leads++;
    }
  }

  // ── Availability ───────────────────────────────────────────────────
  const availability = readJSON('availability.json');
  counts.availability = 0;
  if (Array.isArray(availability)) {
    for (const slot of availability) {
      const row = dehydrate(slot, AVAIL_KNOWN_COLS, [], AVAIL_BOOL_COLS);
      const { sql, values } = buildInsert('availability', row);
      db.prepare(sql).run(...values);
      counts.availability++;
    }
  }

  // ── Tours ──────────────────────────────────────────────────────────
  const tours = readJSON('tours.json');
  counts.tours = 0;
  if (Array.isArray(tours)) {
    for (const t of tours) {
      const row = dehydrate(t, TOUR_KNOWN_COLS, [], []);
      const { sql, values } = buildInsert('tours', row);
      db.prepare(sql).run(...values);
      counts.tours++;
    }
  }

  // ── 2FA Sessions ──────────────────────────────────────────────────
  const twofaSessions = readJSON('twofa_sessions.json');
  counts.twofa_sessions = 0;
  if (Array.isArray(twofaSessions)) {
    const stmt = db.prepare('INSERT OR REPLACE INTO twofa_sessions (id, data) VALUES (?, ?)');
    for (const s of twofaSessions) {
      stmt.run(s.id, JSON.stringify(s));
      counts.twofa_sessions++;
    }
  }

  // ── Push Subscriptions ────────────────────────────────────────────
  const pushSubs = readJSON('push_subscriptions.json');
  counts.push_subscriptions = 0;
  if (pushSubs && typeof pushSubs === 'object' && !Array.isArray(pushSubs)) {
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO push_subscriptions (userId, web, ios, preferences) VALUES (?, ?, ?, ?)'
    );
    for (const [userId, data] of Object.entries(pushSubs)) {
      stmt.run(
        userId,
        JSON.stringify(data.web || []),
        JSON.stringify(data.ios || []),
        JSON.stringify(data.preferences || {})
      );
      counts.push_subscriptions++;
    }
  }
});

// ── Run the migration ─────────────────────────────────────────────────────

try {
  migrate();
} catch (err) {
  // Clean up the partial DB on failure
  db.close();
  try { fs.unlinkSync(DB_PATH); } catch {}
  console.error('\n  MIGRATION FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}

db.close();

// ── Report ────────────────────────────────────────────────────────────────

console.log('  Migration complete!\n');
console.log('  Records imported:');
for (const [table, count] of Object.entries(counts)) {
  console.log(`    ${table.padEnd(22)} ${count}`);
}
console.log(`\n  Database: ${DB_PATH}`);
console.log(`  Size: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB\n`);
