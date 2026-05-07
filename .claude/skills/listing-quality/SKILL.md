---
name: listing-quality
description: Audit recently-approved HogaresRD listings against quality rules. Use this skill whenever the user asks "are there any low-quality listings", "audit the catalog", "what listings need fixing", or as a periodic catalog-health pass. Checks photo count, blueprint presence (for projects), description length, lat/lng coverage, agency contact completeness, price sanity, and feed-image quality. Reports the worst offenders so the admin can request edits before they show up on /comprar.
---

# Listing quality audit

The HogaresRD catalog is the product. A listing without photos, with a 12-word description, or without lat/lng is a dead leaf — buyers bounce, brokers miss inquiries. This skill is the periodic catalog-health pass that finds those listings before they hurt SEO + conversion.

## When to fire

User says one of:
- "audit listings" / "catalog audit" / "listing quality"
- "what listings are low-quality"
- "before next marketing push, what needs cleanup"
- "find listings missing photos"

Or proactively: weekly / monthly catalog health check.

## Quality rules

### Hard requirements (FAIL = should not be visible)

| Rule | Threshold | Source |
|---|---|---|
| Has at least one image | `images.length >= 1` | listing |
| Has a price | `Number(price) > 0` | listing |
| Has lat/lng | `lat && lng && Number.isFinite(parseFloat(lat))` | listing |
| Has city | `city` non-empty | listing |
| Status is `approved` | `status === 'approved'` | listing |
| Has at least one agency or creator_user_id | so leads have somewhere to route | listing.agencies + creator_user_id |

A listing failing any HARD rule should be flagged for admin review and possibly auto-demoted from `approved` until fixed.

### Quality bar (WARN = visible but underperforming)

| Rule | Threshold | Why |
|---|---|---|
| Photo count | `images.length >= 5` | NAR: high-quality photos = 61% more views, 32% faster sale |
| Description length | `description.length >= 100` | Below 100 chars = generic listings, lower CTR |
| Description not all caps | not `description.toUpperCase() === description` | Reads as spam |
| Has at least one tag | `tags.length >= 1` | Helps faceted search match |
| Has feed-image (cropped) | `feed_image` non-empty | Used by iOS feed; without it the cards fall back to generic |
| Bedrooms / bathrooms set | `bedrooms && bathrooms` | Critical filters in `/comprar` |
| Area declared | `area_const || area_land` | Buyers filter by m² |

### Project-specific (when `unit_types` non-empty OR `submission_type === 'new_property'` AND has project fields)

| Rule | Why |
|---|---|
| `construction_company` set | "By <Constructora>" is a trust signal |
| `delivery_date` set | Buyers filter by handover quarter |
| `project_stage` set | Shows where in the build cycle |
| At least 1 blueprint | Projects without floor plans bounce |
| `units_total` and `units_available` consistent | `units_available <= units_total` |

### Sanity checks (FRAUD signal — investigate)

| Rule | Why |
|---|---|
| Price between $5,000 and $50M USD | Outside this range = data-entry error or fraud |
| `area_const < area_land * 50` (sanity) | Catches typo-decimal-place errors |
| All photos same hash / 0-byte / broken | Listing was uploaded without working images |
| Creator role not in {broker, agency, inmobiliaria, constructora, admin} | A buyer/secretary creating listings = misuse |

## How to run

```bash
cd /Users/neverknowsbest/Documents/HogaresRD\ WebPage
node -e "
const store = require('./routes/store');
const listings = store.getListings({}).filter(l => l.status === 'approved');

const findings = [];
for (const l of listings) {
  const issues = [];
  // Hard rules
  if (!Array.isArray(l.images) || l.images.length === 0) issues.push({ s: 'HARD', rule: 'no images' });
  if (!Number(l.price)) issues.push({ s: 'HARD', rule: 'no price' });
  if (!l.lat || !l.lng) issues.push({ s: 'HARD', rule: 'no coords' });
  if (!l.city) issues.push({ s: 'HARD', rule: 'no city' });
  // Quality bar
  if ((l.images || []).length < 5) issues.push({ s: 'WARN', rule: 'photos < 5 (' + (l.images || []).length + ')' });
  if (!l.description || l.description.length < 100) issues.push({ s: 'WARN', rule: 'description < 100 chars' });
  if (l.description && l.description === l.description.toUpperCase() && l.description.length > 30) issues.push({ s: 'WARN', rule: 'description ALL CAPS' });
  if (!l.bedrooms || !l.bathrooms) issues.push({ s: 'WARN', rule: 'no beds/baths' });
  if (!l.area_const && !l.area_land) issues.push({ s: 'WARN', rule: 'no area' });
  if (!l.feed_image) issues.push({ s: 'WARN', rule: 'no feed_image' });
  // Project-specific
  if (l.unit_types && l.unit_types.length > 0) {
    if (!l.construction_company) issues.push({ s: 'WARN', rule: 'project: no constructora' });
    if (!l.delivery_date) issues.push({ s: 'WARN', rule: 'project: no delivery_date' });
    if (!Array.isArray(l.blueprints) || l.blueprints.length === 0) issues.push({ s: 'WARN', rule: 'project: no blueprints' });
    if (Number(l.units_available) > Number(l.units_total)) issues.push({ s: 'HARD', rule: 'units_available > units_total' });
  }
  // Sanity
  const p = Number(l.price);
  if (p > 0 && (p < 5000 || p > 50000000)) issues.push({ s: 'HARD', rule: 'price out of range $' + p });

  if (issues.length) findings.push({ id: l.id, title: (l.title || '').slice(0, 60), city: l.city, issues });
}

console.log('Listings audited:', listings.length);
console.log('Listings with issues:', findings.length);
console.log('Hard fails:', findings.filter(f => f.issues.some(i => i.s === 'HARD')).length);
console.log('');
console.log('Worst 20 (most issues):');
findings.sort((a, b) => b.issues.length - a.issues.length);
findings.slice(0, 20).forEach(f => {
  console.log('---');
  console.log(f.id, '|', f.title, '|', f.city);
  f.issues.forEach(i => console.log('  ', i.s, '-', i.rule));
});
"
```

## Output format

```markdown
# Listing quality audit — YYYY-MM-DD

## Summary
- Approved listings: <N>
- With ≥ 1 issue: <N> (<%>)
- Hard fails: <N>  ← these should be auto-demoted
- Warnings: <N>

## Hard fails (auto-demote candidates)
| ID | Title | City | Reason |
|---|---|---|---|
| EW7498 | Hermosa villa | Las Terrenas | no images, no price |
| ...

## Top 20 lowest-quality (by issue count)
| ID | Title | City | Issues |
|---|---|---|---|
| ZX1234 | Apartamento moderno | Santiago | photos<5, description<100, no feed_image |
| ...

## By rule (most-common issues)
| Rule | Count | Sample IDs |
|---|---|---|
| photos < 5 | 47 | EW74, ZX12, ... |
| no feed_image | 32 | ... |
| description < 100 | 28 | ... |

## Recommendations
1. Auto-demote the <N> hard fails — turn `status` from `approved` back to `pending` and email each broker.
2. Bulk-email the brokers of the WARN cohort with a "improve your listing" guide pointing at <link>.
3. Consider a UI treatment in `/comprar` that down-ranks listings with < 3 photos so quality lifts naturally.
```

## What's NOT in scope

- Image quality (resolution, blur, watermark detection) — would need a vision model. Out of scope for this skill.
- Translation quality — see `i18n-coverage`.
- Spam detection / sentiment — `routes/ai-review.js` already runs an AI pass on submissions.

## How to act on findings

The skill reports. The user decides. Common follow-ups:

1. **Auto-demote hard fails**: write a one-shot script that flips `status` to `pending` and pushes the listing back into the admin queue with a templated `editsReason`.
2. **Email campaign**: `/api/admin/listings/<id>/request-update` already exists for the "ask the broker for an update" flow — wire the output of this skill into a bulk version.
3. **UI down-rank**: change `comprar.html`'s sort to penalize listings with `images.length < 3` by default.

The skill stops at "here are the issues" — implementation is a follow-up the user explicitly asks for.
