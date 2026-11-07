/**
 * Same-origin sensing auth for Observatory and the floor plan.
 *
 * The token stays in tab memory unless the operator explicitly asks to
 * remember it. An existing `ruview-api-token` localStorage value (the
 * dashboard's key) is honored and is never written by this module unless
 * that opt-in is used. The token is never placed in a URL.
 *
 * MIT License. Copyright (c) 2024 rUv.
 */

export const STORED_TOKEN_KEY = 'ruview-api-token';

let memoryToken = null;
let ignoreStored = false;

export function resetLiveSession() {
  memoryToken = null;
  ignoreStored = false;
}

/** In-memory token for this tab. Does not write storage. */
export function setMemoryToken(token) {
  const cleaned = cleanToken(token);
  memoryToken = cleaned || null;
  return memoryToken;
}

export function clearMemoryToken() {
  memoryToken = null;
}

/**
 * Explicit opt-in persistence, compatible with the dashboard key.
 * Call only from a checked "remember" control.
 */
export function rememberToken(token, storage = defaultStorage()) {
  const cleaned = cleanToken(token);
  if (!cleaned) return null;
  memoryToken = cleaned;
  ignoreStored = false;
  storage?.setItem(STORED_TOKEN_KEY, cleaned);
  return cleaned;
}

export function forgetStoredToken(storage = defaultStorage()) {
  try { storage?.removeItem(STORED_TOKEN_KEY); } catch { /* storage blocked */ }
}

export function ignoreStoredToken() {
  ignoreStored = true;
  memoryToken = null;
}

export function tokenSource(storage = defaultStorage()) {
  if (memoryToken) return 'memory';
  if (!ignoreStored && readStored(storage)) return 'stored';
  return 'none';
}

export function getToken(storage = defaultStorage()) {
  if (memoryToken) return memoryToken;
  if (ignoreStored) return null;
  return readStored(storage);
}

export function parseTokenText(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { ok: false, error: 'The file is empty.' };
  if (raw.startsWith('{') || raw.startsWith('[')) {
    return {
      ok: false,
      error: 'That file is JSON, not a token. Load a floor plan with the plan control.',
    };
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    return { ok: false, error: 'A token file should contain exactly one line.' };
  }
  const token = cleanToken(lines[0]);
  if (!token || /\s/.test(token) || token.length > 512) {
    return { ok: false, error: 'That line does not look like a token.' };
  }
  return { ok: true, token };
}

export function demoOptIn(search = '') {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get('demo') === '1';
}

/**
 * Observatory frame policy. Demo geometry runs only when the page URL
 * explicitly asks for it. Live frames never become measured person locations.
 */
export function selectObservatoryFrame({ demoRequested, liveFrame, link }) {
  if (demoRequested) {
    return {
      mode: 'demo',
      useDemoGenerator: true,
      drawFigures: true,
      drawSignalField: true,
      hud: 'demo',
      figuresAreMeasuredLocations: false,
    };
  }
  if (link === 'auth-required') {
    return quiet('auth-required');
  }
  if (link === 'offline') {
    return quiet('offline');
  }
  if (link === 'live' && !liveFrame) {
    return {
      mode: 'live',
      useDemoGenerator: false,
      drawFigures: false,
      drawSignalField: false,
      hud: 'quiet',
      figuresAreMeasuredLocations: false,
      serverFrame: null,
    };
  }
  if (liveFrame && typeof liveFrame === 'object') {
    return {
      mode: 'live',
      useDemoGenerator: false,
      drawFigures: false,
      drawSignalField: false,
      hud: 'server',
      figuresAreMeasuredLocations: false,
      serverFrame: liveFrame,
    };
  }
  return quiet('no-data');
}

function quiet(mode) {
  return {
    mode,
    useDemoGenerator: false,
    drawFigures: false,
    drawSignalField: false,
    hud: 'quiet',
    figuresAreMeasuredLocations: false,
    serverFrame: null,
  };
}

/**
 * Fields safe to show as server-wide estimates. Person positions and the
 * signal-field grid are omitted so they cannot be drawn as a location.
 */
export function serverEstimateView(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const classification = frame.classification && typeof frame.classification === 'object'
    ? {
        motion_level: textOrNull(frame.classification.motion_level),
        presence: frame.classification.presence === true,
        confidence: numberOrNull(frame.classification.confidence),
      }
    : null;
  return {
    source: textOrNull(frame.source),
    classification,
    estimatedPersons: numberOrNull(frame.estimated_persons),
    features: frame.features && typeof frame.features === 'object'
      ? {
          mean_rssi: numberOrNull(frame.features.mean_rssi),
          variance: numberOrNull(frame.features.variance),
          motion_band_power: numberOrNull(frame.features.motion_band_power),
        }
      : null,
    vitalSigns: frame.vital_signs && typeof frame.vital_signs === 'object'
      ? {
          heart_rate_bpm: numberOrNull(frame.vital_signs.heart_rate_bpm ?? frame.vital_signs.heart_bpm),
          breathing_rate_bpm: numberOrNull(frame.vital_signs.breathing_rate_bpm ?? frame.vital_signs.breathing_bpm),
        }
      : null,
  };
}

export function sameOriginSensingWs(locationLike) {
  if (!locationLike || locationLike.protocol === 'file:') return null;
  const proto = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!locationLike.host) return null;
  return `${proto}//${locationLike.host}/ws/sensing`;
}

export function isSameOriginSensingWs(url, locationLike) {
  if (!locationLike || !url) return false;
  try {
    const target = new URL(url);
    const page = new URL(locationLike.href || `${locationLike.protocol}//${locationLike.host}/`);
    const expectProto = page.protocol === 'https:' ? 'wss:' : 'ws:';
    return target.protocol === expectProto
      && target.host === page.host
      && target.pathname === '/ws/sensing';
  } catch {
    return false;
  }
}

/**
 * Mint a single-use ticket on the page origin. `fetchImpl` is injectable
 * for tests. No other host is contacted.
 */
export async function prepareSameOriginTicket({
  locationLike,
  storage,
  fetchImpl,
} = {}) {
  if (!locationLike || locationLike.protocol === 'file:') {
    return {
      ok: false,
      auth: 'file',
      error: 'Open this page from the sensing server (http://127.0.0.1:3000). It does not call any other address.',
    };
  }
  const wsUrl = sameOriginSensingWs(locationLike);
  const token = getToken(storage);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    return { ok: false, auth: 'error', error: 'This environment cannot reach the sensing server.' };
  }
  let response;
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    response = await doFetch('/api/v1/ws-ticket', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    });
  } catch {
    return {
      ok: false,
      auth: 'offline',
      url: wsUrl,
      error: 'The sensing server did not answer the ticket request.',
    };
  }
  if (response.status === 404) {
    return { ok: true, auth: 'off', url: wsUrl };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      auth: token ? 'rejected' : 'missing',
      url: wsUrl,
      error: token
        ? 'The server rejected this token (HTTP ' + response.status + ').'
        : 'This server requires a token (HTTP ' + response.status + ').',
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      auth: 'error',
      url: wsUrl,
      error: `Ticket request failed (HTTP ${response.status}).`,
    };
  }
  const body = await response.json().catch(() => null);
  const ticket = body && typeof body.ticket === 'string' ? body.ticket : '';
  if (!ticket) return { ok: true, auth: 'off', url: wsUrl };
  return { ok: true, auth: 'ticket', url: `${wsUrl}?ticket=${encodeURIComponent(ticket)}` };
}

export function installTokenHook() {
  const hook = () => getToken();
  try { globalThis.__ruviewGetToken = hook; } catch { /* non-browser */ }
  return hook;
}

function cleanToken(token) {
  return String(token ?? '').replace(/^\uFEFF/, '').trim();
}

function readStored(storage) {
  try {
    const value = storage?.getItem(STORED_TOKEN_KEY);
    return value ? cleanToken(value) : null;
  } catch {
    return null;
  }
}

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* blocked */ }
  return null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Visible token dock for Observatory. Injected so a cached stylesheet
 * cannot hide it. The token value is never written into the DOM.
 */
export function mountObservatoryDock({ onTokenChanged } = {}) {
  if (typeof document === 'undefined') return;
  installTokenHook();
  const style = document.createElement('style');
  style.textContent = `
    #ruview-live-dock { position: fixed; z-index: 40; left: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px));
      background: rgba(12, 18, 24, 0.94); color: #e7eef2; border: 1px solid #3d4c57; border-radius: 12px;
      padding: 12px 14px; font: 13px/1.4 "Segoe UI", sans-serif; }
    #ruview-live-dock h2 { margin: 0 0 6px; font-size: 14px; }
    #ruview-live-dock p { margin: 0 0 8px; color: #b7c4cc; }
    #ruview-live-dock .row { display: flex; gap: 6px; margin-top: 6px; }
    #ruview-live-dock input[type="password"] { flex: 1; min-width: 0; background: #0e1418; color: inherit;
      border: 1px solid #3d4c57; border-radius: 8px; padding: 6px 8px; }
    #ruview-live-dock button, #ruview-live-dock .file { background: #243038; color: inherit; border: 1px solid #3d4c57;
      border-radius: 8px; padding: 6px 8px; cursor: pointer; }
    #ruview-live-dock .file input { display: none; }
    #ruview-live-dock.auth-required { border-color: #e2b657; }
    #ruview-live-dock.live { border-color: #7dcea0; }
    #ruview-live-dock.offline, #ruview-live-dock.error { border-color: #e07a72; }
  `;
  document.head.appendChild(style);
  const dock = document.createElement('section');
  dock.id = 'ruview-live-dock';
  dock.className = 'auth-required';
  dock.innerHTML = `
    <h2 id="ruview-live-heading">Auth required</h2>
    <p id="ruview-live-copy">This view does not invent a demo scene.</p>
    <div class="row"><input id="ruview-token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste token"><button type="button" id="ruview-use-token">Use</button></div>
    <div class="row"><label class="file">Token file<input id="ruview-token-file" type="file" accept=".txt,text/plain"></label><button type="button" id="ruview-clear-token">Clear</button></div>
    <label class="row"><input id="ruview-remember" type="checkbox"> Remember in this browser</label>
    <p id="ruview-token-source"></p>
    <p id="ruview-live-nodes"></p>
    <p><a href="/ui/floorplan/index.html">Floor plan</a></p>
  `;
  document.body.appendChild(dock);
  const heading = dock.querySelector('#ruview-live-heading');
  const copy = dock.querySelector('#ruview-live-copy');
  const source = dock.querySelector('#ruview-token-source');
  const nodes = dock.querySelector('#ruview-live-nodes');
  const input = dock.querySelector('#ruview-token');
  const refresh = () => {
    const where = tokenSource();
    source.textContent = where === 'memory'
      ? 'Token is in this tab’s memory only.'
      : where === 'stored'
        ? 'Using the token already saved in this browser. This page did not write it.'
        : 'No token loaded.';
  };
  const commit = (token) => {
    if (dock.querySelector('#ruview-remember').checked) rememberToken(token);
    else setMemoryToken(token);
    input.value = '';
    refresh();
    onTokenChanged?.();
  };
  dock.querySelector('#ruview-use-token').addEventListener('click', () => {
    const token = input.value.trim();
    if (!token) return;
    commit(token);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim()) commit(input.value.trim());
  });
  dock.querySelector('#ruview-clear-token').addEventListener('click', () => {
    clearMemoryToken();
    ignoreStoredToken();
    input.value = '';
    refresh();
    onTokenChanged?.();
  });
  dock.querySelector('#ruview-token-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseTokenText(String(reader.result || ''));
      if (!parsed.ok) {
        copy.textContent = parsed.error;
        return;
      }
      commit(parsed.token);
    };
    reader.readAsText(file);
  });
  refresh();
  return {
    setStatus(mode, message) {
      dock.className = mode;
      heading.textContent = mode === 'live'
        ? 'Live'
        : mode === 'offline'
          ? 'Offline'
          : mode === 'demo'
            ? 'Demo'
            : mode === 'no-data'
              ? 'No data'
              : 'Auth required';
      copy.textContent = message;
    },
    setNodes(text) { nodes.textContent = text; },
    forgetStored() { forgetStoredToken(); refresh(); },
  };
}
