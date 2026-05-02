// ───────────────────────────────────────────────────────────────────────
// Affiliation predicate — shared between routes/applications.js and
// routes/conversations.js so a referring agent's "is on this listing"
// check is identical in every place a lead-routing decision is made.
//
// A referrer is considered AFFILIATED with a listing if any of the
// following match:
//   - They are the listing's creator (creator_user_id === referrer.id),
//     OR the creator is their parent inmobiliaria.
//   - One of the listing's agencies[] entries points at them directly
//     (agency.user_id === referrer.id) or at their parent inmobiliaria
//     (agency.user_id === referrer.inmobiliaria_id).
//   - One of the agencies[] inmobiliaria fields matches the referrer
//     or their parent.
//   - One of the agencies[] entries shares the referrer's email
//     (case-insensitive).
//   - One of the agencies[] entries shares the last 8 digits of the
//     referrer's phone (covers DR vs international formatting).
//
// When TRUE → the referrer can take direct/team-cascade routing.
// When FALSE → the referrer is treated as an "outside" referral,
//              recorded as a fee-payee but not assigned the lead.
// ───────────────────────────────────────────────────────────────────────
'use strict';

// Optional store reference — used to resolve creator's parent
// inmobiliaria. Some callers don't have circular-import access to the
// store (e.g., utility tests), so the require is lazy and guarded.
let _store = null;
function _getStore() {
  if (_store !== null) return _store;
  try { _store = require('../routes/store'); } catch { _store = false; }
  return _store || null;
}

function isReferrerAffiliatedWithListing(referrer, listing) {
  if (!referrer || !listing) return false;
  const refInmId = referrer.inmobiliaria_id || null;

  // Creator-based shortcut: covers legacy / admin / imported listings
  // where agencies[] is empty but creator_user_id is populated.
  if (listing.creator_user_id) {
    if (String(listing.creator_user_id) === String(referrer.id)) return true;
    if (refInmId && String(listing.creator_user_id) === String(refInmId)) return true;
    // Creator is a sub-broker on the referrer's org — referrer is the
    // parent inmobiliaria of the listing's creator. Without this lookup,
    // a parent inmobiliaria's own affiliate link gets downgraded to
    // "outside referrer" on team-created listings whose agencies[] was
    // submitted without an `inmobiliaria` field stamped.
    const store = _getStore();
    if (store) {
      try {
        const creator = store.getUserById(listing.creator_user_id);
        if (creator?.inmobiliaria_id) {
          if (String(creator.inmobiliaria_id) === String(referrer.id)) return true;
          if (refInmId && String(creator.inmobiliaria_id) === String(refInmId)) return true;
        }
      } catch (_) { /* store unavailable — fall through */ }
    }
  }

  const agencies = Array.isArray(listing.agencies) ? listing.agencies : [];
  if (agencies.length === 0) return false;

  const refEmail     = (referrer.email || '').toLowerCase();
  const refPhoneTail = String(referrer.phone || '').replace(/\D/g, '').slice(-8);

  for (const a of agencies) {
    if (!a) continue;
    if (a.user_id && (String(a.user_id) === String(referrer.id) || (refInmId && String(a.user_id) === String(refInmId)))) return true;
    if (a.inmobiliaria && (String(a.inmobiliaria) === String(referrer.id) || (refInmId && String(a.inmobiliaria) === String(refInmId)))) return true;
    if (a.email && refEmail && String(a.email).toLowerCase() === refEmail) return true;
    if (refPhoneTail && refPhoneTail.length >= 8) {
      const tail = String(a.phone || '').replace(/\D/g, '').slice(-8);
      if (tail.length >= 8 && tail === refPhoneTail) return true;
    }
  }
  return false;
}

module.exports = { isReferrerAffiliatedWithListing };
