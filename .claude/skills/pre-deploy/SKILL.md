---
name: pre-deploy
description: HogaresRD pre-deploy checklist for `./deploy/deploy.sh`. Use this skill whenever the user says "ship it", "deploy", "push to prod", "release", or wants to run the deploy script. Runs through the project-specific gates (npm test, no console.log debt in changed files, no .env staged, version stamp parity, iOS contract intact, AASA file healthy, Stripe price IDs present) before letting the deploy fire. Catches the things rollback can't.
---

# Pre-deploy checklist

The HogaresRD deploy is `./deploy/deploy.sh` — DigitalOcean droplet → Nginx → PM2 → Node on port 3000. The script does zero-downtime + auto-rollback on `/api/health` failure. But rollback can't undo:
- A frontend release that breaks the iOS app's API contract
- An AASA file that breaks universal links
- A Stripe price-ID typo that turns paid users into "no plan"
- A change that breaks Apple receipt verification (subscriptions silently expire)
- A schema migration that ran but isn't reversible

This skill runs the gates that catch those.

## When to fire

The user says one of:
- "ship it" / "deploy" / "let's deploy" / "push to prod" / "release"
- "is this ready to ship"
- "before I run deploy.sh"
- "merge and deploy"

Or you're about to run `./deploy/deploy.sh` and want to be cautious.

## The checklist

Run each step. Report PASS/FAIL with file:line evidence for any FAIL. Don't proceed to deploy on a FAIL — surface it and ask the user to confirm.

### 1. Tests pass

```bash
npm test
```

Last line must be `# pass <N>`. If `# fail` appears anywhere, FAIL. If the tests have been broken on `main` for a while, ask the user — don't silently skip.

### 2. No `console.log` / `debugger` in changed files

```bash
git diff origin/main...HEAD --name-only -- '*.js' '*.html' | xargs grep -nE 'console\.log\(|debugger;' 2>/dev/null
```

Any hit is a FAIL unless it's an existing `console.log` that wasn't introduced by this branch (`git blame` to confirm).

### 3. No secrets staged

```bash
git diff origin/main...HEAD --name-only | grep -E '\.env$|\.env\.|credentials\.json|secrets\.|key\.pem'
```

Any hit is a HARD FAIL. Don't proceed.

### 4. Version stamps agree

The deploy ships a single artifact, but two files declare its version:
- `package.json` `version` field
- `public/home.html` footer (look for "v" + number near the copyright)
- `ios/HogaresRD/Info.plist` `CFBundleShortVersionString` and `CFBundleVersion`

If the iOS Info.plist version is *behind* the web version, the iOS app may hit endpoints that no longer exist. Ask the user if iOS needs a bump too.

### 5. AASA / universal links intact

```bash
test -f public/.well-known/apple-app-site-association && \
  cat public/.well-known/apple-app-site-association | python3 -m json.tool > /dev/null
```

Must exist, must be valid JSON. The file routes universal links to the iOS app — corrupting it kills deep linking.

### 6. Stripe price IDs present

`server.js:checkEnv` warns about missing `STRIPE_BROKER_PRICE_ID`, `STRIPE_INM_PRICE_ID`, `STRIPE_CONSTRUCTORA_PRICE_ID`. In prod, all three MUST be set. Confirm with:

```bash
ssh prod-host 'grep -E "STRIPE_(BROKER|INM|CONSTRUCTORA)_PRICE_ID" /var/www/hogaresrd/.env'
```

If you can't ssh, ask the user to confirm via the DigitalOcean console.

### 7. Critical env vars present

`server.js` hard-fails on boot if these are missing in production:
- `JWT_SECRET`
- `ADMIN_KEY`
- `ENCRYPTION_KEY` (only in `NODE_ENV=production`)

Ask the user: "Confirm `JWT_SECRET`, `ADMIN_KEY`, `ENCRYPTION_KEY` are set in prod `.env`."

### 8. CSP no regressions

```bash
grep -nE "'unsafe-eval'|img-src.*\bhttp:" server.js
```

Must be zero hits. If a new line introduces `unsafe-eval` or `http:` in img-src, FAIL.

### 9. Sanitizer entry points intact

```bash
grep -rnE "POST.*body" routes/ server.js | grep -v sanitize | head
```

For new POST/PUT/PATCH endpoints, confirm they pipe text fields through `utils/sanitize.js`. Skip this check if the diff doesn't add new write endpoints.

### 10. `.well-known/apple-developer-merchantid-domain-association` intact (if present)

If you use Apple Pay / merchant verification, this file is required.

### 11. Git status clean

```bash
git status --short
```

Should be empty. Anything modified-but-not-committed is at risk of being missed by the deploy.

### 12. Branch is up-to-date with origin

```bash
git rev-parse HEAD == git rev-parse origin/main
```

If `HEAD` is behind `origin/main`, pull first. If `HEAD` is ahead, that's the deploy candidate — confirm.

### 13. Schema migration reversibility

If `routes/store-pg.js` or `routes/store-sqlite-backup.js` changed, the diff includes a schema change. Ask the user:
- Is there a forward migration?
- Is there a rollback?
- Has it been tested against a Postgres clone of prod?

If "no" to any, FAIL.

### 14. iOS API contract not broken

If `routes/*.js` shipped a breaking change (removed field, renamed route, changed JSON shape), the iOS app needs to be updated and submitted to the App Store *before* this deploy lands — App Store review takes 1-7 days. Ask the user.

Common breakers:
- Removed a field from `/api/listings/:id` response
- Renamed a query param
- Changed an enum value
- Tightened auth on a route the iOS app polls

### 15. Smoke test: build the iOS app

```bash
cd ios && xcodebuild -project HogaresRD.xcodeproj -scheme HogaresRD -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -2
```

Must end with `** BUILD SUCCEEDED **`. If this fails, the iOS team hasn't picked up the latest API change yet — the web deploy will produce iOS app crashes.

### 16. Confirm with user

Final gate: list everything that changed in this deploy (`git log origin/main..HEAD --oneline`) and ask:

> "Ready to ship the following? Confirm with 'yes deploy':
> - <commit list>
> Affected surfaces: <web pages | iOS API | admin | etc.>
> Rollback if `/api/health` fails: automatic. Manual rollback: `pm2 reload hogaresrd@previous`."

Wait for explicit "yes". Don't proceed on "ok" or silence.

## Output format

Report a checklist with PASS/FAIL/SKIP for each step. Example:

```
Pre-deploy checklist for d9f4e7a..1fe02fd

✅ 1. npm test       — 47 pass, 0 fail
✅ 2. No console.log — clean
✅ 3. No secrets     — clean
⚠️  4. Versions      — iOS at 1.4.0, web at 1.4.1 — confirm iOS doesn't need bump?
✅ 5. AASA           — valid JSON, 412 bytes
✅ 6. Stripe IDs     — all 3 present (verified via ssh)
... etc.

Net: PASS with 1 warning (#4). Ready to ship pending iOS version confirmation.
```

## Don't deploy if

- Any HARD FAIL (#3 secrets, #11 dirty status, schema regression).
- A new POST/PUT/PATCH endpoint without sanitizer.
- `npm test` red.
- iOS smoke build red AND iOS depends on this release.
- User hasn't explicitly confirmed.
