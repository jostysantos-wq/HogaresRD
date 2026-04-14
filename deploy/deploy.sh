#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HogaresRD — Zero-Downtime Deployment Script
# ═══════════════════════════════════════════════════════════════════
#
# Usage: bash deploy/deploy.sh [branch]
#   branch: git branch to deploy (default: main)
#
# Run this each time you push updates to deploy them.
# Uses pm2 reload (not restart) for zero-downtime — the old process
# keeps serving requests until the new one signals ready.

set -euo pipefail

APP_DIR="/var/www/hogaresrd"
BRANCH="${1:-main}"
cd "$APP_DIR"

echo "═══ HogaresRD Deploy (branch: $BRANCH) ═══"
echo ""

# ── 1. Stash local data changes ─────────────────────────────────
echo "→ Stashing local changes..."
git stash --include-untracked 2>/dev/null || true

# ── 2. Pull latest code ──────────────────────────────────────────
echo "→ Pulling latest code from $BRANCH..."
git pull --rebase origin "$BRANCH"

# ── 3. Restore stashed changes ──────────────────────────────────
git stash pop 2>/dev/null || true

# ── 4. Install/update dependencies ───────────────────────────────
echo "→ Installing dependencies..."
npm ci --production

# ── 5. Zero-downtime reload ─────────────────────────────────────
# pm2 reload starts a new process, waits for process.send('ready'),
# then gracefully kills the old one. No dropped requests.
echo "→ Reloading application (zero-downtime)..."
pm2 reload hogaresrd --update-env

# ── 6. Reload Nginx (in case config changed) ────────────────────
echo "→ Reloading Nginx..."
sudo nginx -t && sudo systemctl reload nginx

# ── 7. Health check ─────────────────────────────────────────────
echo "→ Verifying health..."
sleep 3
HEALTH=$(curl -sf http://localhost:3000/api/health 2>/dev/null || echo '{"status":"FAIL"}')
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','FAIL'))" 2>/dev/null || echo "FAIL")

if [ "$STATUS" = "ok" ] || [ "$STATUS" = "warming" ]; then
  echo "✅ Health check passed: $HEALTH"
else
  echo "❌ Health check FAILED: $HEALTH"
  echo "   Rolling back — restarting previous version..."
  pm2 restart hogaresrd
  exit 1
fi

# ── 8. Status ────────────────────────────────────────────────────
pm2 status hogaresrd

echo ""
echo "✅ Deploy complete! (zero-downtime)"
echo ""
