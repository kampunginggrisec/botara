#!/usr/bin/env bash
# Botara database backup (Fase 3).
#
# Dumps Postgres (from $DATABASE_URL) into ./backups as a gzipped,
# timestamped SQL file and keeps only the newest 14 backups.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/botara ./scripts/backup.sh
#   BACKUP_DIR=/mnt/backups DATABASE_URL=... ./scripts/backup.sh
#
# Cron (daily 02:30, on the app server):
#   30 2 * * * cd /opt/botara && DATABASE_URL=postgres://... ./scripts/backup.sh >> /var/log/botara-backup.log 2>&1
#
# Restore:
#   gunzip -c backups/botara-YYYYMMDD-HHMMSS.sql.gz | psql "$DATABASE_URL"
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP=14
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/botara-$STAMP.sql.gz"

# pg_dump over the URL; gzip on the fly. --no-owner keeps restores portable
# across roles/hosts.
pg_dump --no-owner "$DATABASE_URL" | gzip -9 > "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Rotation: newest $KEEP files survive.
ls -t "$BACKUP_DIR"/botara-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "rotating out: $old"
  rm -f "$old"
done
