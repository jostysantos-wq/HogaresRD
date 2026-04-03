#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HogaresRD — Deployment Script (run on the server)
# ═══════════════════════════════════════════════════════════════════
#
# Usage: bash deploy/deploy.sh
# Run this each time you push updates to deploy them.

set -euo pipefail

APP_DIR="/var/www/hogaresrd"
cd "$APP_DIR"

echo "═══ HogaresRD Deploy ═══"
echo ""

# ── 1. Pull latest code ──────────────────────────────────────────
echo "→ Pulling latest code..."
git pull origin main

# ── 2. Install/update dependencies ───────────────────────────────
echo "→ Installing dependencies..."
npm ci --production

# ── 3. Run database migration (if needed) ────────────────────────
if [ ! -f "$APP_DIR/data/hogaresrd.db" ]; then
    echo "→ Running database migration..."
    node scripts/migrate-json-to-sqlite.js
fi

# ── 4. Restart application ───────────────────────────────────────
echo "→ Restarting application..."
pm2 restart hogaresrd

# ── 5. Reload Nginx (in case config changed) ────────────────────
echo "→ Reloading Nginx..."
sudo nginx -t && sudo systemctl reload nginx

# ── 6. Verify ────────────────────────────────────────────────────
sleep 2
pm2 status hogaresrd

echo ""
echo "✅ Deploy complete!"
echo ""
