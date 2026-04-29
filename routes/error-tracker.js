'use strict';

const fs   = require('fs');
const path = require('path');
const express = require('express');

// ── Config ────────────────────────────────────────────────────────
const LOG_FILE      = path.join(__dirname, '..', 'data', 'errors.log');
const MAX_LOG_LINES = 10_000;
// Hard cap on file size. Once the log exceeds this we truncate to zero
// rather than try to read it into memory (which would OOM the process —
// and in production left the file at 55 GB / 75 M lines after that's
// exactly what happened in the EPIPE feedback loop).
const MAX_LOG_BYTES = 100 * 1024 * 1024;
const SLOW_REQ_MS   = 2000;
const TRIM_INTERVAL = 60 * 60 * 1000; // trim log every hour
const STATS_WINDOW  = 24 * 60 * 60 * 1000; // 24 hours

// stderr write that never throws — used from places that must not
// surface a downstream EPIPE (uncaughtException handler + log-write
// failure paths), since console.error there can re-trigger the
// uncaughtException it's reporting.
function safeStderr(msg) {
  try { process.stderr.write(String(msg) + '\n'); } catch {}
}

// ── In-memory error aggregation (last 24h) ────────────────────────
const errorCounts = []; // { route, method, timestamp }

function pruneOldErrors() {
  const cutoff = Date.now() - STATS_WINDOW;
  while (errorCounts.length && errorCounts[0].timestamp < cutoff) {
    errorCounts.shift();
  }
}

function recordError(method, url) {
  // Normalize route: strip query string and collapse IDs to :id
  const routePattern = url.split('?')[0].replace(/\/\d+/g, '/:id');
  errorCounts.push({ route: routePattern, method, timestamp: Date.now() });
}

// ── File logging ──────────────────────────────────────────────────
// Async appendFile so a heavy error stream doesn't block the event
// loop (the previous appendFileSync stalled the server during error
// bursts). The callback ignores errors — if logging fails, surfacing
// it via console.error from inside an uncaught-exception path would
// re-enter the same handler.
function appendLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFile(LOG_FILE, line, 'utf8', (err) => {
      if (err) safeStderr(`[error-tracker] Failed to write log: ${err.message}`);
    });
  } catch (e) {
    safeStderr(`[error-tracker] appendLog threw: ${e && e.message}`);
  }
}

function trimLogFile() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    // Hard size cap: if the file is huge (e.g. PM2 left it at multi-GB
    // after a restart loop), do NOT read it into memory — truncate to
    // zero. We lose the historical lines but keep the process alive.
    if (stats.size > MAX_LOG_BYTES) {
      fs.writeFileSync(LOG_FILE, '');
      console.log(`[error-tracker] Log file exceeded ${MAX_LOG_BYTES} bytes (was ${stats.size}) — truncated`);
      return;
    }
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      const trimmed = lines.slice(lines.length - MAX_LOG_LINES).join('\n') + '\n';
      fs.writeFileSync(LOG_FILE, trimmed, 'utf8');
      console.log(`[error-tracker] Trimmed log from ${lines.length} to ${MAX_LOG_LINES} lines`);
    }
  } catch (e) {
    safeStderr(`[error-tracker] Failed to trim log: ${e && e.message}`);
  }
}

// ── Middleware: request timer ─────────────────────────────────────
function requestTimer(req, res, next) {
  req._startTime = Date.now();

  // Hook into response finish to log slow requests
  const origEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - req._startTime;
    if (duration > SLOW_REQ_MS) {
      appendLog({
        level: 'warn',
        type: 'slow_request',
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        responseTimeMs: duration,
        userAgent: req.headers['user-agent'] || '',
        ip: req.ip || req.connection?.remoteAddress || '',
        userId: req.user?.id || null,
      });
    }
    origEnd.apply(res, args);
  };

  next();
}

// ── Middleware: 404 handler for API routes ─────────────────────────
function notFoundHandler(req, res) {
  const duration = req._startTime ? Date.now() - req._startTime : 0;
  const entry = {
    level: 'warn',
    type: 'not_found',
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl,
    statusCode: 404,
    responseTimeMs: duration,
    userAgent: req.headers['user-agent'] || '',
    ip: req.ip || req.connection?.remoteAddress || '',
    userId: req.user?.id || null,
  };
  appendLog(entry);
  recordError(req.method, req.originalUrl);
  res.status(404).json({ error: 'Ruta no encontrada' });
}

// ── Middleware: global error handler ──────────────────────────────
function errorHandler(err, req, res, next) {
  const duration = req._startTime ? Date.now() - req._startTime : 0;
  const statusCode = err.statusCode || err.status || 500;

  const entry = {
    level: 'error',
    type: 'unhandled_error',
    timestamp: new Date().toISOString(),
    message: err.message || 'Unknown error',
    stack: err.stack || null,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    responseTimeMs: duration,
    userAgent: req.headers['user-agent'] || '',
    ip: req.ip || req.connection?.remoteAddress || '',
    userId: req.user?.id || null,
  };

  appendLog(entry);
  recordError(req.method, req.originalUrl);
  console.error(`[error-tracker] ${req.method} ${req.originalUrl} -> ${statusCode}:`, err.message);

  if (!res.headersSent) {
    res.status(statusCode).json({ error: 'Error interno del servidor' });
  }
}

// ── Process-level handlers ────────────────────────────────────────
// Transport-level errors that aren't application bugs and that, if
// reported via console.error, can re-throw and re-enter this handler
// — the cause of the 75 M-line / 55 GB EPIPE feedback loop in prod.
const TRANSPORT_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN']);

function isTransportNoise(err) {
  return err && err.code && TRANSPORT_ERROR_CODES.has(err.code);
}

function initProcessHandlers() {
  process.on('uncaughtException', (err) => {
    // EPIPE on stderr (typical when the parent process or PM2 log
    // pipe goes away) used to fire console.error, which writes to
    // stderr again, which throws another EPIPE, and so on forever.
    // Drop transport noise silently — it is not actionable from code.
    if (isTransportNoise(err)) return;

    safeStderr(`[error-tracker] Uncaught exception: ${err && err.message}`);
    appendLog({
      level: 'fatal',
      type: 'uncaught_exception',
      timestamp: new Date().toISOString(),
      message: (err && err.message) || 'Unknown',
      code:    (err && err.code) || null,
      stack:   (err && err.stack) || null,
    });
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (isTransportNoise(err)) return;

    safeStderr(`[error-tracker] Unhandled rejection: ${err.message}`);
    appendLog({
      level: 'fatal',
      type: 'unhandled_rejection',
      timestamp: new Date().toISOString(),
      message: err.message || 'Unknown',
      code:    err.code || null,
      stack:   err.stack || null,
    });
  });

  // Trim log on startup — protected by the size cap added above so it
  // can't OOM on a multi-GB legacy log left by the EPIPE storm.
  trimLogFile();

  // Periodic trim
  setInterval(trimLogFile, TRIM_INTERVAL).unref();

  console.log('[error-tracker] Process handlers initialized');
}

// ── Error stats ───────────────────────────────────────────────────
function getErrorStats() {
  pruneOldErrors();
  const byRoute = {};
  for (const e of errorCounts) {
    const key = `${e.method} ${e.route}`;
    byRoute[key] = (byRoute[key] || 0) + 1;
  }
  return {
    totalErrors24h: errorCounts.length,
    byRoute,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };
}

// ── Read last N errors from log file ──────────────────────────────
function getRecentErrors(count = 50) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const recent = lines.slice(-count);
    return recent.map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    }).reverse();
  } catch (e) {
    console.error('[error-tracker] Failed to read log:', e.message);
    return [];
  }
}

// ── Admin API router ──────────────────────────────────────────────
const router = express.Router();

const { adminSessionAuth } = require('./admin-auth');

router.get('/errors', adminSessionAuth, (req, res) => {
  const stats = getErrorStats();
  const recentErrors = getRecentErrors(50);

  res.json({
    recentErrors,
    errorsByRoute: stats.byRoute,
    totalErrors24h: stats.totalErrors24h,
    uptime: stats.uptime,
    memory: stats.memory,
  });
});

// ── Client error reporting (iOS / web) ───────────────────────────
// Rate-limited: 20 reports per minute per IP to prevent abuse.
const rateLimit = require('express-rate-limit');
const clientErrorLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: false, legacyHeaders: false });

router.post('/client-errors', clientErrorLimiter, (req, res) => {
  const errors = Array.isArray(req.body) ? req.body.slice(0, 25) : [req.body];

  for (const err of errors) {
    appendLog({
      level:       'error',
      type:        'client_error',
      source:      String(err.source   || 'ios').slice(0, 20),
      timestamp:   err.timestamp       || new Date().toISOString(),
      message:     String(err.message  || '').slice(0, 2000),
      context:     String(err.context  || '').slice(0, 500),
      stack:       String(err.stack    || '').slice(0, 4000),
      appVersion:  String(err.appVersion  || '').slice(0, 20),
      osVersion:   String(err.osVersion   || '').slice(0, 30),
      device:      String(err.device      || '').slice(0, 50),
      userId:      err.userId || null,
      userRole:    String(err.userRole || '').slice(0, 30),
      endpoint:    String(err.endpoint || '').slice(0, 200),
      statusCode:  err.statusCode || null,
      ip:          req.ip || '',
    });
  }
  recordError('POST', '/api/admin/client-errors');
  res.json({ ok: true, count: errors.length });
});

// ── Exports ───────────────────────────────────────────────────────
module.exports = {
  requestTimer,
  errorHandler,
  notFoundHandler,
  initProcessHandlers,
  getErrorStats,
  router,
};
