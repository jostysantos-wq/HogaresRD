'use strict';

/**
 * sla-registry.js — shared SLA / age-out check registry.
 *
 * Features (tasks, applications, future) register an SLA-check function
 * here at module load. A single cron job in server.js calls runAll()
 * hourly; each handler scans its own data, emits notifications/audit
 * entries for breaches, and returns the issue count for logging.
 *
 * Why a registry instead of one cron per feature: avoids N concurrent
 * scans, gives operators one log line per run, and lets new features
 * opt in without touching server.js.
 *
 * Handler contract:
 *   register(name: string, fn: () => Promise<number> | number)
 *
 * `fn` should be idempotent within a 24-hour window — store a
 * `last_*_at` field per record and only re-fire when the date changes.
 */

const handlers = [];

function register(name, fn) {
  if (typeof name !== 'string' || !name.trim())
    throw new Error('[sla-registry] name must be a non-empty string');
  if (typeof fn !== 'function')
    throw new Error('[sla-registry] handler must be a function');
  handlers.push({ name, fn });
}

async function runAll() {
  const start = Date.now();
  let totalIssues = 0;
  for (const { name, fn } of handlers) {
    try {
      const issues = (await fn()) || 0;
      totalIssues += issues;
    } catch (err) {
      console.error(`[sla] handler "${name}" failed:`, err && err.message);
    }
  }
  // Single log line per run. Operators tail this instead of N per-feature lines.
  console.log(
    `[sla] run complete: ${totalIssues} issue(s) across ${handlers.length} handler(s) ` +
    `in ${Date.now() - start}ms`
  );
  return totalIssues;
}

function listHandlers() {
  return handlers.map(h => h.name);
}

module.exports = { register, runAll, listHandlers };
