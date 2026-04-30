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

# ── 0. Capture current SHA for rollback ────────────────────────
PREV_SHA=$(git rev-parse HEAD)
echo "→ Current SHA (rollback target): $PREV_SHA"

# ── 1. Stash local data changes ─────────────────────────────────
echo "→ Stashing local changes..."
git stash --include-untracked 2>/dev/null || true

# ── 2. Pull latest code ──────────────────────────────────────────
echo "→ Pulling latest code from $BRANCH..."
git pull --rebase origin "$BRANCH"

# ── 3. Restore stashed changes ──────────────────────────────────
echo "→ Restoring stashed changes..."
if ! git stash list | grep -q .; then
  echo "→ No stash to restore"
else
  git stash pop || { echo "ERROR: stash pop failed (likely conflict). Resolve manually."; exit 1; }
fi

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
STATUS=$(echo "$HEALTH" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(d).status||"FAIL")}catch{process.stdout.write("FAIL")}})' 2>/dev/null || echo "FAIL")

if [ "$STATUS" = "ok" ] || [ "$STATUS" = "warming" ]; then
  echo "✅ Health check passed: $HEALTH"
else
  echo "❌ Health check FAILED: $HEALTH"
  echo "   Rolling back to previous SHA: $PREV_SHA"
  git reset --hard "$PREV_SHA"
  # If the rollback's npm ci itself fails (network blip, registry hiccup),
  # the box is in an in-between state: code is back at $PREV_SHA but
  # node_modules may be partial. Bail with exit 3 so the operator knows
  # the rollback ITSELF broke and the running process is no longer trust-
  # worthy. Manual intervention required.
  if ! npm ci --production; then
    echo "🚨 ERROR: rollback 'npm ci' failed; manual intervention required"
    echo "   The box is at SHA $PREV_SHA but node_modules may be partial."
    echo "   SSH in, fix npm/network, then re-run: cd $APP_DIR && npm ci --production && pm2 reload hogaresrd --update-env"
    exit 3
  fi
  pm2 reload hogaresrd --update-env
  sleep 3
  ROLLBACK_HEALTH=$(curl -sf http://localhost:3000/api/health 2>/dev/null || echo '{"status":"FAIL"}')
  ROLLBACK_STATUS=$(echo "$ROLLBACK_HEALTH" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(d).status||"FAIL")}catch{process.stdout.write("FAIL")}})' 2>/dev/null || echo "FAIL")
  if [ "$ROLLBACK_STATUS" = "ok" ] || [ "$ROLLBACK_STATUS" = "warming" ]; then
    echo "✅ Rollback succeeded — service restored at $PREV_SHA"
    exit 1
  else
    echo "🚨 CRITICAL: rollback ALSO failed health check: $ROLLBACK_HEALTH"
    echo "   Manual intervention required."
    exit 2
  fi
fi

# ── 8. Status ────────────────────────────────────────────────────
pm2 status hogaresrd

echo ""
echo "✅ Deploy complete! (zero-downtime)"
echo ""
