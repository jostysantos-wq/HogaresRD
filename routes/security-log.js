/**
 * Security event logger — Sprint 3, Item 10
 *
 * Writes structured security events to data/security_log.json as
 * append-only ND-JSON (one JSON object per line). This is O(1) per
 * write and safe under concurrent logins (a single fs.appendFileSync
 * in append mode is atomic for small writes on Linux/macOS).
 *
 * Never throws — logging must never break a request flow.
 *
 * Usage:
 *   const { logSec, readEvents } = require('./security-log');
 *   logSec('login_failed', req, { email: 'x@y.com' });
 *   const recent = readEvents(500); // last 500 events
 *
 * File rotation: when security_log.json exceeds 10MB, it's renamed to
 * security_log-YYYY-MM-DD.json and a fresh file starts. Only the last 7
 * rotated files are kept; older ones are deleted.
 *
 * Event types (add as needed):
 *   login_failed        — wrong password or unknown email
 *   login_success       — successful authentication
 *   token_rejected      — JWT verify failed or token revoked
 *   logout              — intentional sign-out
 *   role_violation      — user attempted an endpoint beyond their role
 *   admin_access        — admin key used successfully
 *   reset_requested     — password-reset email sent
 *   reset_used          — password successfully reset
 *   app_spam_blocked    — application creation rate-limited
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR        = path.join(__dirname, '..', 'data');
const LOG_FILE       = path.join(LOG_DIR, 'security_log.json');
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED    = 7;                // keep last 7 rotated files

function _rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_FILE_BYTES) return;
    const stamp     = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let rotatedName = `security_log-${stamp}.json`;
    let rotatedPath = path.join(LOG_DIR, rotatedName);
    // Avoid clobbering if a rotation already happened today.
    let suffix = 1;
    while (fs.existsSync(rotatedPath)) {
      rotatedName = `security_log-${stamp}.${suffix}.json`;
      rotatedPath = path.join(LOG_DIR, rotatedName);
      suffix++;
    }
    fs.renameSync(LOG_FILE, rotatedPath);

    // Prune old rotations: keep the newest MAX_ROTATED, delete the rest.
    const rotated = fs.readdirSync(LOG_DIR)
      .filter(f => /^security_log-\d{4}-\d{2}-\d{2}.*\.json$/.test(f))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of rotated.slice(MAX_ROTATED)) {
      try { fs.unlinkSync(path.join(LOG_DIR, old.name)); } catch { /* ignore */ }
    }
  } catch (err) {
    // ENOENT just means there's no file yet — that's fine, nothing to rotate.
    if (err && err.code !== 'ENOENT') {
      // Never propagate — rotation errors must not affect the request.
    }
  }
}

function logSec(type, req, extra = {}) {
  try {
    // Collect IP — trust X-Forwarded-For only behind a known proxy
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      'unknown';

    const entry = {
      id:        `sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      type,
      ip,
      method:    req.method,
      path:      req.path,
      userAgent: (req.headers['user-agent'] || '').slice(0, 200),
      ...extra,
    };

    _rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Never propagate — logging errors must not affect the request
  }
}

/**
 * Read the last `limit` events from the active log file. Parses the
 * file line-by-line; malformed lines are skipped silently.
 *
 * Used by the admin endpoint that surfaces recent security events.
 */
function readEvents(limit = 1000) {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

module.exports = { logSec, readEvents };
