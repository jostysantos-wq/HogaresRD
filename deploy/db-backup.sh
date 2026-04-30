#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HogaresRD — PostgreSQL daily backup
# ═══════════════════════════════════════════════════════════════════
#
# Run from cron (see deploy/setup-server.sh for the crontab line).
# Reads $DATABASE_URL from the environment — make sure cron has it
# (the install line in setup-server.sh sources /var/www/hogaresrd/.env
# so DATABASE_URL is available).
#
# Output: /var/backups/hogaresrd/db-YYYYMMDD-HHMMSS.sql.gz
# Retention: 14 most recent backups; older ones are pruned.

set -euo pipefail
BACKUP_DIR="/var/backups/hogaresrd"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$BACKUP_DIR/db-$STAMP.sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$FILE"
# Keep last 14 daily backups
ls -1t "$BACKUP_DIR"/db-*.sql.gz | tail -n +15 | xargs -r rm
echo "Backup written: $FILE"
