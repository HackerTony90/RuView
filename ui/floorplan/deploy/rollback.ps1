# Restore the Observatory files backed up by install.ps1 and remove the
# added floor-plan files. Does not restart the container or touch a token.
param(
  [string]$Container = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pointer = Join-Path $Root "backup-latest.txt"
if (-not (Test-Path $pointer)) { throw "No backup-latest.txt. Nothing to restore." }
$backup = (Get-Content $pointer -Raw).Trim()
if (-not (Test-Path (Join-Path $backup "main.js"))) { throw "Backup $backup is incomplete." }

function Find-Container {
  if ($Container) { return $Container }
  $rows = docker ps --format "{{.ID}}`t{{.Image}}`t{{.Names}}"
  $hits = @()
  foreach ($row in $rows) {
    if ($row -match "wifi-densepose:v0\.8\.8-esp32") { $hits += ($row -split "`t")[0] }
  }
  if ($hits.Count -eq 1) { return $hits[0] }
  if ($hits.Count -eq 0) { throw "No running v0.8.8-esp32 container. Pass -Container." }
  throw "Several matching containers. Re-run with -Container."
}

$id = Find-Container
docker cp (Join-Path $backup "observatory.html") "${id}:/app/ui/observatory.html"
docker cp (Join-Path $backup "main.js") "${id}:/app/ui/observatory/js/main.js"
docker cp (Join-Path $backup "ws-ticket.js") "${id}:/app/ui/services/ws-ticket.js"
if ($LASTEXITCODE -ne 0) { throw "Restore copy failed." }

docker exec $id rm -rf /app/ui/floorplan /app/ui/observatory-live.html /app/ui/observatory/js/live-main.js /app/ui/live-session.mjs
docker exec $id test -f /app/ui/observatory.html
docker exec $id test ! -e /app/ui/floorplan
if ($LASTEXITCODE -ne 0) { throw "Rollback did not leave the original Observatory in place." }
Write-Output "Restored Observatory files in $id and removed the floor plan. No restart was issued."
