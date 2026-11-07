/**
 * Interactive floor plan. Local file in, same-origin sensing out.
 * MIT License. Copyright (c) 2024 rUv.
 */
import {
  getToken,
  setMemoryToken,
  clearMemoryToken,
  rememberToken,
  forgetStoredToken,
  ignoreStoredToken,
  tokenSource,
  parseTokenText,
  installTokenHook,
} from '../live-session.mjs';
import { parsePlanText, planBounds, ringCentroid } from './plan-model.mjs';
import { normalizeNodes, normalizeLatest, normalizeStream, mergeLive, classifyHttp } from './live-model.mjs';

installTokenHook();

const PLAN_KEY = 'ruview.floorplan.plan.v1';
const MARKER_KEY = 'ruview.floorplan.markers.v1';
const ROOM_CLASS = ['room-a', 'room-b', 'room-c'];
const NS = 'http://www.w3.org/2000/svg';

const state = {
  rawText: null,
  model: null,
  floorIndex: 0,
  view: { x: 24, y: 24, k: 48 },
  flipY: false,
  markers: {},
  placing: null,
  drag: null,
  live: null,
  poll: null,
};

const svg = document.getElementById('plan');
const planError = document.getElementById('plan-error');
const warnings = document.getElementById('warnings');

document.getElementById('plan-file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadText(String(reader.result || ''), false);
  reader.onerror = () => showPlanError('The file could not be read on this computer.');
  reader.readAsText(file);
});

document.getElementById('preview-synthetic').addEventListener('click', async () => {
  try {
    const response = await fetch('./fixtures/synthetic-apartment.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('missing');
    loadText(await response.text(), false);
    showPlanError('Synthetic example geometry is on screen. It is not a measured building, and it does not add people.');
  } catch {
    showPlanError('The synthetic example could not be loaded.');
  }
});

document.getElementById('units').addEventListener('change', () => {
  if (state.rawText) loadText(state.rawText, true);
});
document.getElementById('flip-y').addEventListener('change', (event) => {
  state.flipY = event.target.checked;
  fit();
  draw();
});
document.getElementById('zoom-in').addEventListener('click', () => zoomAt(center(), 1.2));
document.getElementById('zoom-out').addEventListener('click', () => zoomAt(center(), 1 / 1.2));
document.getElementById('fit').addEventListener('click', () => { fit(); draw(); });
document.getElementById('floor').addEventListener('change', (event) => {
  state.floorIndex = Number(event.target.value) || 0;
  fit();
  draw();
});
document.getElementById('forget').addEventListener('click', () => {
  try {
    localStorage.removeItem(PLAN_KEY);
    localStorage.removeItem(MARKER_KEY);
  } catch { /* ignore */ }
  state.markers = {};
  draw();
});
document.getElementById('use-token').addEventListener('click', applyTokenFromInput);
document.getElementById('token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') applyTokenFromInput();
});
document.getElementById('clear-token').addEventListener('click', () => {
  clearMemoryToken();
  ignoreStoredToken();
  document.getElementById('token').value = '';
  refreshTokenSource();
  poll();
});
document.getElementById('token-file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const parsed = parseTokenText(String(reader.result || ''));
    if (!parsed.ok) {
      setLink('error', parsed.error);
      return;
    }
    commitToken(parsed.token);
  };
  reader.readAsText(file);
});

svg.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  zoomAt(
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    event.deltaY < 0 ? 1.1 : 1 / 1.1,
  );
}, { passive: false });

svg.addEventListener('pointerdown', (event) => {
  const rect = svg.getBoundingClientRect();
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const nodeId = event.target?.closest?.('[data-node]')?.getAttribute('data-node');
  if (state.placing != null && !nodeId) {
    const world = screenToWorld(point);
    placeMarker(state.placing, world.x, world.y);
    state.placing = null;
    svg.classList.remove('placing');
    draw();
    return;
  }
  if (nodeId) {
    state.drag = { kind: 'node', id: Number(nodeId), pointer: event.pointerId };
  } else {
    state.drag = { kind: 'pan', pointer: event.pointerId, x: point.x, y: point.y, ox: state.view.x, oy: state.view.y };
  }
  svg.setPointerCapture(event.pointerId);
});

svg.addEventListener('pointermove', (event) => {
  if (!state.drag) return;
  const rect = svg.getBoundingClientRect();
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (state.drag.kind === 'pan') {
    state.view.x = state.drag.ox + point.x - state.drag.x;
    state.view.y = state.drag.oy + point.y - state.drag.y;
    draw();
    return;
  }
  const world = screenToWorld(point);
  placeMarker(state.drag.id, world.x, world.y);
  draw();
});

svg.addEventListener('pointerup', () => { state.drag = null; });

window.addEventListener('keydown', (event) => {
  if (event.key === '+' || event.key === '=') zoomAt(center(), 1.15);
  if (event.key === '-' || event.key === '_') zoomAt(center(), 1 / 1.15);
  if (event.key === '0') { fit(); draw(); }
  if (event.key === 'Escape') {
    state.placing = null;
    svg.classList.remove('placing');
  }
});

restoreOptionalPlan();
refreshTokenSource();
poll();
state.poll = setInterval(poll, 2000);

function applyTokenFromInput() {
  const value = document.getElementById('token').value;
  if (!value.trim()) {
    setLink('auth-required', 'Enter a token or choose a one-line token file.');
    return;
  }
  commitToken(value.trim());
  document.getElementById('token').value = '';
}

function commitToken(token) {
  if (document.getElementById('remember').checked) rememberToken(token);
  else setMemoryToken(token);
  refreshTokenSource();
  poll();
}

function refreshTokenSource() {
  const source = tokenSource();
  const text = source === 'memory'
    ? 'Using a token held in this tab’s memory.'
    : source === 'stored'
      ? 'Using a token already saved in this browser by the dashboard. This page did not write it.'
      : 'No token is loaded.';
  document.getElementById('token-source').textContent = text;
}

function loadText(text, keepView) {
  const override = document.getElementById('units').value;
  let source = text;
  if (override !== 'file') {
    try {
      const data = JSON.parse(text.replace(/^\uFEFF/, ''));
      data.units = override;
      if (data.building && typeof data.building === 'object') data.building.units = override;
      source = JSON.stringify(data);
    } catch {
      showPlanError('The file is not valid JSON.');
      return;
    }
  }
  const model = parsePlanText(override === 'file' ? text : source);
  if (!model.ok) {
    showPlanError(model.error);
    return;
  }
  state.rawText = text;
  state.model = model;
  state.floorIndex = Math.min(state.floorIndex, model.floors.length - 1);
  fillFloors();
  warnings.replaceChildren();
  for (const warning of model.warnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    warnings.appendChild(item);
  }
  if (!keepView) {
    planError.hidden = true;
    fit();
  }
  draw();
  try {
    if (document.getElementById('remember-plan').checked) localStorage.setItem(PLAN_KEY, text);
  } catch { /* the plan stays in memory */ }
}

function restoreOptionalPlan() {
  try {
    const saved = localStorage.getItem(PLAN_KEY);
    const markers = localStorage.getItem(MARKER_KEY);
    if (markers) state.markers = JSON.parse(markers);
    if (saved) loadText(saved, false);
  } catch {
    state.markers = {};
  }
}

function showPlanError(message) {
  planError.hidden = false;
  planError.textContent = message;
}

function fillFloors() {
  const select = document.getElementById('floor');
  select.replaceChildren();
  state.model.floors.forEach((floor, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = floor.name;
    select.appendChild(option);
  });
  select.value = String(state.floorIndex);
}

function currentFloor() {
  return state.model?.floors?.[state.floorIndex] || null;
}

function fit() {
  const floor = currentFloor();
  if (!floor) return;
  const bounds = planBounds({ floors: [floor] });
  if (!bounds) return;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(rect.width, 320);
  const height = Math.max(rect.height, 240);
  const spanX = Math.max(bounds.maxX - bounds.minX, 0.5);
  const spanY = Math.max(bounds.maxY - bounds.minY, 0.5);
  state.view.k = Math.max(8, Math.min(width / (spanX * 1.2), height / (spanY * 1.25)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  state.view.x = width / 2 - cx * state.view.k;
  state.view.y = height / 2 - worldY(cy) * state.view.k;
}

function draw() {
  const floor = currentFloor();
  svg.replaceChildren();
  if (!floor) {
    const text = el('text');
    text.setAttribute('x', '24');
    text.setAttribute('y', '40');
    text.setAttribute('fill', '#93a3ad');
    text.textContent = 'Load a local JSON plan, or preview the synthetic example.';
    svg.appendChild(text);
    return;
  }
  const group = el('g');
  for (const [index, room] of floor.rooms.entries()) {
    const poly = el('polygon');
    poly.setAttribute('points', room.points.map((point) => `${sx(point[0])},${sy(point[1])}`).join(' '));
    poly.setAttribute('class', `room ${ROOM_CLASS[index % ROOM_CLASS.length]}`);
    const title = el('title');
    title.textContent = roomDetail(room);
    poly.appendChild(title);
    group.appendChild(poly);
    const [cx, cy] = ringCentroid(room.points);
    const name = el('text');
    name.setAttribute('class', 'room-label');
    name.setAttribute('x', String(sx(cx)));
    name.setAttribute('y', String(sy(cy)));
    name.setAttribute('text-anchor', 'middle');
    name.textContent = room.name;
    const meta = el('text');
    meta.setAttribute('class', 'room-meta');
    meta.setAttribute('x', String(sx(cx)));
    meta.setAttribute('y', String(sy(cy) + 16));
    meta.setAttribute('text-anchor', 'middle');
    meta.textContent = `approx ${room.areaM2.toFixed(1)} m²`;
    group.appendChild(name);
    group.appendChild(meta);
  }
  for (const wall of floor.walls) {
    const line = el('line');
    line.setAttribute('class', 'wall');
    line.setAttribute('x1', String(sx(wall.from[0])));
    line.setAttribute('y1', String(sy(wall.from[1])));
    line.setAttribute('x2', String(sx(wall.to[0])));
    line.setAttribute('y2', String(sy(wall.to[1])));
    line.setAttribute('stroke-width', String(Math.max(1, wall.thicknessM * state.view.k)));
    group.appendChild(line);
  }
  for (const opening of floor.openings) {
    if (!opening.segment) continue;
    const line = el('line');
    line.setAttribute('class', `opening-${opening.kind}`);
    line.setAttribute('x1', String(sx(opening.segment[0][0])));
    line.setAttribute('y1', String(sy(opening.segment[0][1])));
    line.setAttribute('x2', String(sx(opening.segment[1][0])));
    line.setAttribute('y2', String(sy(opening.segment[1][1])));
    const title = el('title');
    title.textContent = `${opening.label}${opening.snapped ? '' : ' (not on a wall)'}`;
    line.appendChild(title);
    group.appendChild(line);
  }
  for (const item of floor.furniture) {
    const rect = el('rect');
    rect.setAttribute('class', 'furniture');
    const w = item.widthM * state.view.k;
    const d = item.depthM * state.view.k;
    rect.setAttribute('x', String(sx(item.at[0]) - w / 2));
    rect.setAttribute('y', String(sy(item.at[1]) - d / 2));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(d));
    rect.setAttribute('transform', `rotate(${item.rotationDeg} ${sx(item.at[0])} ${sy(item.at[1])})`);
    const title = el('title');
    title.textContent = item.name;
    rect.appendChild(title);
    group.appendChild(rect);
  }
  for (const node of state.live?.nodes || []) {
    const marker = markerFor(floor.id, node.id);
    if (!marker) continue;
    group.appendChild(nodeMark(node, marker));
  }
  svg.appendChild(group);
  drawNodes(floor);
}

function nodeMark(node, marker) {
  const group = el('g');
  group.setAttribute('class', `node ${node.freshness}`);
  group.setAttribute('data-node', String(node.id));
  const circle = el('circle');
  circle.setAttribute('cx', String(sx(marker.x)));
  circle.setAttribute('cy', String(sy(marker.y)));
  circle.setAttribute('r', '12');
  const text = el('text');
  text.setAttribute('x', String(sx(marker.x)));
  text.setAttribute('y', String(sy(marker.y) + 4));
  text.textContent = String(node.id);
  const title = el('title');
  title.textContent = `Node ${node.id}, ${node.freshness}. Hand-placed. Not a sensed position.`;
  group.append(circle, text, title);
  return group;
}

function drawNodes(floor) {
  const host = document.getElementById('nodes');
  host.replaceChildren();
  const nodes = state.live?.nodes || [];
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = state.live?.link === 'auth-required'
      ? 'Nodes stay hidden until the server accepts a token.'
      : 'No nodes returned. Nothing is placed automatically.';
    host.appendChild(empty);
    return;
  }
  for (const node of nodes) {
    const card = document.createElement('article');
    card.className = 'node-card';
    const title = document.createElement('h3');
    title.textContent = `Node ${node.id}`;
    const measured = document.createElement('p');
    measured.textContent = measuredLine(node);
    const inference = document.createElement('p');
    inference.textContent = inferenceLine(node);
    const place = document.createElement('p');
    const marker = markerFor(floor.id, node.id);
    place.textContent = marker
      ? `Hand-placed at ${marker.x.toFixed(2)} m, ${marker.y.toFixed(2)} m on this floor.`
      : 'Location unknown. Place it by hand. It will not be guessed.';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const placeButton = document.createElement('button');
    placeButton.type = 'button';
    placeButton.textContent = 'Place on plan';
    placeButton.addEventListener('click', () => {
      state.placing = node.id;
      svg.classList.add('placing');
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = 'Clear marker';
    clearButton.addEventListener('click', () => {
      delete state.markers[markerKey(floor.id, node.id)];
      persistMarkers();
      draw();
    });
    actions.append(placeButton, clearButton);
    card.append(title, measured, inference, place, actions);
    host.appendChild(card);
  }
}

function measuredLine(node) {
  const rssi = node.measured.rssiDbm == null ? 'no RSSI' : `${node.measured.rssiDbm.toFixed(0)} dBm`;
  const seen = node.measured.lastSeenMs == null ? 'age unknown' : `${(node.measured.lastSeenMs / 1000).toFixed(1)} s since last frame`;
  const fps = node.measured.csiFps == null ? '' : `, CSI ${node.measured.csiFps} fps`;
  return `Measured: ${node.freshness}, ${rssi}, ${seen}${fps}.`;
}

function inferenceLine(node) {
  const motion = node.inference.motionLevel || 'no motion class';
  let count = 'no person-count field';
  if (node.inference.personCount != null) {
    count = `person_count ${node.inference.personCount}`;
    if (node.inference.personCountValid === false) count += ' (server marked invalid)';
  }
  return `Server field, not a room count: ${motion}; ${count}.`;
}

async function poll() {
  if (location.protocol === 'file:') {
    setLink('offline', 'This file is open from disk. Live sensing stays off. Serve the page from the sensing server.');
    return;
  }
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const [nodesRes, latestRes, streamRes] = await Promise.all([
      fetch('/api/v1/nodes', { headers, credentials: 'same-origin', cache: 'no-store' }),
      fetch('/api/v1/sensing/latest', { headers, credentials: 'same-origin', cache: 'no-store' }),
      fetch('/api/v1/stream/status', { headers, credentials: 'same-origin', cache: 'no-store' }),
    ]);
    const failed = [nodesRes, latestRes, streamRes].find((response) => response.status === 401 || response.status === 403);
    if (failed) {
      const http = classifyHttp(failed.status);
      state.live = mergeLive({ http: { auth: http.auth, message: http.message } });
      setLink('auth-required', http.message);
      draw();
      return;
    }
    const bad = [nodesRes, latestRes, streamRes].find((response) => !response.ok);
    if (bad) {
      state.live = mergeLive({ http: { offline: true, message: `The sensing API returned HTTP ${bad.status}.` } });
      setLink('offline', state.live.message);
      draw();
      return;
    }
    const nodes = normalizeNodes(await nodesRes.json());
    const latest = normalizeLatest(await latestRes.json());
    const stream = normalizeStream(await streamRes.json());
    state.live = mergeLive({ nodes, latest, stream });
    renderLive(latest, stream);
    draw();
  } catch {
    state.live = mergeLive({ http: { offline: true, message: 'The sensing API is unreachable. No occupancy is being invented.' } });
    setLink('offline', state.live.message);
    draw();
  }
}

function renderLive(latest, stream) {
  if (state.live.syntheticSource) {
    setLink('error', `The server source is “${state.live.source}”. These figures are synthetic server data, not the ESP32 boards.`);
  } else if (state.live.source && /offline/.test(state.live.source)) {
    setLink('offline', `The server source is “${state.live.source}”.`);
  } else if (latest.state === 'stale') {
    setLink('offline', latest.message);
  } else if (latest.state === 'no-data' && !(state.live.nodes || []).length) {
    setLink('no-data', latest.message || 'The server has no sensing data yet.');
  } else {
    const source = state.live.source ? ` Source ${state.live.source}.` : '';
    setLink('live', `Live API connected.${source} Global presence is a server estimate, not a room location.`);
  }
  const inference = document.getElementById('inference');
  if (!state.live.inference) {
    inference.textContent = latest.message || 'No server-wide estimate. Rooms are not colored by occupancy.';
  } else {
    const presence = state.live.inference.presence == null ? 'no presence field' : state.live.inference.presence ? 'presence true' : 'presence false';
    const motion = state.live.inference.motionLevel || 'no motion class';
    const count = state.live.inference.estimatedPersons == null
      ? 'no estimated person count'
      : `estimated persons ${state.live.inference.estimatedPersons} (not located)`;
    inference.textContent = `Server estimate: ${presence}, ${motion}, ${count}. Not mapped onto rooms.`;
  }
  const streamText = document.getElementById('stream');
  if (!stream.ok) streamText.textContent = stream.message;
  else {
    const clients = stream.clients == null ? 'unknown' : String(stream.clients);
    const fps = stream.fps == null ? 'unknown' : String(stream.fps);
    streamText.textContent = `Stream active ${stream.active ? 'yes' : 'no'}, clients ${clients}, update rate ${fps}.`;
  }
}

function setLink(kind, message) {
  const box = document.getElementById('link-status');
  box.className = `status ${kind}`;
  document.getElementById('link-text').textContent = message;
}

function placeMarker(id, x, y) {
  const floor = currentFloor();
  if (!floor) return;
  state.markers[markerKey(floor.id, id)] = { x, y };
  persistMarkers();
}

function persistMarkers() {
  try {
    if (document.getElementById('remember-plan').checked) {
      localStorage.setItem(MARKER_KEY, JSON.stringify(state.markers));
    }
  } catch { /* memory only */ }
}

function markerFor(floorId, nodeId) {
  return state.markers[markerKey(floorId, nodeId)] || null;
}

function markerKey(floorId, nodeId) {
  return `${floorId}:${nodeId}`;
}

function worldY(y) {
  return state.flipY ? -y : y;
}

function sx(x) { return x * state.view.k + state.view.x; }
function sy(y) { return worldY(y) * state.view.k + state.view.y; }

function screenToWorld(point) {
  return {
    x: (point.x - state.view.x) / state.view.k,
    y: state.flipY
      ? -((point.y - state.view.y) / state.view.k)
      : (point.y - state.view.y) / state.view.k,
  };
}

function zoomAt(point, factor) {
  const next = Math.max(4, Math.min(400, state.view.k * factor));
  const world = screenToWorld(point);
  state.view.k = next;
  state.view.x = point.x - world.x * next;
  state.view.y = point.y - worldY(world.y) * next;
  draw();
}

function center() {
  const rect = svg.getBoundingClientRect();
  return { x: rect.width / 2, y: rect.height / 2 };
}

function roomDetail(room) {
  const bits = [`${room.name}`, `approx ${room.areaM2.toFixed(1)} m²`];
  if (room.areaId) bits.push(`area id ${room.areaId} (not linked to sensing)`);
  if (room.material) bits.push(room.material);
  if (room.climate) bits.push(room.climate);
  return bits.join(' · ');
}

function el(name) {
  return document.createElementNS(NS, name);
}
