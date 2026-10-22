import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { DEFAULT_BOUNDS } from '../../src/shared/space.ts';
import { pointIn, positionsOf } from '../../src/shared/effects/v2/common.ts';
import { pathEndpoints } from '../../src/shared/effects/v2/path.ts';
import { particleObjects, particlesSchema } from '../../src/shared/effects/v2/particles.ts';
import { frameAt, renderKind } from '../helpers/v2-frames.js';

function sparseRoom(extra = false) {
  const xs = [0, 0.375, 0.5, 0.625, 1, ...(extra ? [0.875] : [])];
  const room = buildRoom(xs.length, (i) => xs[i], () => 0.5, () => 0.5, null);
  room.space = { x: Float32Array.from([-4, -3, 0, 3, 4, ...(extra ? [-1] : [])]), y: new Float32Array(xs.length).fill(1),
    z: new Float32Array(xs.length), size: new Float32Array(xs.length).fill(0.02),
    bounds: { width: 8, depth: 6, height: 4 }, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 },
    anchors: { left: { x: -1, y: 1, z: 0 }, right: { x: 1, y: 1, z: 0 } } };
  return room;
}
const points = { fromPoint: { x: -1, y: 1, z: 0 }, toPoint: { x: 1, y: 1, z: 0 }, fromAnchor: null, toAnchor: null };
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('explicit plan points remain distinct and continuous when both are nearest to the same lamp', () => {
  const room = sparseRoom(), pos = positionsOf(room, 'plan');
  assert.deepEqual(pointIn(room, pos, points.fromPoint), pointIn(room, pos, points.toPoint));
  const mapped = pathEndpoints(points, room, pos);
  assert.deepEqual(mapped, { from: { x: 0.375, y: 0, z: 0.5 }, to: { x: 0.625, y: 0, z: 0.5 } });
  for (const delta of [-1e-4, -1e-7, 1e-7, 1e-4]) {
    const moved = pathEndpoints({ ...points, toPoint: { ...points.toPoint, x: 1 + delta, z: delta } }, room, pos);
    almost(moved.to.x - mapped.to.x, delta / room.space.bounds.width);
    almost(moved.to.z - mapped.to.z, delta / room.space.bounds.depth);
  }
});

test('explicit plan Sweep follows the authored path rather than silently using its azimuth', () => {
  const room = sparseRoom();
  const params = { ...points, space: 'plan', azimuthDeg: 0, width: 0.08, speed: 1, motion: 'bounce', colour: 'solid' };
  const lit = (beat) => renderKind({ kind: 'v2.sweep', params }, room, frameAt(beat)).out
    .map((slot) => Math.round(slot.level * slot.colour.r));
  assert.deepEqual(lit(0), [0, 255, 0, 0, 0]);
  assert.deepEqual(lit(0.5), [0, 0, 255, 0, 0]);
  assert.deepEqual(lit(1), [0, 0, 0, 255, 0]);
});

test('explicit plan paths do not move when an added fixture becomes the nearest emitter', () => {
  const before = sparseRoom(), after = sparseRoom(true);
  const mapped = (room, params) => pathEndpoints(params, room, positionsOf(room, 'plan'));
  assert.deepEqual(mapped(before, points), mapped(after, points));
  const anchors = { fromPoint: null, toPoint: null, fromAnchor: 'left', toAnchor: 'right' };
  assert.notDeepEqual(mapped(before, anchors).from, mapped(after, anchors).from);
  for (const room of [before, after]) {
    assert.deepEqual(mapped(room, anchors).from, pointIn(room, positionsOf(room, 'plan'), room.space.anchors.left));
    assert.deepEqual(mapped(room, anchors).to, pointIn(room, positionsOf(room, 'plan'), room.space.anchors.right));
  }
});

test('orbs use the same continuous plan path and preserve the exact three-dimensional path in room mode', () => {
  const room = sparseRoom(), fromPoint = { x: -1, y: 0, z: -1.5 }, toPoint = { x: 1, y: 4, z: 1.5 };
  const plan = particlesSchema.parse({ space: 'plan', count: 1, trail: 0, cycleBeats: 8, fromPoint, toPoint });
  const at = (params, beat) => { const { x, y, z } = particleObjects(params, room, frameAt(beat))[0]; return { x, y, z }; };
  assert.deepEqual(at(plan, 0), { x: 0.375, y: 0, z: 0.25 });
  assert.deepEqual(at(plan, 4), { x: 0.625, y: 0, z: 0.75 });
  assert.deepEqual(at({ ...plan, space: 'room' }, 0), fromPoint);
  assert.deepEqual(at({ ...plan, space: 'room' }, 4), toPoint);
});

test('pure vertical plan paths retain floor-to-ceiling motion, while diagonal projection uses floor coordinates', () => {
  const room = sparseRoom(), pos = positionsOf(room, 'plan');
  const vertical = { ...points, fromPoint: { x: 1, y: 0, z: 2 }, toPoint: { x: 1, y: 4, z: 2 } };
  assert.deepEqual(pathEndpoints(vertical, room, pos), { from: { x: 0.625, y: 0, z: 1 }, to: { x: 0.625, y: 0, z: 0 } });
  const diagonal = pathEndpoints({ ...vertical, toPoint: { x: 3, y: 4, z: -2 } }, room, pos);
  almost(diagonal.from.z, 0.5 + 2 / 6); almost(diagonal.to.z, 0.5 - 2 / 6);
  assert.equal(diagonal.to.x, 0.875);
});

test('explicit plan points work without room bindings and keep off-room paths unclamped', () => {
  const room = buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null), pos = positionsOf(room, 'plan');
  const p = { ...points, fromPoint: { x: -DEFAULT_BOUNDS.width / 2, y: 0, z: -DEFAULT_BOUNDS.depth / 2 },
    toPoint: { x: DEFAULT_BOUNDS.width, y: DEFAULT_BOUNDS.height, z: DEFAULT_BOUNDS.depth } };
  assert.deepEqual(pathEndpoints(p, room, pos), { from: { x: 0, y: 0, z: 0 }, to: { x: 1.5, y: 0, z: 1.5 } });
  const vertical = { ...p, fromPoint: { x: 0, y: 0, z: 0 }, toPoint: { x: 0, y: DEFAULT_BOUNDS.height, z: 0 } };
  assert.deepEqual(pathEndpoints(vertical, room, pos), { from: { x: 0.5, y: 0, z: 1 }, to: { x: 0.5, y: 0, z: 0 } });
});
