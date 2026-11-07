/**
 * Normalize the v0.8.8 sensing REST payloads.
 *
 * Measured node telemetry (freshness, RSSI, CSI rate) stays separate from
 * server-wide inference (presence, motion class, person-count fields).
 * Person coordinates and signal-field grids are dropped.
 *
 * MIT License. Copyright (c) 2024 rUv.
 */

const STALE_AFTER_MS = 5000;

export function normalizeNodes(payload) {
  const list = nodeList(payload);
  const nodes = [];
  for (const item of list) {
    const node = normalizeNode(item);
    if (node) nodes.push(node);
  }
  nodes.sort((a, b) => a.id - b.id);
  return {
    ok: true,
    total: nodes.length,
    reportedTotal: numberOrNull(payload?.total),
    nodes,
  };
}

export function normalizeLatest(payload) {
  if (!payload || typeof payload !== 'object') {
    return { state: 'no-data', message: 'The sensing latest endpoint returned nothing.' };
  }
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (status === 'no data yet' || status === 'no_data') {
    return { state: 'no-data', message: 'The server reports no sensing data yet.', source: textOrNull(payload.source) };
  }
  if (status === 'stale') {
    return {
      state: 'stale',
      message: 'The server reports the last sensing update is stale.',
      ageMs: numberOrNull(payload.age_ms),
      source: textOrNull(payload.source),
    };
  }
  if (!payload.classification && !payload.features && !payload.source && status) {
    return { state: 'no-data', message: `The server returned status “${status}”.`, source: null };
  }
  const classification = payload.classification && typeof payload.classification === 'object'
    ? {
        motionLevel: textOrNull(payload.classification.motion_level),
        presence: payload.classification.presence === true ? true : payload.classification.presence === false ? false : null,
        confidence: numberOrNull(payload.classification.confidence),
      }
    : null;
  return {
    state: classification || payload.features ? 'live' : 'no-data',
    message: classification ? null : 'The latest payload has no classification.',
    source: textOrNull(payload.source),
    ageMs: numberOrNull(payload.age_ms),
    classification,
    estimatedPersons: numberOrNull(payload.estimated_persons),
    features: payload.features && typeof payload.features === 'object'
      ? {
          meanRssi: numberOrNull(payload.features.mean_rssi),
          variance: numberOrNull(payload.features.variance),
          motionBandPower: numberOrNull(payload.features.motion_band_power),
        }
      : null,
    nodeFeatures: nodeFeatureList(payload.node_features),
    locatedPeople: false,
  };
}

export function normalizeStream(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Stream status was not an object.' };
  }
  const nodes = Array.isArray(payload.nodes)
    ? payload.nodes.map((item) => ({
        id: nodeId(item?.node_id ?? item?.id),
        csiFps: numberOrNull(item?.csi_fps ?? item?.fps),
      })).filter((item) => item.id != null)
    : [];
  return {
    ok: true,
    active: payload.active === true,
    clients: numberOrNull(payload.clients),
    fps: numberOrNull(payload.fps),
    source: textOrNull(payload.source),
    nodes,
  };
}

export function mergeLive({ nodes, latest, stream, http }) {
  if (http?.auth === 'missing' || http?.auth === 'rejected') {
    return {
      link: 'auth-required',
      message: http.message,
      nodes: [],
      inference: null,
      stream: null,
    };
  }
  if (http?.offline) {
    return {
      link: 'offline',
      message: http.message || 'The sensing API is unreachable.',
      nodes: [],
      inference: null,
      stream: null,
    };
  }
  const byId = new Map();
  for (const node of nodes?.nodes || []) byId.set(node.id, { ...node });
  for (const feature of latest?.nodeFeatures || []) {
    const current = byId.get(feature.id) || { id: feature.id, status: 'unknown', measured: {} };
    current.measured = {
      ...current.measured,
      rssiDbm: current.measured.rssiDbm ?? feature.rssiDbm,
      lastSeenMs: current.measured.lastSeenMs ?? feature.lastSeenMs,
      frameRateHz: feature.frameRateHz,
      stale: feature.stale,
    };
    if (feature.motionLevel && !current.inference) {
      current.inference = { motionLevel: feature.motionLevel, presence: feature.presence };
    }
    byId.set(feature.id, current);
  }
  for (const rate of stream?.nodes || []) {
    const current = byId.get(rate.id);
    if (!current) continue;
    current.measured = { ...current.measured, csiFps: rate.csiFps };
  }
  const source = latest?.source || stream?.source || null;
  return {
    link: latest?.state === 'live' || (nodes?.nodes || []).length ? 'live' : (latest?.state || 'no-data'),
    message: latest?.message || null,
    source,
    syntheticSource: isSyntheticSource(source),
    nodes: [...byId.values()].sort((a, b) => a.id - b.id),
    inference: latest && latest.state === 'live'
      ? {
          motionLevel: latest.classification?.motionLevel ?? null,
          presence: latest.classification?.presence ?? null,
          confidence: latest.classification?.confidence ?? null,
          estimatedPersons: latest.estimatedPersons,
          features: latest.features,
          locatedPeople: false,
        }
      : null,
    stream: stream?.ok ? { active: stream.active, clients: stream.clients, fps: stream.fps } : null,
  };
}

export function classifyHttp(status) {
  if (status === 401 || status === 403) {
    return {
      auth: status === 401 ? 'missing' : 'rejected',
      message: status === 401
        ? 'The server requires a token (HTTP 401).'
        : 'The server refused the token (HTTP 403).',
    };
  }
  if (status >= 500) return { offline: true, message: `The server failed the request (HTTP ${status}).` };
  if (status === 0) return { offline: true, message: 'The sensing API is unreachable.' };
  return { auth: null, offline: false, message: null };
}

function normalizeNode(item) {
  if (!item || typeof item !== 'object') return null;
  const id = nodeId(item.node_id ?? item.id ?? item.nodeId);
  if (id == null) return null;
  const lastSeen = numberOrNull(item.last_seen_ms ?? item.lastSeenMs);
  const statusText = textOrNull(item.status);
  let freshness = 'unknown';
  if (statusText === 'active' || statusText === 'stale' || statusText === 'offline') {
    freshness = statusText === 'active' ? 'fresh' : statusText;
  } else if (lastSeen != null) {
    freshness = lastSeen > STALE_AFTER_MS ? 'stale' : 'fresh';
  }
  return {
    id,
    freshness,
    measured: {
      lastSeenMs: lastSeen,
      rssiDbm: numberOrNull(item.rssi_dbm ?? item.rssi),
      csiStatus: textOrNull(item.csi_status),
      csiLastSeenMs: numberOrNull(item.csi_last_seen_ms),
      csiSequence: numberOrNull(item.csi_sequence),
    },
    inference: {
      motionLevel: textOrNull(item.motion_level),
      personCount: numberOrNull(item.person_count),
      personCountValid: item.person_count_valid === true ? true : item.person_count_valid === false ? false : null,
    },
  };
}

function nodeFeatureList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const id = nodeId(item?.node_id ?? item?.id);
    if (id == null) continue;
    out.push({
      id,
      rssiDbm: numberOrNull(item.rssi_dbm),
      lastSeenMs: numberOrNull(item.last_seen_ms),
      frameRateHz: numberOrNull(item.frame_rate_hz),
      stale: item.stale === true,
      motionLevel: textOrNull(item.classification?.motion_level),
      presence: item.classification?.presence === true,
    });
  }
  return out;
}

function nodeList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.nodes)) return payload.nodes;
  if (payload.nodes && typeof payload.nodes === 'object') {
    return Object.entries(payload.nodes).map(([key, value]) => ({
      ...(value && typeof value === 'object' ? value : {}),
      node_id: value?.node_id ?? key,
    }));
  }
  return [];
}

function nodeId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  return n;
}

function numberOrNull(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isSyntheticSource(source) {
  if (!source) return false;
  const text = source.toLowerCase();
  return text.includes('simul') || text.includes('synthetic') || text === 'demo';
}
