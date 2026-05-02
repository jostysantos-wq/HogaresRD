#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HogaresRD — PostgreSQL daily backup (encrypted at rest)
# ═══════════════════════════════════════════════════════════════════
#
# Run from cron (see deploy/setup-server.sh for the crontab line).
# Reads $DATABASE_URL from the environment — make sure cron has it
# (the install line in setup-server.sh sources /var/www/hogaresrd/.env
# so DATABASE_URL is available).
#
# Output: /var/backups/hogaresrd/db-YYYYMMDD-HHMMSS.sql.gz.enc
# Cipher: AES-256-CBC with PBKDF2 key derivation (100k iterations).
# Retention: 14 most recent encrypted backups; older ones are pruned.
#
# ── Passphrase setup (one-time, on first deploy) ─────────────────────
# Encrypted backups need a passphrase that lives OUTSIDE /var/www so a
# single-bucket compromise of the app directory doesn't hand the attacker
# both the encrypted dump and its key. The default location is
# /etc/hogaresrd/backup.key (mode 0400, owned by the cron user).
#
# To create it on a fresh server:
#
#   sudo install -d -m 0700 /etc/hogaresrd
#   sudo install -m 0400 /dev/null /etc/hogaresrd/backup.key
#   openssl rand -base64 48 | sudo tee /etc/hogaresrd/backup.key > /dev/null
#   sudo chmod 0400 /etc/hogaresrd/backup.key
#
# Then store a copy of /etc/hogaresrd/backup.key OFF-SERVER (1Password,
# AWS Secrets Manager, an offline vault — anywhere the production droplet
# itself can't reach). Losing this file means losing every backup that's
# been written with it. Rotating it requires re-encrypting (or letting
# old backups age out of the 14-day window).
#
# Override the path with $BACKUP_ENCRYPTION_KEY_FILE if you want a
# different location (e.g. a mounted secrets volume).
#
# ── Restore ──────────────────────────────────────────────────────────
# See deploy/restore-backup.sh.

set -euo pipefail
BACKUP_DIR="/var/backups/hogaresrd"
KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-/etc/hogaresrd/backup.key}"

if [ ! -r "$KEY_FILE" ]; then
  cat >&2 <<EOF
ERROR: backup encryption key not found or unreadable at $KEY_FILE.
Backups are encrypted at rest; refusing to write a plaintext dump.

To bootstrap, run as root:

  install -d -m 0700 /etc/hogaresrd
  install -m 0400 /dev/null /etc/hogaresrd/backup.key
  openssl rand -base64 48 | tee /etc/hogaresrd/backup.key > /dev/null
  chmod 0400 /etc/hogaresrd/backup.key

Then store a copy of the key OFF-SERVER. See the header comment of this
script for details.
EOF
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$BACKUP_DIR/db-$STAMP.sql.gz.enc"

# Pipe pg_dump → gzip → openssl. Each stage's failure propagates because
# of `set -o pipefail`. The `-salt` flag (default in `enc`) randomises
# the per-file salt, so identical DB content does not produce identical
# ciphertext — important if backup files are ever stored on a system
# that does block-level deduplication.
pg_dump "$DATABASE_URL" \
  | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -pass "file:$KEY_FILE" \
    -out "$FILE"

# Roundtrip verify: a corrupted / unreadable backup is worse than no
# backup, so confirm the file decrypts cleanly before we prune anything.
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass "file:$KEY_FILE" \
       -in "$FILE" -out /dev/null 2>/dev/null; then
  echo "ERROR: just-written backup failed roundtrip decryption: $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

# Keep the last 14 backups. Match BOTH the legacy .sql.gz layout and the
# new .sql.gz.enc layout so existing unencrypted backups age out naturally
# during the transition window — once they're gone the glob is .sql.gz.enc
# only.
ls -1t "$BACKUP_DIR"/db-*.sql.gz "$BACKUP_DIR"/db-*.sql.gz.enc 2>/dev/null \
  | tail -n +15 | xargs -r rm

SIZE=$(stat -c %s "$FILE" 2>/dev/null || stat -f %z "$FILE" 2>/dev/null || echo "?")
echo "Backup written: $FILE (${SIZE} bytes, AES-256-CBC + PBKDF2)"
