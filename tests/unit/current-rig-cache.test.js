import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRig, invalidateRig } from '../../src/server/rig.ts';
import { state } from '../../src/server/state.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';

test('the server rig cache observes point edits, fixture order, fresh snapshots and profile revisions', () => {
  const before = state.fixtures;
  const profile = { id: 'server-cache-audit', name: 'Server cache audit', channelCount: 6, channelMap: {},
    cells: [0, 3].map((red) => ({ channelMap: { red, green: red + 1, blue: red + 2 } })) };
  assert.equal(registerProfile(profile), true);
  try {
    state.fixtures = [1, 2].map((id) => ({ id, profileId: profile.id, address: 1 + (id - 1) * 6, universe: 0,
      position: { x: id * 30, y: 50, height: 20 }, geometry: { length: 10, angle: 0,
        points: [{ x: -5, y: 0, height: 0 }, { x: 5, y: 0, height: 30 }] } }));
    invalidateRig();
    const initial = currentRig();
    assert.deepEqual(initial.points.map((p) => p.height), [20, 50, 20, 50]);
    assert.equal(currentRig(), initial, 'unchanged state reuses its compiled geometry');
    state.fixtures[0].geometry.points[1].height = 40;
    const raised = currentRig();
    assert.notEqual(raised, initial);
    assert.deepEqual(raised.points.map((p) => p.height), [20, 60, 20, 50]);
    state.fixtures[0].geometry.points.reverse();
    const reversedCells = currentRig();
    assert.deepEqual(reversedCells.points.slice(0, 2).map((p) => p.height), [60, 20]);
    state.fixtures.reverse();
    const reordered = currentRig();
    assert.notEqual(reordered, reversedCells);
    assert.deepEqual(reordered.points.map((p) => p.height), [20, 50, 60, 20]);
    state.fixtures = structuredClone(state.fixtures);
    const snapshot = currentRig();
    assert.equal(snapshot.fixtures, state.fixtures, 'server metadata belongs to the latest snapshot');
    assert.deepEqual(snapshot.points, reordered.points);
    assert.equal(currentRig(), snapshot);
    registerProfile({ ...profile, cells: [...profile.cells].reverse() });
    const reprofiled = currentRig();
    assert.notEqual(reprofiled, snapshot);
    assert.deepEqual(reprofiled.cellMaps[0].map((channels) => channels.red), [3, 0]);
    invalidateRig();
    const rebuilt = currentRig();
    assert.notEqual(rebuilt, reprofiled);
    assert.deepEqual(rebuilt.points, reprofiled.points, 'explicit invalidation preserves the same physical coordinates');
  } finally {
    state.fixtures = before;
    unregisterProfile(profile.id);
    invalidateRig();
  }
});
