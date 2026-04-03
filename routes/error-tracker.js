'use strict';

const fs   = require('fs');
const path = require('path');
const express = require('express');

// ── Config ────────────────────────────────────────────────────────
const LOG_FILE      = path.join(__dirname, '..', 'data', 'errors.log');
const MAX_LOG_LINES = 10_000;
const SLOW_REQ_MS   = 2000;
const TRIM_INTERVAL = 60 * 60 * 1000; // trim log every hour
const STATS_WINDOW  = 24 * 60 * 60 * 1000; // 24 hours

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
function appendLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[error-tracker] Failed to write log:', e.message);
  }
}

function trimLogFile() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      const trimmed = lines.slice(lines.length - MAX_LOG_LINES).join('\n') + '\n';
      fs.writeFileSync(LOG_FILE, trimmed, 'utf8');
      console.log(`[error-tracker] Trimmed log from ${lines.length} to ${MAX_LOG_LINES} lines`);
    }
  } catch (e) {
    console.error('[error-tracker] Failed to trim log:', e.message);
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
function initProcessHandlers() {
  process.on('uncaughtException', (err) => {
    console.error('[error-tracker] Uncaught exception:', err);
    appendLog({
      level: 'fatal',
      type: 'uncaught_exception',
      timestamp: new Date().toISOString(),
      message: err.message || 'Unknown',
      stack: err.stack || null,
    });
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[error-tracker] Unhandled rejection:', err);
    appendLog({
      level: 'fatal',
      type: 'unhandled_rejection',
      timestamp: new Date().toISOString(),
      message: err.message || 'Unknown',
      stack: err.stack || null,
    });
  });

  // Trim log on startup
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

// ── Exports ───────────────────────────────────────────────────────
module.exports = {
  requestTimer,
  errorHandler,
  notFoundHandler,
  initProcessHandlers,
  getErrorStats,
  router,
};
