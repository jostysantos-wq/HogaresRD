# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Node --watch (auto-reload)
npm start            # Production server

# Testing
npm test             # Runs tests/api.test.js via Node built-in test runner

# Deployment (from local machine)
./deploy/deploy.sh   # Zero-downtime deploy: pull → npm ci → pm2 reload → health check + rollback

# Mobile (React Native)
cd mobile && npx expo start
eas build --platform ios   # App Store build
```

## Architecture

### Backend (`server.js` + `routes/`)
Express monolith. `server.js` (~3700 lines) bootstraps the app: validates env vars, creates data dirs, seeds demo listings, mounts all routes, and starts cron jobs (newsletters, saved-search alerts). It sends `process.send('ready')` for PM2 graceful reload.

All business logic lives in `routes/` (38 files). Routes are mounted with prefix `/api/<name>` from `server.js`. The largest route files are `applications.js` (~3800 lines), `conversations.js` (~2200 lines), and `auth.js` (~1700 lines).

**Subscription gate:** `requireActiveSubscription` middleware blocks pro endpoints (listings create/edit, applications, conversations, tours, lead-queue, inventory, tasks) for users without active Stripe subscriptions.

### Database (`routes/store.js` + `routes/store-pg.js`)
Dual-mode: SQLite locally (`better-sqlite3`, `/data/hogaresrd.db`), PostgreSQL in production (`pg.Pool` via `DATABASE_URL`). `store.js` (~1700 lines) is the primary interface — it exposes an in-memory cache (Maps) for users, listings, conversations, and applications that is populated at startup and invalidated on writes. Use `withTransaction(fn)` for atomic operations.

**Important:** The server runs in PM2 fork mode (not cluster) specifically because of this in-memory state. Do not switch to cluster mode without first moving rate limiters, OTP state, and caches to Redis or the DB.

### Authentication (`routes/auth.js`)
JWT-based. Tokens are signed with `JWT_SECRET`; `JWT_SECRET_PREV` supports a 14-day rotation grace window. The `userAuth` middleware validates from cookies or `Authorization` header. `optionalAuth` is non-blocking.

Six auth methods: email/password, Apple OAuth, email verification codes, 2FA OTP (Twilio SMS or email), biometric (Face ID/Touch ID), and JWT rotation. Rate limits: 10 login attempts/15 min, 5 password resets/hour.

### Payments (`routes/stripe.js`)
Stripe subscriptions: Broker ($10/mo), Inmobiliaria ($25/mo), Constructora ($25/mo). Webhook at `/api/stripe`. App Store subscriptions handled at `/api/auth/apple-subscription`. The `requireActiveSubscription` middleware checks subscription status from the DB user record.

### Mobile Apps
- **`/mobile/`** — React Native Expo app. Set `API_BASE` in `constants/api.ts` for local dev (`http://192.168.1.XXX:3000/api`) vs production.
- **`/ios/`** — Native Swift/Xcode app. Bundle ID: `com.josty.hogaresrd`. Uses Sign in with Apple (required for App Store compliance).

### Static Frontend (`/public/`)
Vanilla JS + HTML. Translations in `/public/locales/` (Spanish-first / Dominican Spanish, English fallback). Uploaded files land in `/public/uploads/` (photos, blueprints, avatars, ads).

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `JWT_SECRET` / `JWT_SECRET_PREV` | Token signing + rotation |
| `ADMIN_KEY` | Admin panel access |
| `DATABASE_URL` | PostgreSQL connection string |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments |
| `STRIPE_BROKER_PRICE_ID`, `STRIPE_INM_PRICE_ID`, `STRIPE_CONSTRUCTORA_PRICE_ID` | Subscription price IDs (Broker $10, Inmobiliaria/Constructora $25) |
| `EMAIL_USER` / `EMAIL_PASS` | Gmail SMTP (App Password) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push (auto-generated if missing) |
| `TWILIO_*` | SMS 2FA |
| `META_ACCESS_TOKEN` / `META_WEBHOOK_VERIFY_TOKEN` | Facebook Ads webhook |

## Deployment

DigitalOcean Ubuntu droplet → Nginx (reverse proxy, TLS) → PM2 (`hogaresrd` process) → Node on port 3000. PostgreSQL on DigitalOcean Managed DB.

`deploy/setup-server.sh` bootstraps a fresh droplet. `deploy/deploy.sh` does zero-downtime deploys with automatic rollback on failed health check (`/api/health`). Logs: `/var/log/hogaresrd/error.log` and `out.log`.
