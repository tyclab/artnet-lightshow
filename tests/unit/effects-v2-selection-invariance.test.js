import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { frameAt, renderKind } from '../helpers/v2-frames.js';

function subdividedWall(copies) {
  const points = [];
  for (let i = 0; i < 20; i++) for (let k = 0; k < copies; k++) {
    points.push({ x: -1.13 + i % 5 * 0.16, y: 0.13 + Math.floor(i / 5) * 0.21, z: -2.23 });
  }
  const wall = points.length;
  for (let i = 0; i < 5; i++) points.push({ x: 2.13 * Math.cos(i * 1.25), y: 1.13, z: 2.13 * Math.sin(i * 1.25) });
  const room = buildRoom(points.length, (i) => (points[i].x + 3) / 6, (i) => (points[i].z + 3) / 6, (i) => points[i].y / 3, null);
  room.space = { x: Float32Array.from(points, (p) => p.x), y: Float32Array.from(points, (p) => p.y),
    z: Float32Array.from(points, (p) => p.z), size: new Float32Array(points.length).fill(0.02),
    bounds: { width: 6, depth: 6, height: 3 }, anchors: {}, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 } };
  room.lamps = { slots: [Array.from({ length: wall }, (_, i) => i), ...Array.from({ length: 5 }, (_, i) => [wall + i])] };
  return room;
}

test('subdividing a wall into 100 times more addresses does not change which fixtures Scatter chooses', () => {
  const coarse = subdividedWall(1), dense = subdividedWall(100);
  for (const id of ['v2.scatterStrobe', 'v2.scatterFade', 'v2.scatterGrow', 'v2.frequencyBurst']) {
    const spec = presetById(id).spec;
    let coarseState, denseState;
    const seen = new Set();
    for (let step = 0; step < 80; step++) {
      const time = frameAt(step * 0.25 + 0.03);
      const a = renderKind(spec, coarse, time, coarseState), b = renderKind(spec, dense, time, denseState);
      coarseState = a.state; denseState = b.state;
      const selected = (room, out) => room.lamps.slots.map((slots, i) => slots.some((u) => out[u].level > 0) ? i : -1).filter((i) => i >= 0);
      const chosen = selected(coarse, a.out);
      assert.deepEqual(selected(dense, b.out), chosen, `${id}, step ${step}: addresses cannot buy extra selection chances`);
      for (const i of chosen) seen.add(i);
    }
    assert.equal(seen.size, 6, `${id}: wall and all five lamps must actually participate`);
  }
});
