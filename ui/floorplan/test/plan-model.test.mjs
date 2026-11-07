import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parsePlanText, escapeText, polygonArea } from '../plan-model.mjs';

const fixture = readFileSync(new URL('../fixtures/synthetic-apartment.json', import.meta.url), 'utf8');

test('synthetic building fixture parses rooms, openings, and furniture', () => {
  const plan = parsePlanText(fixture);
  assert.equal(plan.ok, true);
  assert.equal(plan.format, 'building');
  assert.equal(plan.units, 'm');
  assert.equal(plan.floors.length, 2);
  const level = plan.floors[0];
  assert.equal(level.name, 'Level 1');
  assert.equal(level.cutHeightM, 1.2);
  assert.equal(level.rooms.length, 3);
  assert.equal(level.rooms[0].name, 'Room A');
  assert.equal(level.rooms[0].areaId, 'area-a');
  assert.ok(Math.abs(level.rooms[0].areaM2 - 12) < 1e-6);
  assert.equal(level.openings.some((item) => item.kind === 'door' && item.snapped), true);
  assert.equal(level.openings.some((item) => item.kind === 'window'), true);
  assert.equal(level.furniture[0].name, 'Table');
  assert.equal(JSON.stringify(level).includes('not-rendered'), false);
  assert.ok(plan.ignoredKeyCount > 0);
});

test('neonplan-import and malformed files', () => {
  const imported = parsePlanText(JSON.stringify({
    format: 'neonplan-import',
    units: 'cm',
    floors: [{
      name: 'Ground',
      rooms: [{ name: 'Room', points: [[0, 0], [100, 0], [100, 100]] }],
      doors: [{ at: [100, 50], width: 90 }],
    }],
  }));
  assert.equal(imported.ok, true);
  assert.equal(imported.floors[0].rooms[0].points[1][0], 1);
  assert.equal(parsePlanText('{').ok, false);
  assert.equal(parsePlanText('[]').ok, false);
  assert.equal(parsePlanText('{"building":{"version":1,"floors":[]}}').code, 'rooms');
  const hostile = parsePlanText(JSON.stringify({
    building: {
      version: 1,
      floors: [{
        name: 'Level',
        rooms: [{ name: '<img src=x onerror=alert(1)>', points: [[0, 0], [1, 0], [1, 1]] }],
      }],
    },
  }));
  assert.equal(hostile.ok, true);
  assert.equal(escapeText(hostile.floors[0].rooms[0].name).includes('<'), false);
});

test('area is absolute and closing points are not double-counted', () => {
  const plan = parsePlanText(JSON.stringify({
    floors: [{ rooms: [{ name: 'Box', points: [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]] }] }],
  }));
  assert.equal(polygonArea(plan.floors[0].rooms[0].points), 4);
});
