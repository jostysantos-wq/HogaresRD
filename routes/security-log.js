/**
 * Security event logger — Sprint 3, Item 10
 *
 * Writes structured security events to data/security_log.json.
 * Never throws — logging must never break a request flow.
 *
 * Usage:
 *   const { logSec } = require('./security-log');
 *   logSec('login_failed', req, { email: 'x@y.com' });
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

const LOG_FILE = path.join(__dirname, '..', 'data', 'security_log.json');
const MAX_EVENTS = 10_000;

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

    let events;
    try {
      events = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } catch {
      events = [];
    }

    events.push(entry);

    // Cap at MAX_EVENTS (oldest removed first)
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }

    fs.writeFileSync(LOG_FILE, JSON.stringify(events, null, 2));
  } catch {
    // Never propagate — logging errors must not affect the request
  }
}

module.exports = { logSec };
