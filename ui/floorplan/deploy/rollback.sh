#!/bin/sh
# Restore the backup written by install.sh. Does not restart the container.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BACKUP=$(cat "$ROOT/backup-latest.txt")
[ -f "$BACKUP/main.js" ] || { echo "Backup is incomplete" >&2; exit 1; }
if [ -n "${1:-}" ]; then
  ID=$1
else
  ID=$(docker ps --format '{{.ID}} {{.Image}}' | awk '/wifi-densepose:v0\.8\.8-esp32/ { print $1 }')
fi
docker cp "$BACKUP/observatory.html" "$ID:/app/ui/observatory.html"
docker cp "$BACKUP/main.js" "$ID:/app/ui/observatory/js/main.js"
docker cp "$BACKUP/ws-ticket.js" "$ID:/app/ui/services/ws-ticket.js"
docker exec "$ID" rm -rf /app/ui/floorplan /app/ui/observatory-live.html /app/ui/observatory/js/live-main.js /app/ui/live-session.mjs
docker exec "$ID" test -f /app/ui/observatory.html
echo "Restored Observatory files in $ID. No restart was issued."
