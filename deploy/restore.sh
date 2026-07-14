#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PATH:?BACKUP_PATH is required}"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$BACKUP_PATH/postgres.dump"
if [ -n "${OBJECT_DIRECTORY:-}" ] && [ -f "$BACKUP_PATH/objects.tar.gz" ]; then mkdir -p "$OBJECT_DIRECTORY"; tar -C "$OBJECT_DIRECTORY" -xzf "$BACKUP_PATH/objects.tar.gz"; fi
