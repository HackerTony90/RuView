/**
 * Generic floor-plan importer.
 *
 * Accepts the operator-described NeonPlan-style `building` document and the
 * public NeonPlan 3D `neonplan-import` document. Unknown keys are ignored.
 * Geometry is returned in meters. Nothing here contacts a network.
 *
 * MIT License. Copyright (c) 2024 rUv.
 */

export const LIMITS = {
  maxBytes: 5_000_000,
  maxFloors: 24,
  maxRooms: 400,
  maxPoints: 240,
  maxOpenings: 2000,
  maxFurniture: 2000,
  maxWalls: 2000,
  maxAbsCoord: 100_000,
};

const UNIT_SCALE = { m: 1, meter: 1, meters: 1, cm: 0.01, mm: 0.001 };

export function parsePlanText(text) {
  if (typeof text !== 'string') {
    return fail('type', 'The plan must be a JSON text file.');
  }
  if (text.length > LIMITS.maxBytes) {
    return fail('size', 'The file is larger than 5 MB and was not loaded.');
  }
  const stripped = text.replace(/^\uFEFF/, '').trim();
  if (!stripped) return fail('empty', 'The file is empty.');
  let data;
  try {
    data = JSON.parse(stripped);
  } catch {
    return fail('json', 'The file is not valid JSON.');
  }
  return parsePlanDocument(data);
}

export function parsePlanDocument(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fail('shape', 'The plan JSON must be an object.');
  }
  const warnings = [];
  let ignored = 0;
  const format = detectFormat(data);
  const units = readUnits(data, format);
  if (!units.ok) return fail('units', units.error);
  if (units.warning) warnings.push(units.warning);

  const extracted = extractFloors(data, format, warnings);
  if (!extracted.ok) return fail(extracted.code, extracted.error);
  ignored += extracted.ignored;

  const floors = [];
  for (const source of extracted.floors.slice(0, LIMITS.maxFloors)) {
    const floor = parseFloor(source, units.scale, warnings);
    if (floor) floors.push(floor);
    ignored += floor ? floor.ignored : 0;
  }
  if (extracted.floors.length > LIMITS.maxFloors) {
    warnings.push(`Only the first ${LIMITS.maxFloors} floors are shown.`);
  }
  if (!floors.length) {
    return fail('rooms', 'No floor with a drawable room was found.');
  }
  return {
    ok: true,
    format,
    units: units.name,
    warnings,
    ignoredKeyCount: ignored,
    floors: floors.map(({ ignored: _ignored, ...floor }) => floor),
  };
}

export function polygonArea(points) {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function ringCentroid(points) {
  if (!points.length) return [0, 0];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const n = points.length;
    return [
      points.reduce((s, p) => s + p[0], 0) / n,
      points.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

export function planBounds(model) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const floor of model.floors || []) {
    for (const room of floor.rooms) {
      for (const [x, y] of room.points) add(x, y);
    }
    for (const wall of floor.walls) {
      add(wall.from[0], wall.from[1]);
      add(wall.to[0], wall.to[1]);
    }
    for (const opening of floor.openings) {
      if (opening.segment) {
        add(opening.segment[0][0], opening.segment[0][1]);
        add(opening.segment[1][0], opening.segment[1][1]);
      } else if (opening.at) add(opening.at[0], opening.at[1]);
    }
    for (const item of floor.furniture) add(item.at[0], item.at[1]);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function detectFormat(data) {
  if (data.format === 'neonplan-import') return 'neonplan-import';
  if (data.building && typeof data.building === 'object') return 'building';
  if (Array.isArray(data.floors) || Array.isArray(data.levels) || Array.isArray(data.storeys)) {
    return 'floors';
  }
  return 'unknown';
}

function readUnits(data, format) {
  const raw = firstString(data.units, data.building?.units, data.unit) || 'm';
  const name = raw.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(UNIT_SCALE, name)) {
    return { ok: false, error: `Unsupported units "${clip(raw)}". Use m, cm, or mm.` };
  }
  return {
    ok: true,
    name: name === 'meter' || name === 'meters' ? 'm' : name,
    scale: UNIT_SCALE[name],
    warning: format === 'neonplan-import' && !data.units
      ? 'neonplan-import omitted units; meters are assumed.'
      : null,
  };
}

function extractFloors(data, format, warnings) {
  let ignored = countUnknown(data, knownRoot(format));
  if (Array.isArray(data.buildings) && data.buildings.length > 1) {
    warnings.push('Several buildings were present. Only the first is shown.');
  }
  let body = data;
  if (format === 'building') body = data.building;
  else if (Array.isArray(data.buildings) && data.buildings[0]) body = data.buildings[0];
  else if (Array.isArray(data.plans) && data.plans[0]?.building) body = data.plans[0].building;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'shape', error: 'The plan has no building or floors object.' };
  }
  if (format === 'building' && body.version != null && Number(body.version) !== 1) {
    warnings.push(`building.version is ${clip(body.version)}; version 1 was expected. Parsing continued.`);
  }
  const floors = firstArray(body.floors, body.levels, body.storeys, data.floors);
  if (!floors) {
    return {
      ok: false,
      code: 'floors',
      error: 'No floors array was found. Expected building.floors or floors.',
    };
  }
  ignored += countUnknown(body, ['version', 'floors', 'levels', 'storeys', 'units', 'name', 'id']);
  return { ok: true, floors, ignored };
}

function knownRoot(format) {
  if (format === 'building') return ['building', 'units', 'unit'];
  if (format === 'neonplan-import') return ['format', 'units', 'rooms_at', 'floors'];
  return ['floors', 'levels', 'storeys', 'units', 'unit', 'buildings', 'plans', 'format', 'building'];
}

function parseFloor(source, scale, warnings) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const roomSources = firstArray(source.rooms, source.spaces, source.areas) || [];
  const rooms = [];
  let ignored = 0;
  for (const roomSource of roomSources) {
    if (rooms.length >= LIMITS.maxRooms) break;
    const room = parseRoom(roomSource, scale, warnings);
    if (room) rooms.push(room);
  }
  if (roomSources.length > LIMITS.maxRooms) {
    warnings.push(`A floor listed more than ${LIMITS.maxRooms} rooms. Extras were skipped.`);
  }
  if (!rooms.length) return null;
  const openings = [];
  collectOpenings(source, rooms, scale, openings, warnings, null);
  for (const room of rooms) {
    collectOpenings(room.source, rooms, scale, openings, warnings, room.id);
  }
  const furniture = [];
  collectFurniture(source.furniture, scale, furniture, warnings);
  for (const room of rooms) collectFurniture(room.source.furniture, scale, furniture, warnings);
  const walls = collectWalls(source.walls, scale, warnings);
  ignored += countUnknown(source, [
    'id', 'name', 'elevation', 'height', 'cut_height', 'rooms', 'spaces', 'areas',
    'openings', 'doors', 'windows', 'portals', 'glass', 'holes', 'furniture', 'walls',
  ]);
  return {
    id: label(source.id, `floor-${rooms[0].id}`),
    name: label(source.name, 'Floor'),
    elevationM: finite(source.elevation, scale),
    heightM: finite(source.height, scale),
    cutHeightM: finite(source.cut_height, scale),
    rooms: rooms.map(({ source: _source, ...room }) => room),
    openings: openings.slice(0, LIMITS.maxOpenings),
    furniture: furniture.slice(0, LIMITS.maxFurniture),
    walls,
    ignored,
  };
}

function parseRoom(source, scale, warnings) {
  if (!source || typeof source !== 'object') return null;
  const rawPoints = firstArray(source.points, source.polygon, source.outline, source.corners, source.vertices);
  const points = parsePoints(rawPoints, scale);
  if (points.length < 3) {
    warnings.push(`Skipped a room named “${clip(source.name || source.id || 'unnamed')}” because it has fewer than 3 points.`);
    return null;
  }
  const closed = dropClosingRepeat(points);
  return {
    source,
    id: label(source.id, label(source.area_id, 'room')),
    name: label(source.name, 'Room'),
    areaId: source.area_id == null ? null : label(source.area_id, ''),
    material: source.floor_material == null && source.material == null
      ? null
      : label(source.floor_material ?? source.material, ''),
    climate: source.climate == null ? null : label(source.climate, ''),
    points: closed,
    areaM2: polygonArea(closed),
  };
}

function parsePoints(list, scale) {
  if (!Array.isArray(list)) return [];
  const points = [];
  for (const item of list.slice(0, LIMITS.maxPoints)) {
    const point = asPoint(item, scale);
    if (point) points.push(point);
  }
  return points;
}

function asPoint(item, scale) {
  let x;
  let y;
  if (Array.isArray(item) && item.length >= 2) {
    x = Number(item[0]);
    y = Number(item[1]);
  } else if (item && typeof item === 'object') {
    x = Number(item.x);
    if (item.y != null) y = Number(item.y);
    else if (item.z != null) y = Number(item.z);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  x *= scale;
  y *= scale;
  if (Math.abs(x) > LIMITS.maxAbsCoord || Math.abs(y) > LIMITS.maxAbsCoord) return null;
  return [x, y];
}

function dropClosingRepeat(points) {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
    return points.slice(0, -1);
  }
  return points;
}

function collectOpenings(source, rooms, scale, openings, warnings, roomId) {
  if (!source || typeof source !== 'object') return;
  const groups = [
    ['door', source.doors],
    ['window', source.windows],
    ['opening', source.openings],
    ['opening', source.portals],
    ['window', source.glass],
    ['opening', source.holes],
  ];
  for (const [fallbackKind, list] of groups) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (openings.length >= LIMITS.maxOpenings) return;
      const opening = parseOpening(item, fallbackKind, rooms, scale, roomId);
      if (opening) openings.push(opening);
      else warnings.push('Skipped an opening that had no usable position.');
    }
  }
}

function parseOpening(item, fallbackKind, rooms, scale, roomId) {
  if (!item || typeof item !== 'object') return null;
  const kind = normalizeKind(item.type || item.kind || item.opening_type, fallbackKind);
  const width = finite(item.width ?? item.w, scale) ?? 0.9;
  const fromTo = segmentFrom(item, scale);
  if (fromTo) {
    return { kind, widthM: width, segment: fromTo, at: null, snapped: true, roomId, label: openingLabel(item, kind) };
  }
  const at = asPoint(item.at || item.position || item.center, scale)
    || (item.x != null ? asPoint(item, scale) : null);
  if (!at) {
    const edge = edgeOpening(item, rooms, roomId, scale, width);
    if (edge) return { kind, ...edge, roomId, label: openingLabel(item, kind) };
    return null;
  }
  const snapped = snapToEdge(at, width, rooms);
  return {
    kind,
    widthM: width,
    segment: snapped.segment,
    at: snapped.segment ? null : at,
    snapped: snapped.snapped,
    roomId,
    label: openingLabel(item, kind),
  };
}

function edgeOpening(item, rooms, roomId, scale, width) {
  const index = Number(item.edge ?? item.wall ?? item.wall_index);
  if (!Number.isInteger(index)) return null;
  const room = rooms.find((candidate) => candidate.id === roomId) || rooms[0];
  if (!room) return null;
  const a = room.points[index];
  const b = room.points[(index + 1) % room.points.length];
  if (!a || !b) return null;
  const t = Number(item.pos ?? item.t ?? 0.5);
  if (!Number.isFinite(t)) return null;
  const at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { widthM: width, segment: segmentAlong(a, b, at, width), at: null, snapped: true };
}

function snapToEdge(at, width, rooms) {
  let best = null;
  for (const room of rooms) {
    const pts = room.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const proj = projectPoint(at, a, b);
      if (!best || proj.dist < best.dist) best = { ...proj, a, b };
    }
  }
  if (!best || best.dist > 0.75) return { segment: null, snapped: false };
  return { segment: segmentAlong(best.a, best.b, best.point, width), snapped: true };
}

function segmentAlong(a, b, at, width) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const half = Math.max(0.2, Math.min(width, len)) / 2;
  return [[at[0] - ux * half, at[1] - uy * half], [at[0] + ux * half, at[1] + uy * half]];
}

function segmentFrom(item, scale) {
  const from = asPoint(item.from || item.a, scale);
  const to = asPoint(item.to || item.b, scale);
  if (from && to) return [from, to];
  if (Array.isArray(item.points) && item.points.length >= 2) {
    const a = asPoint(item.points[0], scale);
    const b = asPoint(item.points[1], scale);
    if (a && b) return [a, b];
  }
  return null;
}

function projectPoint(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby || 1;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + abx * t, a[1] + aby * t];
  return { point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

function collectFurniture(list, scale, furniture, warnings) {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (furniture.length >= LIMITS.maxFurniture) return;
    if (!item || typeof item !== 'object') continue;
    const at = asPoint(item.at || item.position || item.center, scale)
      || (item.x != null ? asPoint(item, scale) : null);
    if (!at) {
      warnings.push('Skipped furniture with no center point.');
      continue;
    }
    const size = Array.isArray(item.size) ? item.size : null;
    furniture.push({
      name: label(item.name || item.type || 'item', 'item'),
      at,
      widthM: finite(item.width ?? size?.[0], scale) ?? 0.8,
      depthM: finite(item.depth ?? item.d ?? size?.[1], scale) ?? 0.6,
      rotationDeg: Number.isFinite(Number(item.rotation)) ? Number(item.rotation) : 0,
    });
  }
}

function collectWalls(list, scale, warnings) {
  if (!Array.isArray(list)) return [];
  const walls = [];
  for (const item of list.slice(0, LIMITS.maxWalls)) {
    if (!item || typeof item !== 'object') continue;
    const from = asPoint(item.from, scale);
    const to = asPoint(item.to, scale);
    if (!from || !to) {
      warnings.push('Skipped a wall without from/to points.');
      continue;
    }
    walls.push({
      from,
      to,
      thicknessM: finite(item.thickness, scale) ?? 0.1,
    });
  }
  return walls;
}

function normalizeKind(value, fallback) {
  const text = String(value || fallback || 'opening').toLowerCase();
  if (text.includes('window') || text.includes('glass')) return 'window';
  if (text.includes('door')) return 'door';
  return 'opening';
}

function openingLabel(item, kind) {
  return label(item.name || item.id || kind, kind);
}

function finite(value, scale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n * scale;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || null;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

function label(value, fallback) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) return fallback;
  return text.slice(0, 80);
}

function clip(value) {
  return label(value, 'value');
}

function countUnknown(source, known) {
  if (!source || typeof source !== 'object') return 0;
  const allow = new Set(known);
  return Object.keys(source).filter((key) => !allow.has(key) && key !== '__proto__' && key !== 'constructor').length;
}

function fail(code, error) {
  return { ok: false, code, error, warnings: [], floors: [] };
}
