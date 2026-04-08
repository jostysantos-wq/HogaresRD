#!/bin/bash
# Pull latest backup from production to local machine
REMOTE="root@157.230.181.84"
REMOTE_DIR="/var/www/hogaresrd/data/backups"
LOCAL_DIR="$(dirname "$0")/../data/backups"

mkdir -p "$LOCAL_DIR"

echo "Pulling latest backups from production..."
scp "$REMOTE:$REMOTE_DIR"/hogaresrd_*.db.gz "$LOCAL_DIR/" 2>/dev/null
scp "$REMOTE:$REMOTE_DIR"/json_*.tar.gz "$LOCAL_DIR/" 2>/dev/null

echo "Local backups:"
ls -lh "$LOCAL_DIR"/*.gz 2>/dev/null | tail -5
echo "Done."
