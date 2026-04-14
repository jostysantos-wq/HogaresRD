Before writing any code, perform a thorough context-gathering pass on the HogaresRD project at "/Users/neverknowsbest/Documents/HogaresRD WebPage/".

## Project Overview
HogaresRD is a Dominican Republic real estate platform with three components:
1. **Web app** (Node.js + Express + PostgreSQL) — served from `server.js`, routes in `routes/`, frontend HTML in `public/`
2. **iOS app** (SwiftUI) — located in `ios/HogaresRD/`
3. **Production VPS** — DigitalOcean droplet at `root@157.230.181.84`, path `/var/www/hogaresrd`, managed by PM2

## Context You Must Gather Before Coding

### 1. Session Memory
- Read `/Users/neverknowsbest/.claude/projects/-Users-neverknowsbest-Documents-HogaresRD-WebPage/memory/MEMORY.md` for prior decisions
- Read the most recent plan file in `/Users/neverknowsbest/.claude/plans/` if one exists

### 2. Architecture Files (always read first)
- `server.js` — main Express entry, middleware order, cron jobs, admin routes
- `routes/store.js` — PostgreSQL data layer, caching, CRUD for all entities
- `routes/auth.js` — JWT + 2FA, user roles (user/broker/agency/inmobiliaria/constructora/secretary)
- `ios/HogaresRD/Services/APIService.swift` — all iOS API calls
- `ios/HogaresRD/ContentView.swift` — root tab view and profile menu
- `package.json` — dependencies (jwks-rsa, stripe, multer, sharp, etc.)
- `.env` (local only) — environment variables, NEVER commit or print secrets

### 3. Critical Patterns to Preserve
- **Single-instance PM2 fork** — admin OTP state, rate limiters, and caches are in-memory per-process. Don't introduce cluster mode.
- **Trust proxy is enabled** — `req.protocol` may return `http` behind Nginx; use `BASE_URL` for production URLs
- **MapKit JS token** — origin must match production domain or use `BASE_URL`
- **Gmail API email transport** — requires `GOOGLE_SERVICE_ACCOUNT_KEY` and `GOOGLE_DELEGATED_USER` env vars
- **APNs push** — requires `.p8` key at `APNS_KEY_PATH`, uses sandbox for debug builds (`APNS_PRODUCTION=0`)
- **ResponseCache in APIService** — 60-second TTL for listings; be aware of stale data
- **Cascade engine** — in-memory timers with cron recovery, requires `ENABLE_CASCADE=true`
- **Zero-downtime deploys** — PM2 `reload` (not `restart`) with `wait_ready: true`. New process sends `process.send('ready')` after cache loads. Deploy script: `deploy/deploy.sh`
- **Health check** — `GET /api/health` returns `{ status, uptime, memory, cacheReady, version }`. Placed BEFORE the `/api/*` 404 catch-all in server.js.
- **Mailer logging** — `createTransport()` logs once via `_logged` flag. Don't add duplicate log calls.
- **Push badge counter** — Per-user `_badgeCounts` Map in `push.js` tracks APNs badge numbers. Incremented on each push, reset when iOS calls `POST /api/push/badge-reset` on app active.
- **Conversation unread count** — `/api/conversations/unread` returns NUMBER OF CONVERSATIONS with unread (not total message count). Uses `.filter().length` not `.reduce(sum)`.
- **Conversation access for inmobiliaria** — `isOrgOwner` checks both `effectiveInmId(user)` AND `conv.inmobiliariaId === user.sub` (direct ID match). User may have role `broker` but own org conversations.
- **Application hydration defaults** — `hydrateApplication()` in `store.js` ensures `broker`, `client`, `payment`, `documents_requested`, `documents_uploaded`, `tours`, `timeline_events` are never null.
- **Subscription checks on lead assignment** — `isSubscriptionActive()` is checked before assigning a broker in all paths (direct referral, cascade fallback, non-cascade). Orphaned leads trigger admin email.

### 4. Known Gotchas (from prior sessions)
- iOS `.onAppear` + `.task` + `.onChange` chains cause duplicate loads — don't combine them
- `DispatchQueue.main.asyncAfter` should be replaced with `Task { @MainActor in try? await Task.sleep(...) }`
- `withAnimation(.spring())` is expensive — prefer `.easeInOut(duration: 0.25)`
- `UIImpactFeedbackGenerator` blocks the main thread — avoid on hot paths
- Listing `type` field should be `venta`/`alquiler`/`venta_alquiler`, NOT property types like "Apartamento" (those go in `property_type`)
- Projects are identified by `condition` (En planos, Nueva construcción), not a separate type
- The backend cache invalidates on `saveListing()` — PM2 restart may be needed if direct SQL updates are used
- The iOS `Conversation`, `Listing`, and `User` models have specific required vs optional fields — check before adding new fields server-side
- Production `.env` has fields not in `.env.example` (e.g., `ADMIN_SESSION_SECRET`, `RESEND_API_KEY`) — don't overwrite
- `server.js` route order matters: place new endpoints BEFORE `app.use('/api/*', notFoundHandler)` at the end
- `createTransport()` from `mailer.js` is called by many route files — don't re-declare variable names like `createTransport` or `et` that may already exist at module scope
- `STATUS_FLOW` in `applications.js` defines valid transitions. `STATUS_OWNERSHIP` classifies who can set each status (broker manual vs client_auto vs review_auto). Don't allow manual `PUT /:id/status` for auto-only statuses.
- Payment receipt uploads are guarded — blocked if `verification_status === 'pending'` or `'approved'`
- Document request dedup — can't create duplicate pending requests for same document type
- Email-based client auth on applications only works when `app.client.user_id` is null (anonymous applicants)
- `deleteUserCascade()` anonymizes applications (replaces client PII with "Usuario eliminado") instead of deleting them
- The `_tasks` array in store.js stores non-column fields in `_extra` JSON — `hydrateTask()` merges them back

### 5. Before Modifying Any File
- Use the **Read** tool on the file to see the actual current state
- Use **Grep** to find all call sites of functions you're changing
- Check `git log --oneline -10` to understand recent changes
- If touching a route handler, check how the iOS and web clients call it
- If touching an iOS model, check the exact JSON shape the backend returns

### 6. Deployment Protocol
- **Branching**: `main` = production, `staging` = testing. Feature branches → staging → main.
- Every backend change: commit → push to main → SSH to production → `bash deploy/deploy.sh`
- Deploy script handles: git stash/pull/pop, npm ci, `pm2 reload` (zero-downtime), nginx reload, health check with auto-rollback
- Every iOS change requires rebuilding in Xcode to take effect on the device
- Merge conflicts on `data/security_log.json` should be resolved with `git checkout --theirs`
- Uncommitted production-only files (data/backups/, data/errors.log) should be left alone
- To deploy manually: `ssh root@157.230.181.84 "cd /var/www/hogaresrd && git stash && git pull --rebase origin main && git stash pop; pm2 reload hogaresrd --update-env"`

### 7. Verification Requirements
- For iOS: run `xcodebuild -scheme HogaresRD -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build` and confirm BUILD SUCCEEDED
- For web: test the affected endpoint with curl against production
- For data fixes: verify via the store functions, not direct SQL where possible
- After deploy: `curl -s https://hogaresrd.com/api/health` should return `{"status":"ok"}`

## Key Systems Reference

### Application Status Flow
```
aplicado → en_revision → documentos_requeridos → documentos_enviados → en_aprobacion → reservado → aprobado → pendiente_pago → pago_enviado → pago_aprobado → completado
                      ↘ en_aprobacion (skip docs)                    ↗
Any status → rechazado → aplicado (re-apply)
documentos_insuficientes → documentos_requeridos OR documentos_enviados (re-upload fix)
```

### User Roles
- `user` — regular client/buyer
- `broker` / `agency` — individual agents
- `inmobiliaria` / `constructora` — organizations (can have team members)
- `secretary` — org assistant (inherits org subscription)
- `admin` — full access

### Tab Bar (iOS)
```
0: Inicio (FeedView — TikTok-style reel feed)
1: Explorar (BrowseView — search/filter)
2: Mensajes (ConversationsView — badge shows conversation count with unread)
3: Tareas (TasksView — badge shows actionable task count)
4: Perfil (ProfileView — settings, listings, dashboard)
```

## What NOT to Do
- Don't assume field types — verify with curl + Python/Node JSON inspection
- Don't make parallel Read calls when you don't know file sizes (use Grep first to narrow down)
- Don't write new files when existing patterns can be reused — check `Views/`, `routes/`, `utils/` first
- Don't skip the Plan mode for non-trivial changes — use EnterPlanMode when the change touches 3+ files or multiple systems
- Don't push to production without rebasing first — the production repo often has local uncommitted data/security_log.json changes
- Don't add new `app.get/post/put/delete('/api/...')` routes after the 404 catch-all in server.js — they won't work
- Don't use `pm2 restart` — always use `pm2 reload` for zero-downtime
- Don't modify the `.env` file on production without checking existing values first

## Environment Variables & Credentials

**NEVER commit secrets to git.** The `.env` file is gitignored. To read current values:
- Local: `cat "/Users/neverknowsbest/Documents/HogaresRD WebPage/.env"`
- Production: `ssh root@157.230.181.84 "cat /var/www/hogaresrd/.env"`

### Production .env keys (names only — read the file for values when needed):

| Category | Variables |
|----------|-----------|
| **Core** | `NODE_ENV`, `PORT`, `BASE_URL`, `DATABASE_URL` |
| **Auth** | `JWT_SECRET`, `ADMIN_KEY`, `ADMIN_PATH`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, `ADMIN_EMAIL`, `ENCRYPTION_KEY` |
| **Email (Gmail API)** | `GOOGLE_SERVICE_ACCOUNT_KEY` (path to JSON), `GOOGLE_DELEGATED_USER`, `WS_EMAIL_USER`, `WS_EMAIL_PASS`, `EMAIL_USER`, `EMAIL_PASS` |
| **Email (Resend)** | `RESEND_API_KEY`, `RESEND_FROM` |
| **Push (APNs)** | `APNS_KEY_PATH` (path to .p8), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION` (0=sandbox, 1=prod) |
| **Push (Web)** | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BROKER_PRICE_ID`, `STRIPE_INM_PRICE_ID` |
| **DigitalOcean Spaces (CDN)** | `SPACES_KEY`, `SPACES_SECRET`, `SPACES_REGION`, `SPACES_BUCKET` |
| **AI** | `ANTHROPIC_API_KEY` |
| **Cascade** | `ENABLE_CASCADE` (true/false) |
| **CORS** | `ALLOWED_ORIGINS` (comma-separated) |

### SSH Access
```bash
ssh root@157.230.181.84    # Production VPS
```
App path: `/var/www/hogaresrd`

### Key File Locations (Production)
- APNs key: `/var/www/hogaresrd/apns-key.p8` (also copied to project root as `AuthKey_6Z6K3A269P.p8`)
- Google Service Account: `/var/www/hogaresrd/google-service-account.json`
- CA Certificate (DB SSL): `/var/www/hogaresrd/ca-certificate.crt`
- PM2 config: `/var/www/hogaresrd/ecosystem.config.js`
- Nginx config: `/etc/nginx/sites-available/hogaresrd` (symlinked to sites-enabled)
- Deploy script: `/var/www/hogaresrd/deploy/deploy.sh`

### Database
- **PostgreSQL** hosted on DigitalOcean Managed Database
- Connection string in `DATABASE_URL` env var
- SSL with CA cert at `ca-certificate.crt`
- Local dev cannot connect (IP not whitelisted) — test via SSH or use `store.js` functions

### Apple Developer
- Team ID: `H2F8GB5825`
- Bundle ID: `com.josty.hogaresrd`
- App Store Connect: submit via Xcode Archive → Distribute → App Store Connect

## Your First Response
Summarize what you understood about the project structure, list the files you plan to read for the current task, and ONLY THEN ask for confirmation before coding.
