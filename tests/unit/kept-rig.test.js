// The rig and placement the 3D stage keeps between mounts (public-src/stage3d/kept-rig.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { keptRig } from '../../public-src/stage3d/kept-rig.js';
import { resolveBindings } from '../../src/shared/space.ts';

const BAR = { id: 'kept-bar', name: 'Bar', channelCount: 24, channelMap: {},
  cells: Array.from({ length: 8 }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const PAR = { id: 'kept-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const profiles = { [BAR.id]: BAR, [PAR.id]: PAR };
const par = { id: 1, label: 'Par', universe: 0, address: 1, profileId: PAR.id, position: { x: 50, y: 80 } };
const bar = (id) => ({ id, label: `Bar ${id}`, universe: 1, address: 1, profileId: BAR.id, position: null });
const room = {
  version: 1, name: 'Kept', bounds: { width: 4, depth: 4, height: 2.5 }, rooms: [], objects: [],
  bindings: [{ id: 'strip', fixtureId: 11, unit: 0, position: { x: 0, y: 1, z: 0 }, confidence: 'estimated' }],
};

test('unchanged patch and room: the same rig and placement, so the scene rebuilds nothing', () => {
  const fixtures = [par, bar(10)];
  const first = keptRig(fixtures, profiles, room);
  const again = keptRig(fixtures, profiles, room);
  assert.equal(again.rig, first.rig);
  assert.equal(again.placed, first.placed);
});

test('a patch changed while the view was away is built again', () => {
  const first = keptRig([par, bar(10)], profiles, room);
  const moved = keptRig([{ ...par, position: { x: 20, y: 80 } }, bar(10)], profiles, room);
  assert.notEqual(moved.rig, first.rig);
  assert.notEqual(moved.placed, first.placed);
  const overridden = [{ ...par, position: { x: 20, y: 80 }, override: { enabled: true } }, bar(10)];
  const lit = keptRig(overridden, profiles, room);
  assert.equal(lit.rig, moved.rig, 'the layout does not depend on an override');
  assert.notEqual(lit.placed, moved.placed);
});

test('a bar replaced by another of the same profile resolves the room against the new one', () => {
  keptRig([par, bar(10)], profiles, room);
  const { rig } = keptRig([par, bar(11)], profiles, room);
  assert.deepEqual(rig.fixtures.map((f) => f.id), [1, 11]);
  const { resolved } = resolveBindings(rig.fixtures, rig, room.bindings);
  assert.equal(resolved[0].missingSources, 0, 'the binding to the new bar is found');
});
