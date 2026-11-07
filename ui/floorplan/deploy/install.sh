#!/bin/sh
# POSIX installer for the same payload as install.ps1. No token is read.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PAYLOAD="$ROOT/payload"
[ -f "$PAYLOAD/ui/observatory-live.html" ] || { echo "payload/ui is missing" >&2; exit 1; }

if [ -n "${1:-}" ]; then
  ID=$1
else
  ID=$(docker ps --format '{{.ID}} {{.Image}}' | awk '/wifi-densepose:v0\.8\.8-esp32/ { print $1 }')
  COUNT=$(printf '%s\n' "$ID" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$COUNT" = "1" ] || { echo "Pass the container id. Matches: ${ID:-none}" >&2; exit 1; }
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$ROOT/backup-$STAMP"
mkdir -p "$BACKUP"
printf '%s\n' "$BACKUP" > "$ROOT/backup-latest.txt"
docker cp "$ID:/app/ui/observatory.html" "$BACKUP/observatory.html"
docker cp "$ID:/app/ui/observatory/js/main.js" "$BACKUP/main.js"
docker cp "$ID:/app/ui/services/ws-ticket.js" "$BACKUP/ws-ticket.js"

copy_in() { docker cp "$1" "$ID:$2"; }
copy_in "$PAYLOAD/ui/live-session.mjs" /app/ui/live-session.mjs
copy_in "$PAYLOAD/ui/observatory-live.html" /app/ui/observatory-live.html
copy_in "$PAYLOAD/ui/observatory.html" /app/ui/observatory.html
copy_in "$PAYLOAD/ui/observatory/js/main.js" /app/ui/observatory/js/main.js
copy_in "$PAYLOAD/ui/observatory/js/live-main.js" /app/ui/observatory/js/live-main.js
copy_in "$PAYLOAD/ui/services/ws-ticket.js" /app/ui/services/ws-ticket.js
docker exec "$ID" mkdir -p /app/ui/floorplan/fixtures
copy_in "$PAYLOAD/ui/floorplan/index.html" /app/ui/floorplan/index.html
copy_in "$PAYLOAD/ui/floorplan/floorplan.css" /app/ui/floorplan/floorplan.css
copy_in "$PAYLOAD/ui/floorplan/floorplan.mjs" /app/ui/floorplan/floorplan.mjs
copy_in "$PAYLOAD/ui/floorplan/plan-model.mjs" /app/ui/floorplan/plan-model.mjs
copy_in "$PAYLOAD/ui/floorplan/live-model.mjs" /app/ui/floorplan/live-model.mjs
copy_in "$PAYLOAD/ui/floorplan/fixtures/synthetic-apartment.json" /app/ui/floorplan/fixtures/synthetic-apartment.json
docker exec "$ID" test -f /app/ui/observatory.html
docker exec "$ID" test -f /app/ui/observatory-live.html
docker exec "$ID" test -f /app/ui/floorplan/index.html
echo "Installed into $ID without a restart."
echo "Open http://127.0.0.1:3000/ui/observatory-live.html"
echo "Open http://127.0.0.1:3000/ui/floorplan/index.html"
