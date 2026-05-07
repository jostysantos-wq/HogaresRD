---
name: web-design-contract
description: HogaresRD web (vanilla HTML/CSS/JS) design rules and audit checklist. Use this skill whenever editing any file under `/public/`, when reviewing a web PR, when running a web design audit, or when generating new HTML/CSS for the site. Encodes the editorial cream/ink palette, the core.css token system, the global :focus-visible rule, the form-aria pattern, and every drift caught in 2 prior web audits. Use proactively to keep new pages consistent without re-deriving the rules.
---

# HogaresRD web design contract

The public web frontend is vanilla JS + HTML served from `/public/`. All design tokens live in `/public/css/core.css`. Two rounds of design audits encoded the rules below — read them before editing any HTML/CSS/JS.

## Palette and tokens

The site is editorial **cream + ink**, NOT blue-and-white SaaS. This was deliberate — distinguishes us from competitors and matches the iOS app's `rdBlue` only on accent CTAs.

| Token | Light value | Dark value | Use |
|---|---|---|---|
| `--bg` | `#FBF6EE` (cream) | `#15131A` | Page background |
| `--bg-card` | `#FFFFFF` | `#1F1C24` | Card surface |
| `--bg-section` | `#F4F1EA` | `#1A1820` | Section background |
| `--ink` | `#131318` | `#F5F1EA` | Primary text |
| `--ink-soft` | `#36363E` | `#C9C5BC` | Secondary text |
| `--ink-muted` | `#8A8A93` | `#8B867E` | Tertiary text |
| `--accent` | `#131318` (ink) | `#F5F1EA` | Buttons, links — was `#006AFF`, REPOINTED |
| `--red` | `#E53E3E` | `#FC5C5C` | Destructive |
| `--green` | `#00A878` | `#38D996` | Success |

**Do not** introduce hardcoded `#006AFF`, `#0052CC`, `#003D99`, `rgba(0,106,255,...)`, `rgba(37,99,235,...)`. Two audits found these — they are forbidden going forward.

## Typography

System fonts only — `var(--font)` resolves to SF Pro / Segoe UI / Roboto. Zero web fonts loaded. Editorial serif (`var(--font-serif)`) is `ui-serif, 'New York', Charter, Georgia, Cambria` — used on hero titles and section heads, not rows.

## Focus rings (WCAG 2.4.7)

`core.css` ships a global `:focus-visible` rule with `!important`:

```css
:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--ink) !important;
  outline-offset: 2px !important;
  border-radius: 4px;
}
input:focus-visible, select:focus-visible, textarea:focus-visible, .input:focus-visible {
  outline: none !important;
  border-color: var(--ink) !important;
  box-shadow: 0 0 0 3px rgba(19,19,24,0.18) !important;
}
```

Page-level CSS may set `:focus { outline: none }` for pointer focus visuals. The `!important` on `:focus-visible` ensures keyboard focus is always visible regardless. Do not remove the `!important`.

## Component primitives in core.css

| Class | Use | Don't reinvent it page-level |
|---|---|---|
| `.btn` / `.btn-primary` | Default + filled CTA | Inline `<button style=...>` |
| `.btn-secondary` | Outlined CTA | |
| `.btn-ghost` | Minimal "Maybe later" | |
| `.chip` | Filter chip / tag | |
| `.card` | Card surface | |
| `.input` | Form input | |
| `.field-error` | Per-input error span | |
| `.skeleton`, `.skeleton-text`, `.skeleton-card` | Loading state | |
| `.empty-state-v2` | Empty state with CTA | |
| `.mobile-bottom-nav` | iOS-style bottom tab bar | |

Adopt these in any new page — every page that inlines its own button/chip CSS is an ongoing drift cost.

## Reduced motion

`core.css` has a strong `@media (prefers-reduced-motion: reduce)` rule that snaps animation/transition durations site-wide. When adding new animations, don't worry about respecting reduced motion — the global rule handles it. But don't override it locally with `!important`.

## Form aria pattern (every input)

This is the canonical pattern — use it for every new form field:

```html
<div class="field">
  <label for="email">Correo electrónico *</label>
  <input
    type="email"
    id="email"
    name="email"
    required
    aria-required="true"
    autocomplete="email"
    inputmode="email"
    aria-describedby="emailError"
    placeholder="tu@correo.com"
  />
  <span class="field-error" id="emailError" aria-live="polite"></span>
</div>
```

Required attributes for every input:
- `for=` on the `<label>` matching the `id`
- `name=` (server-friendly, also lets browsers autofill)
- `required` + `aria-required="true"` for required fields
- `type=` correct (`email`, `tel`, `url`, `password`, `number`, `text`)
- `inputmode=` for mobile keyboard (`email`, `tel`, `numeric`, `decimal`, `url`)
- `autocomplete=` (`email`, `tel`, `name`, `current-password`, `new-password`, `street-address`, `postal-code`, `cc-number`, etc.)
- `minlength=` / `maxlength=` / `pattern=` where applicable
- `aria-describedby=` pointing to the error span (and any hint text)

Error message containers:
- `<div class="error-msg" id="errorMsg" role="alert" aria-live="polite">` for form-level errors
- `<span class="field-error" id="<field>Error" aria-live="polite">` for per-field

## Image pipeline (LCP discipline)

Every `<img>` tag must include:
- `alt=` with meaningful description (not `alt=""` unless purely decorative)
- `loading=` — `eager` for above-the-fold (first 4 cards, hero), `lazy` otherwise
- `decoding="async"`
- `width=` + `height=` to prevent CLS
- `fetchpriority="high"` on the LCP image; `fetchpriority="low"` on lazy ones

Pattern for card grids (see `comprar.html:buildCard`):
```js
const altText = (l.title || (l.sector || l.city || 'Propiedad') + ' en venta').slice(0, 120);
const isAboveFold = (idx ?? 99) < 4;
const img = firstImg
  ? `<img src="${esc(firstImg)}" alt="${esc(altText)}" width="400" height="300"
        decoding="async"
        ${isAboveFold ? 'loading="eager" fetchpriority="high"' : 'loading="lazy" fetchpriority="low"'}
        onerror="..." />`
  : `<div class="card-img-placeholder">...</div>`;
```

Don't preload all gallery images on listing.html — preload only the first lightbox image and ±1 swipe neighbours on demand.

## Navigation rule

| Page type | Pattern |
|---|---|
| Marketing page (home, about, blog) | Standard top nav via `topnav.js` |
| Search page (comprar, mapa, ciudad) | Filter bar + dual-pane (when applicable) |
| Detail page (listing, post, agency) | Sticky sidebar on desktop, bottom-fixed CTA on mobile (`≤768px`) |
| Auth (login, register-*) | Centered card, no nav |
| Dashboard (broker, admin, inmobiliaria) | App shell — sidebar + topbar |

Never re-introduce the index.html splash/countdown — `index.html` is a 0-second redirect to `/home`.

## CSP

`server.js` ships an enforcing CSP. Keep it that way:
- `script-src 'self' 'unsafe-inline'` — no `unsafe-eval` (audit dropped it).
- `img-src 'self' data: blob: https:` — no `http:`.
- `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`.

When adding a new external script source, list it explicitly in the CSP. Don't add `'unsafe-eval'` back — there's no eval/`new Function()` in the codebase.

## Audit checklist (run when reviewing /public/)

1. **Blue leaks** — `grep -rnE 'rgba\(0,106,255|rgba\(37,99,235|#006AFF|#0052CC|#003D99' public/*.html public/css public/js`. Zero hits expected.
2. **`outline: none` page-level** — fine, the global `:focus-visible !important` wins. No action needed.
3. **Forms missing `for=`** — `grep -nE '<label>' public/register-*.html public/login.html public/reset-password.html`. Bare `<label>` (no `for=`) breaks screen readers.
4. **`<img>` without lazy/dimensions** — `grep -rnE '<img ' public/*.html | grep -vE 'loading=|svg'`. Below-the-fold images need `loading="lazy"` + `width=`/`height=`.
5. **Inline `<button style=>`** — `grep -nE '<button[^>]*style="' public/*.html`. Each is a drift; promote to `.btn`/`.btn-ghost`/`.chip`.
6. **Untranslated literals** — strings like `Próximamente`, `Sin resultados` should come from `/public/locales/es.json` not be hardcoded. See the `i18n-coverage` skill.

## What's already shipped (don't re-flag)

These were caught in rounds 1 and 2 of audits and are now live:
- Global `:focus-visible` ring with `!important`.
- All hardcoded blue rgba shadows replaced (broker.html, comprar.html, listing.html, inmobiliaria.html, submit.html).
- `admin.html` no longer overrides `--accent` to `#006AFF`.
- `submit.html` hero gradient is ink, not blue.
- Mobile sticky CTA bar on `listing.html`.
- Vecindario section is 2 truthful tiles linked to /comprar?q=… and /ciudad/….
- `password-strength.js` extracted as a shared module — used by 5 register pages.
- `.field-error` spans on every input across 6 auth forms.
- Faceted filter counts on `comprar.html` via `/api/listings/facets`.
- index.html is a pure redirect.

If a new audit re-flags any of these, push back — they're done.
