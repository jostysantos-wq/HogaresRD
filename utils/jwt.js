'use strict';

/**
 * utils/jwt.js — Shared JWT helpers
 *
 * `verifyJwtAcceptingPrev` is the rotation-aware verifier used by the
 * few code paths that call `jwt.verify` directly outside of
 * routes/auth.js's `userAuth` / `verifyJWT` (which already handles
 * rotation natively). Tries the current `JWT_SECRET` first; on failure
 * AND when `JWT_SECRET_PREV` is configured, retries against the previous
 * secret. Re-throws the original error if neither verifies.
 *
 * Use cases (search the codebase for call sites):
 *   - routes/applications.js: track-token verification, withdraw magic
 *     link, track-upload bearer
 *   - routes/inventory.js: optional auth helper
 *
 * Hoisted to a shared util so a fix to rotation logic lands everywhere
 * at once instead of three copies drifting.
 */

const jwt = require('jsonwebtoken');

function verifyJwtAcceptingPrev(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (process.env.JWT_SECRET_PREV) {
      try { return jwt.verify(token, process.env.JWT_SECRET_PREV); } catch (_) { /* fall through */ }
    }
    throw err;
  }
}

module.exports = { verifyJwtAcceptingPrev };
