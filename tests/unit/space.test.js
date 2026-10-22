// The unit space: every output unit's position in room metres, from the Stage
// room's bindings where they exist and from the Rig plot where they do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig } from '../../src/shared/rig.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { buildUnitSpace, spaceReport, roomSpaceOf, DEFAULT_BOUNDS } from '../../src/shared/space.ts';
import { syntheticRig } from '../../scripts/golden-frames.js';

const profiles = {
  lamp: { channelMap: { red: 0 } },
  pair: { cells: [{ channelMap: { red: 0 } }, { channelMap: { red: 1 } }] },
};
const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-5, `${label} ${actual} != ${expected}`);
const at = (space, u, [x, y, z]) => { near(space.x[u], x, 'x'); near(space.y[u], y, 'y'); near(space.z[u], z, 'z'); };
const roomOf = (bindings, extra = {}) => roomSceneSchema.parse({ version: 1, name: 'Test room', bounds: { width: 4, depth: 4, height: 2.6 },
  bindings, ...extra });
const point = (id, fixtureId, position, unit = 0) => ({ id, fixtureId, unit, position, confidence: 'estimated' });

const fixtures = [
  { id: 10, profileId: 'lamp', position: { x: 25, y: 50, height: 50 } },
  { id: 20, profileId: 'pair', position: { x: 50, y: 50, height: 50 }, geometry: { length: 10, angle: 0 } },
  { id: 30, profileId: 'lamp', position: { x: 75, y: 25, height: 100 } },
];
const rig = buildRig(fixtures, (f) => profiles[f.profileId]);

test('a point binding places its unit where the room says', () => {
  const space = buildUnitSpace(rig, roomOf([point('a', 30, { x: 1, y: 2, z: 0.5 })]));
  at(space, 3, [1, 2, 0.5]);
  assert.equal(space.bound[3], 1);
  assert.equal(space.n, rig.units.length);
});

test('a strip binding spreads its cells along the path', () => {
  const strip = { ...point('strip', 20, { x: 1, y: 1, z: 0 }), path: [{ x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }] };
  const space = buildUnitSpace(rig, roomOf([strip]));
  at(space, 1, [0.5, 1, 0]);
  at(space, 2, [1.5, 1, 0]);
  assert.deepEqual([space.bound[1], space.bound[2]], [1, 1]);
  near(space.size[1], 0.5, 'half the 1 m pitch');
});

test('a strip path covers only the cells no other binding names', () => {
  const path = [{ x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }];
  const space = buildUnitSpace(rig, roomOf([{ ...point('first', 20, { x: 1, y: 1, z: 0 }), path },
    point('second', 20, { x: -1, y: 0.5, z: 1 }, 1)]));
  at(space, 1, [1, 1, 0]);
  at(space, 2, [-1, 0.5, 1]);
});

test('a weighted mean gives every source unit the binding position', () => {
  const average = { id: 'mean', aggregation: 'weightedMean', position: { x: -1, y: 2, z: 1 }, confidence: 'estimated',
    sources: [{ fixtureId: 10, unit: 0, weight: 1 }, { fixtureId: 20, unit: 1, weight: 3 }] };
  const space = buildUnitSpace(rig, roomOf([average]));
  at(space, 0, [-1, 2, 1]);
  at(space, 2, [-1, 2, 1]);
  assert.deepEqual([...space.bound], [1, 0, 1, 0]);
});

test('an unbound unit keeps its plot position scaled into the room', () => {
  const space = buildUnitSpace(rig, roomOf([point('a', 30, { x: 1, y: 2, z: 0.5 })]));
  at(space, 0, [-1, 1.3, 0]);
  assert.equal(space.bound[0], 0);
  near(space.size[0], 0.1, 'a par');
});

test('emitter sizes follow the kind of light', () => {
  const { fixtures: synthetic, profileOf, room } = syntheticRig();
  const sRig = buildRig(synthetic, profileOf);
  const space = buildUnitSpace(sRig, roomSceneSchema.parse(room));
  const unitsOf = (id) => { const i = synthetic.findIndex((f) => f.id === id); const { start, count } = sRig.ranges[i]; return [start, count]; };
  near(space.size[unitsOf(1)[0]], 0.1, 'par');
  near(space.size[unitsOf(7)[0]], 0.15, 'hue lamp');
  near(space.size[unitsOf(8)[0]], 0.15, 'averaged hue lamp');
  const [strip, cells] = unitsOf(9);
  near(space.size[strip], 3.6 / cells / 2, 'strip cell: half the pitch along its path');
  const [panel] = unitsOf(10);
  near(space.size[panel], 0.12 / 2, 'panel cell: half the column pitch');
  near(space.y[panel], 0.675 * 2.6, 'top row of the vertical panel');
  near(space.y[panel + 7 * 12], 0.325 * 2.6, 'bottom row of the vertical panel');
});

test('without a room every unit takes the plot fallback in the generic venue', () => {
  const space = buildUnitSpace(rig, null);
  assert.deepEqual(space.bounds, DEFAULT_BOUNDS);
  assert.deepEqual([...space.bound], [0, 0, 0, 0]);
  near(space.x[0], -0.25 * DEFAULT_BOUNDS.width);
  near(space.y[3], DEFAULT_BOUNDS.height);
  assert.deepEqual(spaceReport(rig, null, space), { unbound: [0, 1, 2, 3], shared: [], far: [] });
  assert.deepEqual([space.anchors, space.listeners], [{}, {}]);
});

test('the report lists unbound, shared and far units', () => {
  const model = roomOf([point('a', 30, { x: 1, y: 2.6, z: -1 }), point('b', 30, { x: -1.8, y: 0, z: 1.8 }), point('c', 10, { x: -1, y: 1.3, z: 0.4 })]);
  const space = buildUnitSpace(rig, model);
  const report = spaceReport(rig, model, space);
  assert.deepEqual(report.unbound, [1, 2]);
  assert.deepEqual(report.shared, [3]);
  assert.deepEqual(report.far.map((f) => f.unit), [3]);
  near(report.far[0].metres, Math.hypot(-0.4 - 1, 1.3 - 2.6, 0.4 + 1), 'shared unit sits at the mean of its bindings');
  at(space, 3, [-0.4, 1.3, 0.4]);
});

test('the listener falls back to the room centre at seated height', () => {
  const space = buildUnitSpace(rig, roomOf([]));
  const room = roomSpaceOf([3, 0], space, null);
  assert.deepEqual(room.listener, { x: 0, y: 1.2, z: 0, facingDeg: 0 });
  assert.deepEqual(room.anchors, {});
  assert.deepEqual([...room.x], [space.x[3], space.x[0]]);
  assert.deepEqual(room.bounds, space.bounds);
});

test('a named listener and the anchors reach the effect room', () => {
  const model = roomOf([], { anchors: [{ id: 'speakerLeft', position: { x: -1.5, y: 1, z: -1.5 } }],
    listeners: [{ id: 'desk', position: { x: 0, y: 1.15, z: 0 }, facingDeg: 0 }, { id: 'couch', position: { x: 0, y: 0.9, z: 1.5 }, facingDeg: 180 }] });
  const space = buildUnitSpace(rig, model);
  assert.deepEqual(roomSpaceOf([0], space, 'couch').listener, { x: 0, y: 0.9, z: 1.5, facingDeg: 180 });
  assert.deepEqual(roomSpaceOf([0], space, null).listener, { x: 0, y: 1.15, z: 0, facingDeg: 0 }, 'the first listener by default');
  assert.deepEqual(roomSpaceOf([0], space, 'missing').listener, roomSpaceOf([0], space, null).listener);
  assert.deepEqual(roomSpaceOf([0], space).anchors, { speakerLeft: { x: -1.5, y: 1, z: -1.5 } });
});

test('a lamp room averages its cells and grows to cover them', () => {
  const strip = { ...point('strip', 20, { x: 1, y: 1, z: 0 }), path: [{ x: 0, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }] };
  const space = buildUnitSpace(rig, roomOf([strip]));
  const lamps = roomSpaceOf([0, 1, 2, 3], space, null, [[0], [1, 2], [3]]);
  assert.equal(lamps.x.length, 3);
  near(lamps.x[1], 1);
  near(lamps.size[1], 0.5 + 0.5, 'half the spread plus a cell');
});

test('the revision follows the content', () => {
  const model = roomOf([point('a', 30, { x: 1, y: 2, z: 0.5 })]);
  const first = buildUnitSpace(rig, model);
  assert.equal(buildUnitSpace(rig, structuredClone(model)).revision, first.revision);
  assert.notEqual(buildUnitSpace(rig, roomOf([point('a', 30, { x: 1.2, y: 2, z: 0.5 })])).revision, first.revision);
  assert.notEqual(buildUnitSpace(rig, null).revision, first.revision);
});
