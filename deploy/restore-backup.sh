#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HogaresRD — restore an encrypted PostgreSQL backup
# ═══════════════════════════════════════════════════════════════════
#
# Companion to deploy/db-backup.sh. Decrypts and decompresses an
# AES-256-CBC encrypted backup file and writes the SQL to stdout (so
# you can pipe straight into psql) or to a named file.
#
# Usage:
#   deploy/restore-backup.sh <backup-file.sql.gz.enc>
#       Writes decoded SQL to stdout. Pipe into psql:
#         deploy/restore-backup.sh db-20260501-040000.sql.gz.enc | psql "$DATABASE_URL"
#
#   deploy/restore-backup.sh <backup-file.sql.gz.enc> -o <out.sql>
#       Writes decoded SQL to <out.sql>.
#
#   deploy/restore-backup.sh -h | --help
#       Show this help.
#
# The passphrase is read from $BACKUP_ENCRYPTION_KEY_FILE (default
# /etc/hogaresrd/backup.key), the same location db-backup.sh writes to.

set -euo pipefail

usage() {
  sed -n '2,/^$/p' "$0" | sed 's|^# \?||' | head -n -1
  exit "${1:-0}"
}

if [ $# -eq 0 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage 0
fi

INPUT="$1"
OUTPUT=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-/etc/hogaresrd/backup.key}"

if [ ! -r "$INPUT" ]; then
  echo "ERROR: input file not readable: $INPUT" >&2
  exit 1
fi
if [ ! -r "$KEY_FILE" ]; then
  echo "ERROR: passphrase file not readable: $KEY_FILE" >&2
  echo "Set \$BACKUP_ENCRYPTION_KEY_FILE if the key lives elsewhere." >&2
  exit 1
fi

# Decrypt → gunzip. If the file is the legacy unencrypted .sql.gz format
# (no .enc suffix), skip the openssl stage so older backups still restore
# without juggling two scripts.
if [[ "$INPUT" == *.enc ]]; then
  if [ -n "$OUTPUT" ]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass "file:$KEY_FILE" \
      -in "$INPUT" | gunzip > "$OUTPUT"
  else
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass "file:$KEY_FILE" \
      -in "$INPUT" | gunzip
  fi
else
  echo "Note: input has no .enc suffix, treating as legacy unencrypted backup." >&2
  if [ -n "$OUTPUT" ]; then
    gunzip -c "$INPUT" > "$OUTPUT"
  else
    gunzip -c "$INPUT"
  fi
fi

if [ -n "$OUTPUT" ]; then
  echo "Restored SQL written to: $OUTPUT" >&2
fi
