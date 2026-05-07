---
name: appstore-submit
description: Pre-submit checklist for HogaresRD iOS App Store releases. Use this skill whenever the user is about to submit a new build to TestFlight, push to App Store review, bump the iOS version, or asks "is this iOS build ready". Walks through privacy manifest, version stamps, screenshots, push cert validity, AASA, debug entitlements, in-app purchase configuration, accessibility checks, and the App Store metadata required for Dominican Republic launch. Catches the kind of one-off oversights that delay App Store review by 1-7 days.
---

# App Store submission checklist

iOS releases for HogaresRD go through Apple's review process. Bundle ID `com.josty.hogaresrd`. Each rejection costs 1-7 days. This skill encodes the project's pre-submit checklist so the same gotchas don't burn cycles.

## When to fire

User says one of:
- "submit to App Store" / "ship to TestFlight"
- "iOS release" / "ship the iOS app"
- "bump the iOS version"
- "is this build ready"
- "App Store rejected my build for X" (then the skill helps debug)

## The checklist

Run each step. Report PASS/FAIL/REVIEW with file:line evidence.

### 1. Build version + build number

`ios/HogaresRD/Info.plist`:
- `CFBundleShortVersionString` (user-facing version, e.g. `1.5.0`) bumped from previous release.
- `CFBundleVersion` (build number, e.g. `42`) bumped — even for the same version, the build number must monotonically increase across all uploads.

```bash
plutil -p ios/HogaresRD/Info.plist | grep -E 'BundleShortVersionString|BundleVersion'
```

If neither bumped, FAIL — App Store Connect rejects duplicate build numbers.

### 2. Web app version parity

If the iOS release depends on a backend change shipped on web, confirm the backend was deployed first:
- `git log origin/main -- routes/` since the last iOS submission.
- iOS release of `1.5.0` should not assume an API field that's only on `main` but not on production.

If web and iOS are out of sync, the iOS app crashes on real users. Coordinate the two deploys.

### 3. Privacy manifest

iOS 17+ requires `PrivacyInfo.xcprivacy`. Check:

```bash
find ios/HogaresRD -name "PrivacyInfo.xcprivacy" -type f
```

The file must declare:
- `NSPrivacyTracking` — `false` if you don't track across other apps; `true` requires App Tracking Transparency prompt.
- `NSPrivacyCollectedDataTypes` — every piece of user data collected (email, phone, address, photos uploaded, payment info, etc.).
- `NSPrivacyAccessedAPITypes` — every Required Reasons API used (UserDefaults, file timestamps, disk space, system boot time).

Missing the manifest = automatic rejection.

### 4. Privacy nutrition labels in App Store Connect

Open App Store Connect → App Privacy. Confirm:
- Each data type collected is declared.
- Each data type's purpose is correct (analytics, app functionality, third-party advertising, product personalization).
- Data linked to the user (email, phone) vs not linked (anonymized analytics) is correctly classified.

The privacy manifest (#3) and the App Store Connect nutrition labels must agree. A discrepancy = rejection.

### 5. Sign-in with Apple

App Store Review Guideline 4.8: any app offering third-party login (Google, Facebook, email/password) MUST also offer Sign in with Apple, with equivalent UX.

Verify in `ios/HogaresRD/Views/AuthView.swift` (or equivalent):
- "Continuar con Apple" button is present.
- Tap leads to native Apple sign-in flow.
- Token is sent to `/api/auth/apple` and verified server-side via `routes/auth.js:verifyAppleToken` (Apple JWKS, RS256).

### 6. In-app purchase config

The app sells subscriptions ($10/$25/mo). For each:
- Product ID matches `PRODUCT_ID_PREFIX` in `routes/apple-receipts.js` (`com.josty.hogaresrd.*`).
- Product is "Ready to Submit" in App Store Connect.
- `Receipt validation` flow in app calls `/api/auth/apple-subscription` which routes to `verifyAppleTransaction` (chain validation against pinned Apple Root CA G3).
- Restore Purchases button works.

Test in TestFlight sandbox with a sandbox tester account — buying in dev should NOT charge a real card.

### 7. App Tracking Transparency (ATT)

If the app does ANY cross-app tracking (e.g., Meta SDK, Google Analytics with IDFA), the ATT prompt must fire BEFORE any tracking. If the app doesn't track, no ATT prompt needed but `NSPrivacyTracking` must be `false`.

```bash
grep -rn "ATTrackingManager\|requestTrackingAuthorization" ios/HogaresRD/
```

### 8. Screenshots

App Store Connect needs screenshots for:
- iPhone 6.7" (e.g., iPhone 15 Pro Max)
- iPhone 6.5" (older)
- iPad 13" (if the app supports iPad)

Each must:
- Show real content (not placeholder Lorem Ipsum).
- Match current UI (after the design audit changes shipped).
- Be in Spanish (es-DO is the primary App Store locale).

Confirm files exist in your local screenshots directory and have been uploaded.

### 9. App description + keywords

App Store Connect → App Information:
- Description in es-DO is current (mentions current features, not removed ones).
- Keywords field uses local terms (e.g., "alquiler" not "rent", "venta" not "sale", "República Dominicana", "DR", "RD", "MIREX").
- "What's New in This Version" describes the actual changes in this build.

### 10. Universal links / AASA

```bash
curl -sI https://hogaresrd.com/.well-known/apple-app-site-association
```

Must return `200 OK` with `Content-Type: application/json`. The JSON payload must:
- Reference the bundle ID `com.josty.hogaresrd` correctly.
- Allow paths the app handles (`/listing/*`, `/r/*`, `/ciudad/*`).

If the AASA file is missing or wrong, universal links don't work and Apple may flag this in review.

### 11. Push notification cert / APNs

If the app uses push (it does — see `routes/push.js`):
- `APNS_KEY_PATH` env var on prod is set.
- The APNs auth key is not expired (they last 1 year).
- The bundle ID in the auth key matches `com.josty.hogaresrd`.

Test: send a push to a known device from a TestFlight build before submitting to review.

### 12. Debug code stripped

```bash
grep -rn "print(" ios/HogaresRD/Views/ | head -10
grep -rn "print(\"DEBUG" ios/HogaresRD/ | head -10
grep -rn "TODO\|FIXME\|XXX" ios/HogaresRD/ | wc -l
```

`print()` calls in shipped Swift end up in the device console — fine for diagnostics, bad if they leak PII. Spot-check that user emails, JWTs, etc. aren't being printed.

### 13. Entitlements + capabilities

`ios/HogaresRD/HogaresRD.entitlements`:
- `com.apple.developer.applesignin` for Sign in with Apple.
- `com.apple.developer.in-app-payments` if Apple Pay (probably not).
- `com.apple.developer.associated-domains` for universal links — must include `applinks:hogaresrd.com`.
- `aps-environment: production` (or `development` for TestFlight).

### 14. Review notes for App Store

App Store Connect → Version Information → Notes for the Reviewer:
- Test account credentials (a real user that the reviewer can sign in with).
- One-line summary of what changed in this build.
- If you ship a feature that requires data (e.g., must have a property listing to test), pre-seed test data in the test account.

Without test credentials, the reviewer often rejects with "could not test the app".

### 15. Smoke test on a real device

Install the build via TestFlight on a physical iPhone (not just simulator). Walk through:
- Sign in (Apple + email)
- Browse listings
- Open a listing detail
- Apply / favorite / share
- Buy a subscription (sandbox)
- Restore purchases
- Push notification (if applicable)
- Universal link (open https://hogaresrd.com/listing/X — should deep-link into the app)

Any crash = block submission until fixed.

### 16. Accessibility quick pass

Open Settings → Accessibility → VoiceOver on iOS. Walk a key flow (sign-in, browse, listing detail). Common iOS a11y bugs:
- Buttons with no `.accessibilityLabel`.
- Decorative images that aren't `.accessibilityHidden(true)`.
- Tab navigation that doesn't announce the current tab.

The guideline 4.0 review can flag missing accessibility but rarely blocks. Still worth doing.

### 17. Last build's rejection reasons

If the previous submission was rejected, the most common HogaresRD-specific reasons:
- 4.8 (Sign in with Apple missing or broken).
- 5.1.1 (Privacy Policy URL missing in App Store Connect).
- 3.1.1 (in-app purchase issues — usually receipt validation).
- 2.1 (broken / crashes — fix and re-test).

Confirm none of those are still open from the last submission.

### 18. App Privacy + Privacy Policy URL

App Store Connect → App Privacy → Privacy Policy URL must be reachable and current:

```bash
curl -sI https://hogaresrd.com/privacidad
```

Must return 200 and the page must mention iOS-specific data handling (camera/photos, push tokens, in-app purchase, location).

## Output format

```
App Store submit checklist for HogaresRD 1.5.0 (build 42):

✅ 1. Version bumped       — 1.4.3 → 1.5.0, build 42
✅ 2. Web parity           — backend already deployed
✅ 3. PrivacyInfo present  — declares 4 collected types
⚠️  4. Nutrition labels    — confirm "Email Address" is marked "linked to user"
✅ 5. Sign in with Apple   — wired
✅ 6. IAP config           — 3 products ready
... etc.

Net: 16/18 PASS, 2 REVIEW. Ready to submit pending review of #4 and #11.
```

## Don't submit if

- Any FAIL on #1, #2, #3, #5, #6, #11, #14.
- Privacy manifest missing or stale.
- Smoke test shows a crash.
- Last submission was rejected for the same reason.
- Backend dependency hasn't deployed yet.
