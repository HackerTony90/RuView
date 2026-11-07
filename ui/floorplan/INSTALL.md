# Install the live floor plan and Observatory patch

Target image: `ruvnet/wifi-densepose:v0.8.8-esp32` (published 2026-08-31, git tag `v0.8.8-esp32`).
The sensing process is not restarted and is not rebuilt. Static files are copied into `/app/ui`, which that image serves from disk.

Unzip this kit at `C:\Users\a_man\Downloads\ruview-kit`. The scripts do not contain a token and do not read `RUVIEW_API_TOKEN`.

## What was wrong in Observatory

Confirmed from the v0.8.8 files in this repo's matching tag, which match the running page:

- `ui/services/ws-ticket.js` reads `localStorage['ruview-api-token']` and, when that key is absent, mints no ticket (`authRequired` stays null).
- `ui/observatory/js/main.js` calls `withWsTicket` and, on any socket close, sets the source to demo and runs `demo-data.js`.
- There is no token field on that page. Settings → Data → Live WebSocket does not survive the close handler, so it is not a way to leave demo.
- `stream.clients` stays 0 while the badge can still say DEMO, which matches a rejected socket that never became a client.

The stock image has no URL that disables that fallback. After this copy, open:

`http://127.0.0.1:3000/ui/observatory-live.html`

That path is new, so the existing service worker does not already have it cached. The page loads `observatory/js/live-main.js`, also new. Demo figures run only for `?demo=1`.

The floor plan is `http://127.0.0.1:3000/ui/floorplan/index.html`.

Both pages send the token only as `Authorization: Bearer` to the same origin. It stays in tab memory unless **Remember in this browser** is checked. A token the dashboard already saved under `ruview-api-token` is used. **Clear** stops this tab from using that saved token and does not delete it, so the dashboard can keep its own copy.

## Install

From the unzipped kit, in PowerShell:

```powershell
cd C:\Users\a_man\Downloads\ruview-kit
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Optional: `-Container <id>` if more than one matching container is running. The script copies files only. It does not restart Docker.

Then open the two URLs above. Enter the token in the page, or choose a local one-line `.txt` file. Do not put the token in the URL.

## Rollback

```powershell
powershell -ExecutionPolicy Bypass -File .\rollback.ps1
```

This restores `observatory.html`, `observatory/js/main.js`, and `services/ws-ticket.js` from the backup the installer wrote, and deletes the added floor-plan and live-observatory files. It does not restart the container.

## Compatibility

- HTTP API on port 3000, same origin. The live socket used here is `ws://<page-host>/ws/sensing` on that same host, which is the URL the v0.8.8 Observatory already built. Port 3001 remains the dedicated socket port; this patch does not point the browser at another host.
- REST reads are `GET /api/v1/nodes`, `/api/v1/sensing/latest`, and `/api/v1/stream/status`.
- A simulated server `source` is labeled synthetic. Missing data stays “no data” or “auth required”.
- Person coordinates and signal-field grids are not drawn. Server presence, motion class, and person-count fields are labeled as server estimates.
- Node markers on the floor plan move only when placed by hand.
- Hard-refresh the old `/ui/observatory.html` once if a previously opened tab still shows DEMO; its HTML may be in the service-worker cache. The new `observatory-live.html` URL does not need that cache cleared.

MIT License. Copyright (c) 2024 rUv. Upstream RuView license applies to these derivative UI files.
