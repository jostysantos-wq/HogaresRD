/**
 * error-reporter.js — web client-side error reporting
 *
 * Mirrors the iOS ErrorReporter: catches uncaught errors and unhandled
 * promise rejections, batches them, posts to /api/admin/client-errors
 * (the same endpoint iOS uses).
 *
 * Designed to be defensive — must NEVER throw, must NEVER block, must
 * NEVER recurse on its own errors. Failures are dropped silently.
 *
 * Include this script as early as possible on every page so it can
 * catch errors that happen during page bootstrap.
 */
(function () {
  'use strict';

  // Defensive: if the reporter has already been installed (e.g. the
  // script is included twice), don't double-attach handlers.
  if (window.__hrdErrorReporterInstalled) return;
  window.__hrdErrorReporterInstalled = true;

  var ENDPOINT      = '/api/admin/client-errors';
  var MAX_BATCH     = 5;
  var FLUSH_MS      = 30 * 1000;
  var MAX_QUEUE     = 50;   // hard cap so a runaway error loop can't OOM the page
  var MESSAGE_LIMIT = 2000;
  var STACK_LIMIT   = 4000;

  var queue = [];
  var sending = false;
  var flushTimer = null;

  function clip(s, max) {
    if (!s) return '';
    s = String(s);
    return s.length > max ? s.slice(0, max) : s;
  }

  function readUserContext() {
    // Best-effort: most pages keep an authenticated user object on
    // window.ME. Don't fail if it's missing.
    try {
      var me = window.ME || (window.HRD && window.HRD.user) || null;
      if (me && me.id) {
        return { userId: String(me.id), userRole: String(me.role || '') };
      }
    } catch (_) {}
    return { userId: null, userRole: '' };
  }

  function deviceLabel() {
    try { return clip(navigator.userAgent, 50); } catch (_) { return ''; }
  }

  function osVersion() {
    // Cheap parse: pull "Mac OS X 14_5" / "iPhone OS 17_4" / "Windows NT 10.0" etc.
    try {
      var ua = navigator.userAgent || '';
      var m = ua.match(/(?:Mac OS X|iPhone OS|Android|Windows NT) [\d_.]+/);
      return m ? clip(m[0], 30) : '';
    } catch (_) { return ''; }
  }

  function enqueue(entry) {
    if (queue.length >= MAX_QUEUE) return; // protect against runaway loops
    queue.push(entry);
    if (queue.length >= MAX_BATCH) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
    }
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (sending || queue.length === 0) return;
    var batch = queue.splice(0, MAX_BATCH);
    sending = true;

    var body = JSON.stringify(batch);

    // Prefer sendBeacon when available — it survives page unload, which
    // is exactly when a fetch() POST tends to be killed. Fall back to
    // fetch with keepalive for compatibility.
    var sent = false;
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        sent = navigator.sendBeacon(ENDPOINT, blob);
      }
    } catch (_) {}

    if (!sent) {
      try {
        fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: body,
        }).catch(function () { /* swallow — we cannot recover */ });
      } catch (_) { /* same */ }
    }

    sending = false;
    if (queue.length > 0) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function buildEntry(message, stack, context, statusCode) {
    var u = readUserContext();
    return {
      source:     'web',
      timestamp:  new Date().toISOString(),
      message:    clip(message, MESSAGE_LIMIT),
      context:    clip(context, 500),
      stack:      clip(stack, STACK_LIMIT),
      appVersion: '',                          // web has no version yet
      osVersion:  osVersion(),
      device:     deviceLabel(),
      userId:     u.userId,
      userRole:   u.userRole,
      endpoint:   clip(location.pathname + location.search, 200),
      statusCode: statusCode || null,
    };
  }

  // ── Sync errors (window.onerror) ───────────────────────────────
  window.addEventListener('error', function (event) {
    try {
      var msg = (event && event.message) || 'Unknown error';
      var stack = (event && event.error && event.error.stack) || '';
      var ctx = '';
      if (event && (event.filename || event.lineno)) {
        ctx = (event.filename || '') + ':' + (event.lineno || 0);
      }
      // Resource-load errors (img/script/link with src that failed)
      // arrive as Event with no .message — give them a synthetic one.
      if (!event.message && event.target && event.target.src) {
        msg = 'Resource load failed: ' + event.target.src;
      }
      enqueue(buildEntry(msg, stack, ctx));
    } catch (_) {}
  }, true);

  // ── Unhandled promise rejections ───────────────────────────────
  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event && event.reason;
      var msg = (reason && reason.message) || String(reason || 'Unhandled rejection');
      var stack = (reason && reason.stack) || '';
      enqueue(buildEntry(msg, stack, 'unhandledrejection'));
    } catch (_) {}
  });

  // Best-effort flush on page hide so we don't lose what's queued.
  window.addEventListener('pagehide', function () {
    try { flush(); } catch (_) {}
  });

  // Public API for code that wants to manually report a caught error
  // (e.g. inside a try/catch around a fetch handler).
  window.HRDErrorReporter = {
    report: function (err, context, statusCode) {
      try {
        var msg = (err && err.message) || String(err || '');
        var stack = (err && err.stack) || '';
        enqueue(buildEntry(msg, stack, context || '', statusCode));
      } catch (_) {}
    },
    flush: flush,
  };
})();
