import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNodes, normalizeLatest, normalizeStream, mergeLive, classifyHttp } from '../live-model.mjs';

test('nodes accept the v0.8.8 list and a map, without inventing rooms', () => {
  const listed = normalizeNodes({
    total: 2,
    nodes: [
      { node_id: 2, status: 'active', last_seen_ms: 40, rssi_dbm: -48, motion_level: 'present', person_count: 1, person_count_valid: false },
      { node_id: 1, status: 'stale', last_seen_ms: 9000, rssi_dbm: -70, csi_sequence: 12 },
    ],
  });
  assert.deepEqual(listed.nodes.map((node) => node.id), [1, 2]);
  assert.equal(listed.nodes[1].freshness, 'fresh');
  assert.equal(listed.nodes[1].measured.rssiDbm, -48);
  assert.equal(listed.nodes[1].inference.personCountValid, false);
  assert.equal(listed.nodes[1].roomId, undefined);
  const mapped = normalizeNodes({ nodes: { '1': { status: 'active', rssi_dbm: -40 } } });
  assert.equal(mapped.nodes[0].id, 1);
});

test('latest stale or empty data is not a live classification, and positions are dropped', () => {
  assert.equal(normalizeLatest({ status: 'no data yet' }).state, 'no-data');
  const stale = normalizeLatest({ status: 'stale', age_ms: 12000, source: 'esp32:offline', classification: { presence: true } });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.classification, undefined);
  const live = normalizeLatest({
    source: 'esp32',
    classification: { motion_level: 'active', presence: true, confidence: 0.4 },
    estimated_persons: 1,
    persons: [{ id: 1, position: [3, 1, 2] }],
    signal_field: { values: [1, 2, 3] },
    features: { mean_rssi: -42, variance: 0.2, motion_band_power: 0.5 },
  });
  assert.equal(live.state, 'live');
  assert.equal(live.locatedPeople, false);
  assert.equal(JSON.stringify(live).includes('position'), false);
  assert.equal(JSON.stringify(live).includes('signal_field'), false);
});

test('merge keeps measured telemetry apart from server inference', () => {
  const merged = mergeLive({
    nodes: normalizeNodes({ nodes: [{ node_id: 1, status: 'active', last_seen_ms: 10, rssi_dbm: -41 }] }),
    latest: normalizeLatest({
      source: 'esp32',
      classification: { motion_level: 'still', presence: false, confidence: 0.2 },
    }),
    stream: normalizeStream({ active: true, clients: 0, fps: 10, source: 'esp32', nodes: [{ node_id: 1, csi_fps: 10 }] }),
  });
  assert.equal(merged.link, 'live');
  assert.equal(merged.syntheticSource, false);
  assert.equal(merged.inference.locatedPeople, false);
  assert.equal(merged.inference.presence, false);
  assert.equal(merged.nodes[0].measured.csiFps, 10);
  assert.equal(merged.stream.clients, 0);
  const denied = mergeLive({ http: classifyHttp(401) });
  assert.equal(denied.link, 'auth-required');
  assert.deepEqual(denied.nodes, []);
});
