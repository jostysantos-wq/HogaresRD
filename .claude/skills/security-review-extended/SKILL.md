---
name: security-review-extended
description: HogaresRD-aware security review. Use this skill instead of the generic security-review whenever the user asks for a security audit, asks about a vulnerability, ships a PR with auth/admin/upload/redirect changes, or you're reviewing diffs that touch routes/, server.js, public/admin.html, or any sanitizer. Encodes the threat model from 2 prior security audits — anonymous /submit and /api/leads land in admin renders, query-string JWT pattern, sanitizer entry points, etc. Use proactively before merging anything that touches user input.
---

# Security review — HogaresRD edition

This skill replaces the generic `security-review` for HogaresRD work. The codebase has a specific threat model with hot zones the generic checklist misses. Two prior audits found stored XSS, missing sanitization, blue-shadow leaks, etc. — this skill encodes "what we already learned about this codebase" so the third audit isn't a repeat.

## Threat model

The HogaresRD attack surface ranks like this:

1. **Anonymous → admin XSS** (highest impact). Multiple endpoints (`POST /submit`, `POST /api/leads`, `POST /register`) accept unauthenticated input that lands in admin-only render functions in `public/admin.html`. A successful payload runs in admin session context with full admin JWT.
2. **Stored XSS via authenticated edit paths**. Owners can re-submit listings (`PUT /api/listings/:id`), update profiles (`PATCH /api/user/profile`), or edit their own data and bypass the `/submit` sanitizer.
3. **Apple receipt / subscription bypass**. `routes/apple-receipts.js` validates StoreKit 2 JWS — a bug here lets attackers fake an active subscription.
4. **JWT leakage**. Session JWTs in URL query strings (the SFSafariViewController fallback) leak via Referer, logs, browser history.
5. **Account enumeration**. Login responses, password-reset flows, anything that distinguishes "real account" from "no account".
6. **Auth bypass**. Missing `userAuth` middleware, missing role checks, IDOR on `:id` routes.

## What's already protected (don't re-flag)

These were closed in audits commit `b6871c4` and `70934ed`:

- `/submit` text fields go through `utils/sanitize.js` (sanitizeShortText/LongText/Agencies).
- `/api/leads` POST sanitizes name/phone/email/listing_title/agencies + clamps lengths.
- `PUT /api/listings/:id` sanitizes title/description/all short fields/agencies.
- `PATCH /api/user/profile` sanitizes bio/jobTitle/phone.
- `admin.html` agency_claim, new_property, renderAds, renderLeads, renderUsers, leaderboard renderers all use `escapeHtml()` / `esc()` on user data.
- Image src= in admin.html is scheme-gated to `^(https?://|/)` before render.
- Inline JS args use `encodeURIComponent` so single-quote-bearing IDs can't break out.
- Apple Root CA G3 PEM pinned in `routes/apple-receipts.js`. Full chain validation; no string-match-issuer heuristic.
- Login: generic 401 for both unknown email + locked account. Email hashed in `login_failed` log.
- CSP: enforcing, `'unsafe-eval'` removed, `img-src` no longer allows `http:`.
- Rate limiters: `_publicReadLimiter` (120/min) on listings GETs; `_trackReadLimiter` (60/min) on `/track-token`.
- userAuth query-token fallback sets `Cache-Control: no-store + Referrer-Policy: no-referrer` and logs `query_token_used`.

## Where to look — review checklist by file

When reviewing a diff, run through this checklist for any file touched:

### `public/admin.html`

- New `innerHTML = ` template? Every `${userField}` interpolation MUST go through `escapeHtml()` or `esc()`.
- New `<img src="${url}">`? `url` MUST go through scheme-gate `/^(https?:\/\/|\/)/i.test(url)` before render, then `esc()`.
- New `onclick="fn('${id}')"` or any inline-JS arg? Use `encodeURIComponent(id)`.
- `style="${...}"`? Don't interpolate user data into style attributes. Use class names instead.

### `server.js`, `routes/*.js`

- New `POST` / `PUT` / `PATCH` route accepting text? Pipe through `utils/sanitize.js`. Don't reinvent.
- New route reading `req.params.:id`? Verify ownership: `req.user.sub === record.creator_user_id` OR role check OR explicit `isAdmin`.
- New query param read? Validate type, length, allowlist values for enums.
- New external HTTP fetch using `req.body` URL? SSRF risk — block private IPs, allowlist hosts.
- New webhook? Verify signature with `crypto.timingSafeEqual`. Fail closed if secret missing.
- New `res.redirect(...)`? Reject open redirects — interpolate from server-generated paths only, never from `req.query.*` directly.

### `routes/auth.js`

- New auth flow? Use `bcryptjs.compare` (cost 12). Use `crypto.timingSafeEqual` for token comparison.
- New error response on auth failure? Match the existing pattern: generic message, log specifics to `logSec`.
- New JWT sign? Include `sub`, `jti`, `tokenVersion`, role, exp ≤ 14d. Sign with `JWT_SECRET`.
- New cookie? `HttpOnly: true; Secure: IS_PROD; SameSite: 'lax'`. Match `COOKIE_NAME` constant.
- New email logging? Hash via `hashEmail(email)` — never log plaintext addresses.

### `public/css/core.css`

- Don't remove `!important` on `:focus-visible`. Keyboard a11y depends on it.
- Don't reintroduce `unsafe-eval` or `http:` in CSP.

### `routes/apple-receipts.js` and `routes/auth.js apple flow`

- Don't bypass `verifyChain()`. Don't use `jwt.decode()` (no signature check) where `jwt.verify()` is required.
- Don't pin a different cert without explicit reason — Apple Root CA G3 is the trust anchor.

## How to run a full audit

When the user says "do a security review" or "audit this":

1. **Diff scope** — `git diff main` (or compared branch) to find what changed.
2. **For each file**, run the checklist above.
3. **Read every new innerHTML/templated render** — admin.html drift is the #1 historical issue.
4. **Read every new POST/PUT/PATCH** — confirm sanitizer call.
5. **Grep for hot patterns**:
   ```bash
   grep -rE 'innerHTML\s*=' public/admin.html | grep -v 'escapeHtml\|esc('
   grep -rE 'rgba\(0,106,255|rgba\(37,99,235|#006AFF|#0052CC' public/
   grep -rE 'req\.query\.token' routes/ server.js | grep -vE 'rejectQueryToken|track-token'
   grep -rE 'Object\.assign\([^,]+,\s*req\.body' routes/
   grep -rE 'eval\(|new Function\(' public/
   grep -rE 'JSON\.parse\(req\.(body|query)' routes/
   grep -rE 'fs\.(read|write).*req\.(body|query|params)' routes/
   ```
6. **Run any test suite that exists** — `npm test` exercises route handlers.

## Output format

Use the existing audit-report format:

```markdown
# Security audit — round N

## HIGH (immediate)
### H-1. <one-line title> — `file:line`
- Severity: HIGH
- Confidence: <1-10>
- Description: <2-3 lines on what's wrong>
- Exploit scenario: <one-sentence concrete attack>
- Fix: <code-level guidance>

## MEDIUM
...

## LOW
...

## What's solid
| Area | File | Status |
...
```

Keep it under 1500 words. Cite file:line for every claim. Attach 2-5 lines of code as evidence per finding. Do not flag things already in "What's already protected" above without strong new evidence.

## Don't re-discover

When you find an issue, look at `git log -- <file>` to see if it was recently fixed. Two audits already shipped — many "obvious" finds are already closed and you'll waste cycles re-flagging them.

If a new finding lands in this skill (or in code review feedback), update this SKILL.md so it's encoded for the next reviewer.
