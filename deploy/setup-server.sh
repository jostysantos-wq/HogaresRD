#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HogaresRD — DigitalOcean Droplet Setup Script
# ═══════════════════════════════════════════════════════════════════
#
# Run this on a fresh Ubuntu 22.04/24.04 Droplet:
#   curl -sSL https://raw.githubusercontent.com/jostysantos-wq/HogaresRD/main/deploy/setup-server.sh | bash
#
# Or copy to the server and run: bash setup-server.sh
#
# What this does:
#   1. Updates the system
#   2. Installs Node.js 20 LTS
#   3. Installs Nginx
#   4. Installs PM2
#   5. Creates the app user and directory
#   6. Clones the repository
#   7. Configures Nginx
#   8. Sets up firewall (UFW)
#   9. Configures PM2 to start on boot

set -euo pipefail

echo "═══════════════════════════════════════════════════"
echo "  HogaresRD Server Setup — DigitalOcean"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. System update ──────────────────────────────────────────────
echo "→ Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Install Node.js 20 LTS ────────────────────────────────────
echo "→ Installing Node.js 20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi
echo "  Node.js $(node -v) installed"

# ── 3. Install Nginx ─────────────────────────────────────────────
echo "→ Installing Nginx..."
apt-get install -y -qq nginx
systemctl enable nginx

# ── 4. Install build essentials (needed for better-sqlite3) ──────
echo "→ Installing build tools for native modules..."
apt-get install -y -qq build-essential python3

# ── 5. Install PM2 globally ──────────────────────────────────────
echo "→ Installing PM2..."
npm install -g pm2

# ── 6. Create app directory ──────────────────────────────────────
echo "→ Setting up application directory..."
APP_DIR="/var/www/hogaresrd"
mkdir -p "$APP_DIR"
mkdir -p /var/log/hogaresrd

# ── 7. Clone the repository ──────────────────────────────────────
echo "→ Cloning repository..."
if [ ! -d "$APP_DIR/.git" ]; then
    git clone https://github.com/jostysantos-wq/HogaresRD.git "$APP_DIR"
else
    echo "  Repository already exists, pulling latest..."
    cd "$APP_DIR" && git pull origin main
fi

# ── 8. Install dependencies ──────────────────────────────────────
echo "→ Installing npm dependencies..."
cd "$APP_DIR"
npm ci --production

# ── 9. Create data directories ───────────────────────────────────
mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/data/documents"
mkdir -p "$APP_DIR/public/uploads/photos"
mkdir -p "$APP_DIR/public/uploads/blueprints"

# ── 10. Create .env template ─────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
    echo "→ Creating .env template..."
    cat > "$APP_DIR/.env" << 'ENVEOF'
# ═══════════════════════════════════════════════════════
# HogaresRD — Production Environment Variables
# ═══════════════════════════════════════════════════════

# Server
NODE_ENV=production
PORT=3000
BASE_URL=https://hogaresrd.com

# Security (CHANGE THESE!)
JWT_SECRET=CHANGE_ME_TO_A_RANDOM_64_CHAR_STRING
ADMIN_KEY=CHANGE_ME_TO_A_SECURE_ADMIN_PASSWORD

# Email (Gmail App Password)
EMAIL_USER=
EMAIL_PASS=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_BROKER_PRICE_ID=
STRIPE_INM_PRICE_ID=

# Anthropic (Claude AI Chat)
ANTHROPIC_API_KEY=

# Meta (Facebook Lead Ads)
META_PIXEL_ID=
META_VERIFY_TOKEN=
META_ACCESS_TOKEN=

# Web Push (auto-generated on first start if empty)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# CORS
ALLOWED_ORIGINS=https://hogaresrd.com,https://www.hogaresrd.com
ENVEOF
    echo ""
    echo "  ⚠️  IMPORTANT: Edit $APP_DIR/.env with your actual secrets!"
    echo ""
fi

# ── 11. Configure Nginx ──────────────────────────────────────────
echo "→ Configuring Nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/hogaresrd

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Enable HogaresRD site
ln -sf /etc/nginx/sites-available/hogaresrd /etc/nginx/sites-enabled/hogaresrd

# Test nginx config
nginx -t

# ── 12. Firewall setup ───────────────────────────────────────────
echo "→ Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "  Firewall enabled: SSH + HTTP/HTTPS allowed"

# ── 13. Start the application ────────────────────────────────────
echo "→ Starting HogaresRD with PM2..."
cd "$APP_DIR"
pm2 start ecosystem.config.js
pm2 save

# ── 14. PM2 startup on boot ──────────────────────────────────────
echo "→ Setting up PM2 to start on boot..."
pm2 startup systemd -u root --hp /root | tail -1 | bash
pm2 save

# ── 15. Reload Nginx ─────────────────────────────────────────────
systemctl reload nginx

# ── 16. Install daily DB backup cron ─────────────────────────────
# Idempotent: only adds the line if it isn't already in the user's
# crontab. Cron does NOT inherit a login shell, so we source .env first
# to make DATABASE_URL available to pg_dump.
echo "→ Installing daily DB backup cron..."
BACKUP_CRON='0 3 * * * set -a; . /var/www/hogaresrd/.env; set +a; /var/www/hogaresrd/deploy/db-backup.sh >> /var/log/hogaresrd/backup.log 2>&1'
if ! (crontab -l 2>/dev/null | grep -Fq '/var/www/hogaresrd/deploy/db-backup.sh'); then
    (crontab -l 2>/dev/null; echo "$BACKUP_CRON") | crontab -
    echo "  Cron installed: pg_dump runs daily at 03:00 UTC"
else
    echo "  Cron already present, skipping"
fi
chmod +x /var/www/hogaresrd/deploy/db-backup.sh || true

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ Setup complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Edit /var/www/hogaresrd/.env with your secrets"
echo "  2. Run: cd /var/www/hogaresrd && pm2 restart hogaresrd"
echo "  3. Point your domain DNS to this server's IP"
echo "  4. Set up Cloudflare (see deploy/DEPLOY.md)"
echo ""
echo "  Useful commands:"
echo "    pm2 status              — Check app status"
echo "    pm2 logs hogaresrd      — View live logs"
echo "    pm2 restart hogaresrd   — Restart the app"
echo "    pm2 monit               — Real-time monitoring"
echo ""
