---
name: csp-nonce-migration
description: Migrate HogaresRD's CSP from 'unsafe-inline' to nonce-based script + style sources. Use this skill when the user asks to "tighten CSP", "remove unsafe-inline", "add CSP nonces", "harden inline scripts", or wants to close out the M-2 audit follow-up. Walks all inline `<script>` and `<style>` blocks across `public/*.html` (38+ files), generates a per-request nonce middleware in `server.js`, injects `nonce="{{cspNonce}}"`, and removes `'unsafe-inline'` from script-src/style-src. Has a rollback plan in case any inline handler breaks.
---

# CSP nonce migration

The audit (M-2 in the round-1 security review) deferred a full nonce migration because it's a real refactor — there are ~38 HTML files with inline `<script>` blocks plus inline event handlers (`onclick=`, `onchange=`, `onsubmit=`). Removing `'unsafe-inline'` from CSP would break all of them at once.

This skill is the staged migration plan. Run when the user's ready to spend a sprint closing out CSP hardening.

## When to fire

User says:
- "let's finish CSP"
- "tighten CSP" / "remove unsafe-inline"
- "add CSP nonces"
- "harden the inline script policy"
- "close the M-2 follow-up"

Don't fire on a general "audit" — this is a deliberate sprint, not a routine audit fix.

## Why nonces (vs hashes vs strict-dynamic)

- **Hashes** require pre-computing the hash of every inline script — fragile when scripts include dynamic content like timestamps.
- **strict-dynamic** is great but breaks our `<script src="https://js.stripe.com/...">` allowlist pattern — Stripe and Google Tag Manager need to load scripts from their own domain.
- **Nonces** are the right shape: server generates a random nonce per request, stamps it on every legitimate inline `<script nonce="X">`, and CSP rejects anything without that nonce.

## Migration plan (5 phases)

### Phase 1 — Inline event handlers → addEventListener

Inline `onclick=`, `onchange=`, etc. CANNOT use nonces. They must be migrated to `addEventListener` first. The codebase has hundreds of these. Audit:

```bash
grep -rE 'onclick="|onchange="|onsubmit="|onload="|onerror="|onfocus="|onblur="' public/*.html | wc -l
```

Strategy: don't migrate every page at once. Pick one page (e.g., `home.html`), move its inline handlers to a delegated listener pattern in a `<script>` block at the bottom, verify, repeat. Budget: 1 page per hour. 38 pages × 1 hour = 1 sprint.

Lower-risk shortcut: `'unsafe-inline'` for SCRIPT-SRC keeps inline event handlers working, but `'unsafe-inline'` for SCRIPT-SRC ALSO defeats the nonce policy (browsers ignore nonces when `'unsafe-inline'` is present). So you can't half-migrate. The migration is whole-or-nothing for script-src.

**Alternative**: keep `'unsafe-inline'` for `style-src` (event handlers don't appear in style attributes — they appear in CSS via `style="..."`). Sequence:
1. Migrate `<style>` blocks to nonce first (lower risk).
2. Migrate inline event handlers to addEventListener.
3. Migrate `<script>` blocks to nonce.
4. Remove `'unsafe-inline'` from script-src.

### Phase 2 — Add nonce middleware

In `server.js`, before the CSP middleware:

```js
const crypto = require('crypto');

// Audit fix M-2: per-request CSP nonce. The nonce is exposed on
// res.locals so the express-static / template layer can inject it
// into <script nonce="..."> tags. Browsers reject any inline script
// whose nonce doesn't match this header.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});
```

Then update the CSP header to inject the nonce per-request:

```js
app.use((req, res, next) => {
  const nonce = res.locals.cspNonce;
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://js.stripe.com https://checkout.stripe.com https://www.googletagmanager.com https://connect.facebook.net https://*.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://*.openstreetmap.org https://cdn.apple-mapkit.com`,
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com https://*.openstreetmap.org https://cdn.apple-mapkit.com`,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://api.stripe.com https://www.facebook.com https://*.facebook.com https://graph.facebook.com https://*.openstreetmap.org https://nominatim.openstreetmap.org https://*.apple-mapkit.com https://*.ls.apple.com",
    "frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'self'",
    "report-uri /api/csp-report",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
});
```

### Phase 3 — Inject nonce into HTML

Two options:

**Option A: post-process middleware**. Intercept HTML responses and rewrite `<script>` → `<script nonce="...">`:

```js
app.use((req, res, next) => {
  const send = res.send;
  res.send = function(body) {
    if (typeof body === 'string' && res.getHeader('Content-Type')?.includes('text/html')) {
      const nonce = res.locals.cspNonce;
      body = body
        .replace(/<script(\s|>)/g, `<script nonce="${nonce}"$1`)
        .replace(/<style(\s|>)/g, `<style nonce="${nonce}"$1`);
    }
    return send.call(this, body);
  };
  next();
});
```

This is fragile but requires zero changes to `public/*.html`. Risk: rewriting all `<script>` may match scripts that already have a `src=` attribute (those don't need a nonce, but the nonce attribute is harmless on them).

**Option B: explicit template variable**. Add a placeholder like `<!--CSP_NONCE-->` to every HTML file at every `<script>`/`<style>` location and replace it server-side. More work upfront, more controlled.

Recommend Option A — start there, switch to B if the post-process middleware causes problems.

### Phase 4 — Remove inline event handlers

For each page:
1. Find all `onclick=`/`onchange=`/`onsubmit=`/`oninput=`/`onerror=` etc.
2. Move handler bodies to a `<script>` block at the end of the page.
3. Replace inline `onclick="myFn()"` with `<button data-action="myFn">` and a delegated listener:
   ```js
   document.addEventListener('click', e => {
     const action = e.target.closest('[data-action]')?.dataset.action;
     if (action === 'myFn') myFn(e);
   });
   ```

This is the bulk of the work. Each page audit:

```bash
grep -nE 'on(click|change|submit|input|focus|blur|load|error)="' public/<page>.html | wc -l
```

A page with 0 inline handlers is migrated. A page with > 50 needs a careful pass.

### Phase 5 — Drop 'unsafe-inline' and verify

In `server.js` CSP, remove `'unsafe-inline'` from script-src and style-src. Restart. Open every key page in dev tools console — any CSP violation logs to `/api/csp-report` and console.

Pages to spot-check:
- `home.html` (lots of inline)
- `comprar.html` (filter onchange handlers)
- `listing.html` (lightbox inline JS)
- `submit.html` (multi-step form)
- `admin.html` (longest)
- `broker.html` (12K-line dashboard)
- `register-*.html` (form handlers)

Watch for:
- Inline event handlers that didn't get migrated (browser console: "Refused to execute inline event handler...").
- Dynamically generated scripts (`element.innerHTML = '<script>...</script>'`) — these CANNOT have a server-side nonce. Move to addEventListener pattern or explicit script element creation with nonce attribute set.
- iframe / embed third-party scripts — verify they're in the script-src allowlist.

## Rollback plan

If anything breaks in production:

1. Set `CSP_REPORT_ONLY=1` in `.env` and reload PM2 — this flips the header to `Content-Security-Policy-Report-Only`, so violations log but don't block.
2. The `/api/csp-report` endpoint surfaces every violation. Use the logs to find what broke.
3. Fix the offending inline → addEventListener migration.
4. Unset `CSP_REPORT_ONLY` and reload.

## Verification

After migration:

```bash
# Confirm 'unsafe-inline' is gone from script-src
grep -nE "script-src.*'unsafe-inline'" server.js  # should be empty

# Confirm nonce is in script-src
grep -nE "script-src.*'nonce-" server.js  # should match

# Run a smoke test against the live server
curl -sI https://hogaresrd.com/ | grep -i 'content-security-policy'
# Should include: nonce-xxxxx and NOT include 'unsafe-inline' for script-src
```

## Don't do this in one sitting

The migration is a sprint, not an afternoon. Suggest:
- Day 1-2: Phase 1 audit + start migrating top 5 pages' inline handlers.
- Day 3-4: Phases 2 + 3 (middleware + post-process).
- Day 5-7: Migrate remaining pages.
- Day 8: Phase 5 (drop unsafe-inline, run smoke tests in report-only mode for 24h).
- Day 9: Switch to enforcing.
- Day 10: Verify CSP-report logs are clean.

## What this skill does NOT touch

- `'unsafe-eval'` — already removed in audit M-2 (commit b6871c4).
- `img-src http:` — already removed in L-8.
- `frame-ancestors` — already at `'self'`.

The remaining gap is `'unsafe-inline'`. Closing it kills the residual XSS risk that the H-1 / H-2 fixes mitigated but didn't eliminate.
