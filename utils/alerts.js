// ═══════════════════════════════════════════════════════════════════
// Lightweight ops alerting — fires a webhook (Slack/Discord compatible)
// when something is genuinely wrong.
//
// Usage:
//   const { sendAlert } = require('./utils/alerts');
//   await sendAlert('critical', 'DB unreachable from app process', { uptime, memory });
//
// Behavior:
//   - No-op if ALERT_WEBHOOK_URL is not set (just console.warn).
//   - In tests, suppress alerts entirely.
//   - Same `title` is throttled to once per 5 minutes (module-level Map).
//   - All HTTP calls time out after 3s.
//   - Failures inside sendAlert never throw — wrapped in try/catch.
//
// No new npm deps — uses Node built-ins only (https, http, url).
// ═══════════════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes per title
const HTTP_TIMEOUT_MS = 3000;

// Module-level Map: <title> -> lastSentTimestamp
const _lastSent = new Map();

function alertingConfigured() {
  return !!process.env.ALERT_WEBHOOK_URL;
}

function _formatPayload(severity, title, details) {
  let body;
  try {
    body = typeof details === 'string'
      ? details
      : JSON.stringify(details || {}, null, 2);
  } catch (_) {
    body = String(details);
  }
  return {
    text: `[${String(severity).toUpperCase()}] ${title}\n\`\`\`${body}\`\`\``,
  };
}

function _post(urlStr, payload) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); }
    catch (e) { return reject(e); }

    const lib = parsed.protocol === 'http:' ? http : https;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');

    const req = lib.request({
      method:   'POST',
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path:     parsed.pathname + parsed.search,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': data.length,
      },
    }, (res) => {
      // Drain so the socket can be reused / freed
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendAlert(severity, title, details) {
  try {
    // In tests, suppress alerts entirely.
    if (process.env.NODE_ENV === 'test') return;

    if (!alertingConfigured()) {
      console.warn(`[alerts] (no webhook) [${severity}] ${title}`);
      return;
    }

    // Throttle: same title within 5 minutes -> skip silently.
    const now = Date.now();
    const last = _lastSent.get(title) || 0;
    if (now - last < THROTTLE_MS) return;
    _lastSent.set(title, now);

    const payload = _formatPayload(severity, title, details);

    await Promise.race([
      _post(process.env.ALERT_WEBHOOK_URL, payload),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('alert webhook timeout')), HTTP_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    // Never throw from inside sendAlert.
    try { console.error('[alerts] sendAlert failed:', err && err.message); } catch (_) {}
  }
}

module.exports = {
  sendAlert,
  alertingConfigured,
  // Exposed for tests / ad-hoc reset.
  _resetThrottle: () => _lastSent.clear(),
};
