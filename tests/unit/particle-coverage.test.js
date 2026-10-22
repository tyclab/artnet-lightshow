import test from 'node:test';
import assert from 'node:assert/strict';
import { measureParticleCoverage, ParticleCoverage } from '../../src/server/particle-coverage.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { syntheticRig, syntheticSpace } from '../../scripts/golden-frames.js';
import { availableFor } from '../../src/show/look.ts';
import { kindOf } from '../../src/shared/effects/registry.ts';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';

function pointsRoom(points) {
  const room = buildRoom(points.length, (i) => (points[i][0] + 2) / 4, (i) => (points[i][2] + 2) / 4, () => 0.5, null);
  room.space = { x: Float32Array.from(points, (p) => p[0]), y: Float32Array.from(points, (p) => p[1]),
    z: Float32Array.from(points, (p) => p[2]), size: new Float32Array(points.length).fill(0.02),
    bounds: { width: 4, depth: 4, height: 4 }, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 }, anchors: {} };
  return room;
}

test('a corner pixel pair does not qualify while well-placed whole lamps do', async () => {
  const corner = await measureParticleCoverage(pointsRoom([[1.9, 3.9, 1.9], [1.91, 3.9, 1.9]]));
  for (const id of ['v2.lightOrbs', 'v2.orbCollision', 'v2.fireworks']) {
    assert.equal(corner.eligible.has(id), false, id);
    assert.ok(corner.darkBeats.get(id) > 4, id);
  }
  const lamps = pointsRoom(Array.from({ length: 32 }, (_, i) => {
    const a = i * Math.PI / 16;
    return [Math.cos(a) * 2, 1.2 + Math.sin(a * 2) * 0.8, Math.sin(a) * 2];
  }));
  const coverage = await measureParticleCoverage(lamps);
  assert.ok(coverage.eligible.has('v2.lightOrbs'));
  assert.ok(coverage.darkBeats.get('v2.lightOrbs') <= 4);
  assert.ok(availableFor(V2_PRESETS, null, { particles: coverage.eligible }).has('v2.lightOrbs'));
});

test('coverage yields before rendering and between samples, so timers remain runnable', async () => {
  let pauses = 0, timerRan = false;
  const pending = measureParticleCoverage(pointsRoom([[2, 1.2, 0]]), () => false, async () => {
    pauses++; await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(pauses, 1);
  setImmediate(() => { timerRan = true; });
  await pending;
  assert.ok(pauses > 32);
  assert.equal(timerRan, true);
});

test('cache reuses unchanged geometry, invalidates profiles/order/room and cancels stale work', async () => {
  const { fixtures, profileOf } = syntheticRig();
  const rig = buildRig(fixtures, profileOf), space = syntheticSpace();
  let changes = 0;
  const cache = new ParticleCoverage(() => changes++);
  assert.equal(cache.forRig(rig, space).size, 0);
  assert.equal(changes, 0, 'starting a probe returns without synchronous rendering');
  const pending = cache.ready;
  cache.forRig(rig, space);
  assert.equal(cache.ready, pending);
  const moved = { ...space, revision: `${space.revision}/moved`, x: new Float32Array(space.n).fill(50) };
  cache.forRig(rig, moved);
  await cache.ready; await pending;
  assert.equal(changes, 1, 'superseded geometry cannot publish its eligible result');
  assert.equal(cache.allowed.size, 0);
  const previous = cache.ready;
  cache.forRig(rig, moved);
  assert.equal(cache.ready, previous);
  const reordered = buildRig([...fixtures].reverse(), profileOf);
  cache.forRig(reordered, null);
  assert.notEqual(cache.ready, previous);
  await cache.ready;
  const profilesChanged = buildRig(fixtures, (f) => ({ ...profileOf(f) }));
  const before = cache.ready;
  cache.forRig(profilesChanged, space);
  assert.notEqual(cache.ready, before);
  await cache.ready;
  assert.equal(changes, 3);
});


test('the probe renders only one frame between yields and cancellation stops before the next frame', async () => {
  const def = kindOf('v2.particles'), render = def.render;
  let renders = 0, cancelled = false;
  const resumes = [];
  def.render = (...args) => { renders++; return render(...args); };
  try {
    const pending = measureParticleCoverage(pointsRoom([[2, 1.2, 0]]), () => cancelled,
      () => new Promise((resolve) => resumes.push(resolve)));
    assert.equal(renders, 0);
    resumes.shift()();
    await Promise.resolve();
    assert.equal(renders, 1);
    assert.equal(resumes.length, 1);
    cancelled = true;
    resumes.shift()();
    const result = await pending;
    assert.equal(renders, 1);
    assert.equal(result.eligible.size, 0);
    assert.equal(result.darkBeats.size, 0);
  } finally { def.render = render; }
});
