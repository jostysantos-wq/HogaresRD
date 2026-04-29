/**
 * ai-review.js — Claude-powered listing review
 *
 * Performs automatic quality checks on submitted listings:
 *   1. Content quality (title, description, completeness)
 *   2. Duplicate detection (similar existing listings)
 *   3. Pricing sanity (outliers for the area)
 *   4. Spam / red-flag detection
 *   5. Improvement suggestions
 *
 * Called automatically on new submissions (fire-and-forget) and
 * results are stored on the listing for admin review.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const store     = require('./store');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

/**
 * Run AI review on a listing submission. Fire-and-forget — stores
 * the result on listing.aiReview. Never throws (logs errors).
 */
async function reviewListing(listingId) {
  if (!anthropic) {
    console.warn('[ai-review] ANTHROPIC_API_KEY not set — skipping review');
    return;
  }

  const listing = store.getListingById(listingId);
  if (!listing || listing.submission_type === 'agency_claim') return;

  // Find potential duplicates by matching title keywords + same city
  const allListings = store.getListings({});
  const duplicateCandidates = allListings
    .filter(l => l.id !== listingId && l.status === 'approved')
    .filter(l => {
      // Same city check
      if (listing.city && l.city && listing.city.toLowerCase() === l.city.toLowerCase()) {
        // Similar price (within 20%)
        const p1 = Number(listing.price) || 0;
        const p2 = Number(l.price) || 0;
        if (p1 > 0 && p2 > 0 && Math.abs(p1 - p2) / Math.max(p1, p2) < 0.2) return true;
        // Similar title (3+ word overlap)
        const words1 = new Set((listing.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const words2 = new Set((l.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let overlap = 0;
        for (const w of words1) { if (words2.has(w)) overlap++; }
        if (overlap >= 3) return true;
      }
      return false;
    })
    .slice(0, 5)
    .map(l => ({ id: l.id, title: l.title, price: l.price, city: l.city, bedrooms: l.bedrooms, bathrooms: l.bathrooms }));

  const prompt = buildPrompt(listing, duplicateCandidates);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: 'You are a real estate listing quality reviewer for HogaresRD, a Dominican Republic real estate platform. Review listing submissions and return a JSON object with your assessment. Return ONLY valid JSON — no markdown, no explanation outside JSON.\n\nJSON shape:\n{"score":<1-10>,"status":"<approve|review|reject>","summary":"<1-2 sentences in Spanish>","issues":[{"type":"<missing_info|quality|duplicate|pricing|spam|photos>","severity":"<high|medium|low>","message":"<Spanish>"}],"suggestions":["<Spanish>"],"duplicateRisk":<true|false>,"duplicateIds":["<id>"]}\n\nScoring: 8-10 approve, 5-7 review, 1-4 reject. Write all user-facing text in Spanish.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '{}';
    let review;
    try {
      // Tolerate markdown fencing — extract the first JSON object.
      const match = text.match(/\{[\s\S]*\}/);
      review = match ? JSON.parse(match[0]) : { raw: text };
    } catch {
      review = { raw: text };
    }

    review.reviewedAt = new Date().toISOString();
    review.model = 'claude-haiku-4-5';

    // Save to listing
    listing.aiReview = review;
    store.saveListing(listing);

    console.log(`[ai-review] Listing ${listingId}: score=${review.score || '?'}, issues=${(review.issues || []).length}`);
  } catch (err) {
    console.error('[ai-review] Claude API error:', err.message);
    listing.aiReview = {
      error: err.message,
      reviewedAt: new Date().toISOString(),
    };
    store.saveListing(listing);
  }
}

function buildPrompt(listing, duplicates) {
  const dupSection = duplicates.length > 0
    ? `\nPOSSIBLE DUPLICATES:\n${JSON.stringify(duplicates, null, 2)}`
    : '\nNo potential duplicates found.';

  return `LISTING TO REVIEW:
- Title: ${listing.title || '(empty)'}
- Type: ${listing.type || '(empty)'}
- Condition: ${listing.condition || '(empty)'}
- Price: ${listing.price || '(empty)'}
- Description: ${(listing.description || '(empty)').slice(0, 500)}
- Location: ${[listing.sector, listing.city, listing.province].filter(Boolean).join(', ') || '(empty)'}
- Bedrooms: ${listing.bedrooms || '(empty)'} | Bathrooms: ${listing.bathrooms || '(empty)'}
- Area: ${listing.area_const || '(empty)'} m² built | ${listing.area_land || '(empty)'} m² land
- Parking: ${listing.parking || '(empty)'}
- Images: ${(listing.images || []).length} photo(s)
- Amenities: ${(listing.amenities || []).join(', ') || '(none)'}
- Submitter: ${listing.name || '(empty)'} (${listing.email || 'no email'})
${dupSection}`;
}

module.exports = { reviewListing };
