---
name: data-context
description: HogaresRD-specific schema, role, and routing knowledge. Use this skill whenever the user asks about listings, applications, conversations, tours, leads, users, subscriptions, or anything that touches the data model — even if they don't say "schema". Also use when writing SQL, building admin queries, debugging "why isn't X showing up", or designing new endpoints. Spares Claude from re-grepping `routes/store.js` to reconstruct the same model on every audit.
---

# HogaresRD data context

Authoritative knowledge of the HogaresRD data model, role hierarchy, status enums, and routing rules. Read this skill first whenever a question touches "where does X come from" or "who can see Y".

## Storage layer

- **Local dev / SQLite**: `better-sqlite3` at `/data/hogaresrd.db`. Schema seed in `routes/store-sqlite-backup.js`.
- **Production / Postgres**: connection via `DATABASE_URL`. Pool in `routes/store-pg.js`.
- **In-memory cache**: every store function (`getListings`, `getUsers`, `getApplications`, `getConversations`, `getTours`, `getAllSubmissions`) reads from in-memory Maps populated at boot. Writes invalidate via `_invalidateCache()`. The server runs PM2 fork mode (NOT cluster) so this single in-memory state is safe — never switch to cluster without moving caches to Redis.

`store.withTransaction(fn, client)` is the only way to do multi-write atomic operations on Postgres.

## Core tables

### `submissions` — the unified listings + claims table

A single table holds both **new property listings** and **agency-claim requests**. Discriminator: `submission_type` ∈ `{ new_property, agency_claim }`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | `generateListingId()` — short alphanumeric like `EW7498` |
| `creator_user_id` | string \| null | null for unauthenticated /submit; set for logged-in pro users |
| `submission_type` | enum | `new_property` \| `agency_claim` |
| `claim_listing_id` | string | only for `agency_claim`; the existing listing being claimed |
| `status` | enum | `pending` \| `approved` \| `rejected` \| `edits_requested` |
| `title`, `description`, `type`, `condition`, `price`, `priceMax`, `area_const`, `area_land`, `bedrooms`, `bathrooms`, `parking`, `province`, `city`, `sector`, `address`, `lat`, `lng` | text/numeric | only on `new_property` |
| `images`, `blueprints` | jsonb | array of `{url, label}` objects (or strings, legacy) |
| `amenities`, `tags`, `unit_types`, `agencies` | jsonb | bounded arrays — see write-path caps |
| `construction_company`, `units_total`, `units_available`, `delivery_date`, `project_stage` | text | project-only fields |
| `name`, `email`, `phone`, `role` | text | submitter contact (set on every submission, used by admin to reach the submitter) |
| `feedback_rating`, `feedback_comment` (on tours, not submissions) | numeric/text | tour completion review — feeds `rating_average`/`rating_count` on listings |

Public list endpoint (`GET /api/listings`) returns only `submission_type !== 'agency_claim'` AND `status === 'approved'`.

### `users`

| Field | Notes |
|---|---|
| `id` | UUID-style |
| `role` | `buyer` \| `broker` \| `agency` \| `inmobiliaria` \| `constructora` \| `secretary` \| `admin` |
| `name`, `email`, `phone`, `bio`, `jobTitle`, `avatarUrl` | profile |
| `passwordHash` | bcryptjs cost 12 |
| `tokenVersion` | int — incrementing this revokes ALL prior JWTs for this user |
| `subscriptionStatus` | `none` \| `trial` \| `active` \| `trialing` \| `past_due` \| `canceled` |
| `paywallRequired` | boolean — legacy users get free tier; new users true |
| `loginAttempts`, `loginLockedUntil` | account-lockout state (5 attempts → 15 min lock) |
| `emailVerified`, `emailVerifyToken` | email verification |
| `resetToken` | SHA-256 HASH of the reset token (raw token only in the email link) |
| `inmobiliaria_id` | for brokers/agencies — id of their parent inmobiliaria |
| `favorites`, `likedListings`, `recentlyViewed` | arrays of listing IDs |
| `knownIPs` | array of v2-format IP hashes (`v2:<32 hex chars>`) |

### `applications`

A buyer's interest in a specific listing. Lifecycle: `viewing` → `applying` → `qualified` → `paid` → `completed` (or `rejected` at any point).

| Field | Notes |
|---|---|
| `id` | UUID |
| `listing_id` | reference |
| `client_id` | the buyer |
| `broker_id` | assigned broker (cascade-routed) |
| `inmobiliaria_id` | parent org |
| `status` | enum |
| `documents` | array of `{type, file, state}` — encrypted at rest via `utils/encryption.js` (cedula, monthly_income, employer_name) |
| `payment_plan` | nested `{installments, currency, status}` |
| `commission` | nested `{amount, status, reviewedBy}` |
| `tours` | array of `{id, scheduled_at, status}` (separate `tours` collection too) |
| `events` | timeline of state transitions |

Authorization gate (applications.js:2040-2048): broker, inmobiliaria_id-match, client OR admin. Buyers get a SCRUBBED view via `scrubForBuyer()` (no internal events, no commission, no PII for co-applicants, no file paths).

### `conversations` + `messages`

| Field | Notes |
|---|---|
| `id` | UUID |
| `listing_id` | the listing being discussed |
| `client_id`, `broker_id` | the two parties |
| `status` | `unclaimed` \| `claimed` \| `archived` |

Authorization gate (conversations.js:414-419): broker, client, or admin. Org agents (same `inmobiliaria_id` as the broker) can SEE that an unclaimed conversation exists but cannot read messages.

### `tours`

A scheduled visit. `status`: `pending` → `confirmed` → `completed` (with `feedback_rating`/`feedback_comment`).

### `leads`

Public form submissions from `POST /api/leads`. Sanitized via `utils/sanitize.js` before storage. Cascade-routed to brokers based on the `ref_token` cookie + `isReferrerAffiliatedWithListing()`.

## Role hierarchy

```
admin                  ← can do anything
inmobiliaria           ← owns brokers, owns listings
constructora           ← owns brokers, owns project listings
broker / agency        ← individual agent; may have inmobiliaria_id
secretary              ← scoped to one inmobiliaria, sees apps + conversations
buyer / client / user  ← public-facing; default role on /register-user
```

`ProRoles = ['agency', 'broker', 'inmobiliaria', 'constructora']` — these are the gated subscribers. `requireActiveSubscription` middleware checks `subscriptionStatus ∈ {active, trialing}` OR `(legacyOk && trialActive)`.

## Subscription tiers

| Plan | Price | `STRIPE_*_PRICE_ID` |
|---|---|---|
| Broker | $10/mo | `STRIPE_BROKER_PRICE_ID` |
| Inmobiliaria | $25/mo | `STRIPE_INM_PRICE_ID` |
| Constructora | $25/mo | `STRIPE_CONSTRUCTORA_PRICE_ID` |

App Store IAP handled at `/api/auth/apple-subscription`; receipts verified via `routes/apple-receipts.js` (Apple Root CA G3 pinned).

## Affiliation graph

A user is "affiliated with" a listing if any of:
- `listing.creator_user_id === user.id`
- `listing.inmobiliaria_id === user.id`
- `listing.inmobiliaria_id === user.inmobiliaria_id`
- some `agencies[]` entry has `user_id` matching user OR `email` matching user OR `phone` (last 8 digits) matching user

Rule lives in `isReferrerAffiliatedWithListing()` (routes/applications.js) and is mirrored by the `?affiliated_to=` query in `GET /api/listings`. Both must stay in sync.

## Routing flow for new application/lead

1. `POST /api/applications` or `POST /api/leads` with optional `ref_token` cookie.
2. If `ref_token` resolves to a user AND that user is affiliated with the listing AND role ∈ {agency, broker} → **direct assign**, skip cascade.
3. If affiliated AND role ∈ {inmobiliaria, constructora} → cascade scoped to that org's brokers.
4. Otherwise → normal cascade across the listing's affiliated agents.

This prevents lead theft via generic affiliate links on listings the referrer doesn't own.

## Auth surfaces

- **Cookie auth**: `HttpOnly; Secure (in prod); SameSite=lax`. Cookie name: see `COOKIE_NAME` in routes/auth.js.
- **Bearer**: `Authorization: Bearer <jwt>` header.
- **Query token (GET only)**: `?token=` — accepted as a fallback for native-app SFSafariViewController. Sets `Cache-Control: no-store + Referrer-Policy: no-referrer` on the response and logs `query_token_used`.
- **Email-link tokens**: separate from session JWTs — single-use, short-lived (`/verify-email?token=`, `/unsubscribe?token=`, `/reset-password?token=`).
- **JWT secret rotation**: `JWT_SECRET_PREV` accepted for 14-day grace.

## Common queries (worked examples)

**"How many listings does broker X have?"**
```
const listings = store.getListings({});
const owned = listings.filter(l =>
  l.creator_user_id === userId || (l.agencies || []).some(a => a.user_id === userId)
);
```

**"Show me all pending agency_claim submissions older than 7 days"**
```
const cutoff = Date.now() - 7 * 86400000;
store.getAllSubmissions().filter(s =>
  s.submission_type === 'agency_claim' &&
  s.status === 'pending' &&
  new Date(s.submittedAt).getTime() < cutoff
);
```

**"Which listings have rating_average ≥ 4.5?"**
The list endpoint enriches with `rating_average`/`rating_count` from completed tour feedback. For the ad-hoc lookup, walk `getTours().filter(t => t.feedback_rating)` and group by `listing_id`.

## Don't ask me, just do

- Listing IDs are alphanumeric, server-generated, safe to interpolate as HTML attributes (still escape on output).
- User IDs are UUIDs — assume unguessable, no need to URL-validate.
- All write paths route through `utils/sanitize.js` — never bypass.
- All renders escape via `escapeHtml()` (admin.html, public/js helpers) — never bypass.
- Postgres + SQLite duality means schema changes happen in BOTH `store-pg.js` and `store-sqlite-backup.js`.
