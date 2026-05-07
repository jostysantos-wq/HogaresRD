---
name: ios-design-contract
description: HogaresRD iOS (SwiftUI) design rules and audit checklist. Use this skill whenever editing or reviewing any Swift file under `/ios/`, when designing a new iOS screen, when running an iOS UI audit, or when the user asks "is this on-brand for the iOS app". Also use proactively when generating new SwiftUI code so the result matches the existing system without re-derivation. Encodes the iOS contract from CLAUDE.md plus every drift pattern caught in 2 prior audits.
---

# HogaresRD iOS design contract

The iOS app follows Apple's *Hierarchy, Harmony, Consistency* framing (iOS 26 / Liquid Glass). Two prior audits surfaced the same drift patterns repeatedly. This skill codifies them so the third audit doesn't find the same things.

## Read first when working in /ios/

When you start work on iOS code, scan the file for the patterns below before adding new code. Most regressions land because the new code is a copy-paste from a screen written before the contract was tightened.

## Visual language

| Surface | Token / value |
|---|---|
| Page background | `Color(.systemBackground)` — never `rdCream`/`rdCreamDeep` on screen surfaces |
| Cards on pages | `Color(.secondarySystemGroupedBackground)`, `cornerRadius: 16` continuous, `1pt stroke at Color.black.opacity(0.08)`, `shadow(black.opacity(0.06), radius: 8, y: 2)`. Use `ProfileSectionCard` to get this for free. |
| Tinted icon tile | `Color(.tertiarySystemFill)` 36×36, `cornerRadius: 10`, foreground accent in row brand color. |
| Brand tint | Active toolbar buttons + primary CTAs default to `Color.rdBlue`. |
| Status colors | `Color.rdRed / rdGreen / rdOrange / rdPurple / rdTeal / rdGold / rdAccent`. ALL are adaptive `UIColor` closures — do NOT use `Color(red:..., green:..., blue:...)` literals (they ignore Dark Mode). |
| Typography | System sans (San Francisco) for everything. `.heroSerif()` ONLY on hero titles (profile name, hero KPIs, large editorial titles). Never on rows, body copy, eyebrow labels, or chips. |

## Motion tokens

Animation values come from `Motion.snappy / arrival / layout / fade` defined in `ios/HogaresRD/Views/DesignSystem.swift`. Do not write `.spring(response:...)` or `.easeInOut(duration:...)` inline. The token table:

| Token | When to use |
|---|---|
| `Motion.snappy` | Button taps, card press, pill toggle |
| `Motion.arrival` | Rows materializing, content arriving from a sheet |
| `Motion.layout` | Segmented swap, filter chip selection, tab content |
| `Motion.fade` | Banners, toasts, hint visibility |

When auditing, grep for `\.spring(response:|\.easeInOut(duration:|\.easeOut(duration:` across `ios/HogaresRD/Views/` — every hit is a drift.

## Empty states

Use `ContentUnavailableView` (iOS 17+) directly, or the `EmptyState.plain(...)` / `EmptyState.actionable(...)` helpers in `DesignSystem.swift`. Custom `VStack` empty states are forbidden. The "Sin X" surfaces should all share the same shape.

When auditing, grep for `VStack.*spacing:.*\n.*Image\(systemName:.*\n.*Text\(.*Sin` — those are the bespoke empty states that need migrating.

## Navigation rule (3 paradigms, 3 jobs)

| Paradigm | Use when | Examples |
|---|---|---|
| `NavigationLink` (push) | Drilling down to a detail of the current context | Listing detail, application detail, conversation thread |
| `.sheet` | Creating, editing, or completing a quick action that returns to the current screen | New listing, edit profile, file a report, plans/subscription |
| `.fullScreenCover` | Hijacking the screen on purpose: deep-link landings, ads, onboarding | Universal-link → listing, full-screen ad popup, auth onboarding |

If a screen breaks the rule, document the why with a code comment.

## Tab bar

The system `TabView` with `.tabItem` + `.badge` is canonical. The iOS 26 Liquid Glass material is automatic. Never re-introduce a custom `FloatingTabBar`.

## Shared components (use these, don't reinvent)

| Component | Where | Use when |
|---|---|---|
| `ProfileBackdrop` | `Views/DesignSystem.swift` | Editorial gradient background for profile/settings screens |
| `ProfileSectionCard` | `Views/DesignSystem.swift` | The card shape with stroke + shadow |
| `ProfileNavRow` | `Views/DesignSystem.swift` | Push-row inside a card |
| `ProfileToggleRow` | `Views/DesignSystem.swift` | Toggle-row inside a card |
| `EmptyState.plain` / `.actionable` | `Views/DesignSystem.swift` | Empty states |
| `BrokerDashSection` enum | `Views/BrokerDashboardView.swift` | Tab enum shared across BrokerDashboardView + InmobiliariaDashboardView |
| `DonutChart` | `Views/BrokerDashboardView.swift` | Pipeline chart, used by Análisis tab |
| `Motion.*` tokens | `Views/DesignSystem.swift` | All animations |

## Audit checklist (run this when reviewing /ios/)

When the user asks "audit this iOS code" or you're reviewing a PR:

1. **Color literals** — `grep -rE 'Color\(red:.*green:.*blue:' ios/HogaresRD/`. Each hit is a Dark Mode regression. Replace with `Color.rd*` token.
2. **Inline motion** — `grep -rE '\.spring\(response:|\.easeInOut\(duration:|\.easeOut\(duration:|\.linear\(duration:' ios/HogaresRD/Views/`. Replace with `Motion.*` token.
3. **`rdCream` on screen surfaces** — `grep -n 'rdCream\|rdCreamDeep' ios/HogaresRD/Views/`. Every hit on a page surface is a drift.
4. **Custom empty states** — search for `VStack.*Image\(systemName:.*\n.*Text.*Sin\|No hay`. Migrate to `EmptyState.*` or `ContentUnavailableView`.
5. **Custom tab bars** — `grep -rn 'FloatingTabBar\|CustomTabBar' ios/HogaresRD/`. Should be zero hits.
6. **`.heroSerif()` misuse** — `grep -rn 'heroSerif' ios/HogaresRD/Views/`. Every hit must be a hero context (profile name, KPI, page title) — not row labels.
7. **Navigation paradigm violations** — sheets used for drill-ins (should be NavigationLink); fullScreenCover used for edit flows (should be .sheet).

When you find a drift, propose the fix in-place rather than just flagging it. The previous two audits had >40 individual fixes; codifying is cheaper than re-discovering.

## Don't redesign — match what's there

When generating new SwiftUI for HogaresRD, scan a sibling screen first:
- Profile / settings flow → match `ProfileView.swift` (uses `ProfileBackdrop`, `ProfileSectionCard`)
- Listing detail-style flows → match `ListingDetailView.swift`
- Dashboard tabs → match `BrokerDashboardView.swift` (uses `BrokerDashSection`)
- List + drill-in → match `ApplicationsView.swift`

Pick the closest existing screen, copy its structure, and only diverge where the new feature genuinely needs it.

## What's already shipped (don't re-flag)

These were caught in rounds 1 and 2 of audits and are now live:
- All `outline: none` issues globally fixed (web; iOS uses `.focusEffectDisabled`).
- Mobile sticky CTA on listing detail (`listing-cta-mobile`-equivalent) lands at `≤768pt`.
- Vecindario section is 2 truthful tiles (Sector / Ciudad), not 4 placeholders.
- `LikesStore` mirrors `SavedStore` (guests can like locally, syncs on login).
- Pipeline donut moved from Inicio to Análisis tab.
- Auditoría tab gating restored on InmobiliariaDashboard.
- `.field-error` adopted across all 6 register/reset forms (web equivalent).

If a new audit lands here re-flagging any of those, push back — they're done.
