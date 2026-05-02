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

function isReferrerAffiliatedWithListing(referrer, listing) {
  if (!referrer || !listing) return false;
  const refInmId = referrer.inmobiliaria_id || null;

  // Creator-based shortcut: covers legacy / admin / imported listings
  // where agencies[] is empty but creator_user_id is populated.
  if (listing.creator_user_id) {
    if (String(listing.creator_user_id) === String(referrer.id)) return true;
    if (refInmId && String(listing.creator_user_id) === String(refInmId)) return true;
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
