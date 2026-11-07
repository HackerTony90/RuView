# Copy the live floor plan and Observatory patch into a running
# ruvnet/wifi-densepose:v0.8.8-esp32 container. Does not restart it
# and does not read or print an API token.
param(
  [string]$Container = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload = Join-Path $Root "payload"
if (-not (Test-Path (Join-Path $Payload "ui\observatory-live.html"))) {
  throw "payload/ui is missing next to this script."
}

function Find-Container {
  if ($Container) { return $Container }
  $rows = docker ps --format "{{.ID}}`t{{.Image}}`t{{.Names}}"
  $hits = @()
  foreach ($row in $rows) {
    if ($row -match "wifi-densepose:v0\.8\.8-esp32") { $hits += ($row -split "`t")[0] }
  }
  if ($hits.Count -eq 1) { return $hits[0] }
  if ($hits.Count -eq 0) { throw "No running container from ruvnet/wifi-densepose:v0.8.8-esp32. Pass -Container." }
  throw "Several matching containers. Re-run with -Container and one of: $($hits -join ', ')"
}

$id = Find-Container
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $Root "backup-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Set-Content -Path (Join-Path $Root "backup-latest.txt") -Value $backup

function Save-FromContainer($remote, $localName) {
  docker cp "${id}:$remote" (Join-Path $backup $localName)
  if ($LASTEXITCODE -ne 0) { throw "Could not back up $remote" }
}

Save-FromContainer "/app/ui/observatory.html" "observatory.html"
Save-FromContainer "/app/ui/observatory/js/main.js" "main.js"
Save-FromContainer "/app/ui/services/ws-ticket.js" "ws-ticket.js"

function Copy-In($local, $remote) {
  docker cp $local "${id}:$remote"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy $local" }
}

Copy-In (Join-Path $Payload "ui\live-session.mjs") "/app/ui/live-session.mjs"
Copy-In (Join-Path $Payload "ui\observatory-live.html") "/app/ui/observatory-live.html"
Copy-In (Join-Path $Payload "ui\observatory.html") "/app/ui/observatory.html"
Copy-In (Join-Path $Payload "ui\observatory\js\main.js") "/app/ui/observatory/js/main.js"
Copy-In (Join-Path $Payload "ui\observatory\js\live-main.js") "/app/ui/observatory/js/live-main.js"
Copy-In (Join-Path $Payload "ui\services\ws-ticket.js") "/app/ui/services/ws-ticket.js"
docker exec $id mkdir -p /app/ui/floorplan/fixtures
if ($LASTEXITCODE -ne 0) { throw "Could not create /app/ui/floorplan" }
Copy-In (Join-Path $Payload "ui\floorplan\index.html") "/app/ui/floorplan/index.html"
Copy-In (Join-Path $Payload "ui\floorplan\floorplan.css") "/app/ui/floorplan/floorplan.css"
Copy-In (Join-Path $Payload "ui\floorplan\floorplan.mjs") "/app/ui/floorplan/floorplan.mjs"
Copy-In (Join-Path $Payload "ui\floorplan\plan-model.mjs") "/app/ui/floorplan/plan-model.mjs"
Copy-In (Join-Path $Payload "ui\floorplan\live-model.mjs") "/app/ui/floorplan/live-model.mjs"
Copy-In (Join-Path $Payload "ui\floorplan\fixtures\synthetic-apartment.json") "/app/ui/floorplan/fixtures/synthetic-apartment.json"

docker exec $id test -f /app/ui/observatory.html
docker exec $id test -f /app/ui/observatory-live.html
docker exec $id test -f /app/ui/observatory/js/live-main.js
docker exec $id test -f /app/ui/floorplan/index.html
if ($LASTEXITCODE -ne 0) { throw "Container is missing an installed file." }

Write-Output "Installed into $id without a restart."
Write-Output "Open http://127.0.0.1:3000/ui/observatory-live.html"
Write-Output "Open http://127.0.0.1:3000/ui/floorplan/index.html"
Write-Output "Backup: $backup"
