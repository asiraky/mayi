#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR/$stamp"
pg_dump --format=custom --file="$BACKUP_DIR/$stamp/postgres.dump" "$DATABASE_URL"
if [ -n "${OBJECT_DIRECTORY:-}" ]; then tar -C "$OBJECT_DIRECTORY" -czf "$BACKUP_DIR/$stamp/objects.tar.gz" .; fi
printf '%s\n' "$stamp" > "$BACKUP_DIR/$stamp/recovery-timestamp"
