// Tiny in-process event bus for application state changes.
//
// Publishers call `publish(appId)` whenever an application's state
// changes (save, status change, doc upload, payment upload, etc).
// Subscribers — currently only the SSE endpoint in routes/applications.js
// — register per-application callbacks and receive notifications.
//
// This is deliberately minimal: a single Node process holds all
// subscriptions in memory. If HogaresRD ever scales to multiple
// Node workers this needs to become Redis pub/sub or similar, but
// for now a single PM2 fork is fine.

const EventEmitter = require('events');

// Allow a lot of subscribers — each open broker device counts as one
// listener on the matching app id. A busy inmobiliaria could easily
// have 20–30 concurrent streams.
const bus = new EventEmitter();
bus.setMaxListeners(500);

/**
 * Notify subscribers that an application's state has changed.
 * Callers should pass just the id — subscribers re-query the store
 * for the fresh state to avoid stale object references.
 */
function publish(appId) {
  if (!appId) return;
  // Defer to the next tick so callers that publish mid-save don't
  // block on listeners. This also flattens the stack for any
  // listener that throws.
  setImmediate(() => {
    try { bus.emit(`app:${appId}`); } catch (e) {
      console.error('[app-events] publish error:', e.message);
    }
  });
}

/**
 * Subscribe to updates for a single application.
 * Returns an unsubscribe function the caller MUST invoke on cleanup.
 */
function subscribe(appId, listener) {
  const channel = `app:${appId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}

module.exports = { publish, subscribe };
