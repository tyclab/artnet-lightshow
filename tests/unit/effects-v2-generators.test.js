import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { particleObjects, particlesSchema } from '../../src/shared/effects/v2/particles.ts';
import { noise3 } from '../../src/shared/effects/v2/noise.ts';
import { pathEndpoints } from '../../src/shared/effects/v2/path.ts';
import { positionsOf, soft, paint, triggerLevel } from '../../src/shared/effects/v2/common.ts';
import { frameAt, audioOf, renderKind } from '../helpers/v2-frames.js';

function pointsRoom(points, facingDeg = 0) {
  const room = buildRoom(points.length, (i) => (points[i][0] + 2) / 4, (i) => 1 - points[i][1] / 4, () => 0.5, null);
  room.space = { x: Float32Array.from(points, (p) => p[0]), y: Float32Array.from(points, (p) => p[1]),
    z: Float32Array.from(points, (p) => p[2]), size: new Float32Array(points.length).fill(0.02),
    bounds: { width: 4, depth: 4, height: 4 }, listener: { x: 0, y: 1.2, z: 0, facingDeg },
    anchors: { low: { x: -2, y: 0, z: 2 }, high: { x: 2, y: 4, z: -2 } } };
  return room;
}

const room = pointsRoom([[-2, 0, 2], [0, 2, 0], [2, 4, -2], [0, 0.1, -1], [0, 3.9, -1]]);
const spec = (kind, params) => ({ kind: `v2.${kind}`, params });
const levels = (kind, params, beat, modulation) => renderKind(spec(kind, params), room, { ...frameAt(beat), modulation }).out.map((s) => s.level);

test('build fills measured height and drop releases downward with the same section clock', () => {
  const p = { elevationDeg: 90, profile: 'fill', fillSource: 'section', width: 0.1 };
  assert.ok(levels('sweep', p, 1, { sectionProgress: 0.25 })[3] > 0.7);
  assert.equal(levels('sweep', p, 1, { sectionProgress: 0.25 })[4], 0);
  assert.equal(levels('sweep', p, 1, { sectionProgress: 0 })[3], 0);
  const drop = levels('sweep', { ...p, falling: true }, 1, { sectionProgress: 0.25 });
  assert.ok(drop[1] > 0.7);
  assert.equal(drop[4], 0);
  assert.ok(levels('sweep', p, 1, { sectionProgress: 1 }).every((v) => v > 0));
});

test('a one-bar falling wall finishes in four beats regardless of the section length', () => {
  const p = { elevationDeg: 90, profile: 'fill', fillSource: 'once', lengthBeats: 4, falling: true };
  assert.ok(levels('sweep', p, 0, { sectionProgress: 0.9 }).some((v) => v > 0));
  assert.ok(levels('sweep', p, 4, { sectionProgress: 0.1 }).every((v) => v === 0));
});

test('named endpoints carry a diagonal sweep from a low corner to the opposite high corner', () => {
  const p = { fromAnchor: 'low', toAnchor: 'high', width: 0.08, speed: 1 };
  const distance = Math.sqrt(48);
  assert.ok(levels('sweep', p, 0)[0] > 0.99);
  const halfway = levels('sweep', p, distance / 2);
  assert.ok(halfway[1] > 0.99);
  assert.equal(halfway[0], 0);
  assert.equal(halfway[2], 0);
  assert.ok(levels('sweep', p, distance - 0.01)[2] > 0.9);
  const explicit = { ...p, fromAnchor: null, toAnchor: null, fromPoint: room.space.anchors.low, toPoint: room.space.anchors.high };
  assert.deepEqual(levels('sweep', explicit, distance / 2), halfway);
});

test('classic 2D folds vertical onto plot rows while room mode uses physical metres', () => {
  const plain = pointsRoom([[0, 0, 0], [0, 4, 0]]);
  plain.Y = [0.5, 0.5];
  const p = { elevationDeg: 90, profile: 'fill', fillSource: 'section', width: 0.1 };
  const f = { ...frameAt(1), modulation: { sectionProgress: 0.5 } };
  assert.notEqual(...renderKind(spec('sweep', p), plain, f).out.map((s) => s.level));
  assert.equal(...renderKind(spec('sweep', { ...p, space: 'plan' }), plain, f).out.map((s) => s.level));
});

test('a vertical endpoint path remains bottom to top when its lamps share a plot position', () => {
  const vertical = pointsRoom([[0, 0, 0], [0, 4, 0]]);
  vertical.X = [0.5, 0.5]; vertical.Y = [0.5, 0.5];
  const p = particlesSchema.parse({ space: 'plan', count: 1, trail: 0,
    fromPoint: { x: 0, y: 0, z: 0 }, toPoint: { x: 0, y: 4, z: 0 } });
  const path = pathEndpoints(p, vertical, positionsOf(vertical, 'plan'));
  assert.equal(path.from.z, 1);
  assert.equal(path.to.z, 0);
  assert.equal(particleObjects(p, vertical, frameAt(0))[0].z, 1);
  assert.equal(particleObjects(p, vertical, frameAt(4))[0].z, 0);
  assert.equal(renderKind(spec('sweep', { ...p, width: 0.1, speed: 1 }), vertical, frameAt(0)).out[0].level, 0);
  assert.ok(renderKind(spec('sweep', { ...p, width: 0.1, speed: 1 }), vertical, frameAt(2)).out[0].level > 0.99);
});

test('every new generator respects a silent volume gate with no colour floor', () => {
  for (const kind of ['wash', 'step', 'zones', 'noise', 'particles']) for (const space of ['room', 'plan']) {
    const params = { space, trigger: { mode: 'volumeGate', band: 'full', beatInterval: 1, threshold: 0.1, reactiveDepth: 1 } };
    const { out } = renderKind(spec(kind, params), room, frameAt(2, { audio: audioOf() }));
    assert.ok(out.every((s) => s.level === 0 && s.colour.r === 0 && s.colour.g === 0 && s.colour.b === 0), `${kind} ${space}`);
  }
});

test('surround order follows listener facing and reverses without changing geometry', () => {
  const around = pointsRoom([[0, 1.2, -1], [1, 1.2, 0], [0, 1.2, 1], [-1, 1.2, 0]]);
  const p = { order: 'orbit', steps: 4, window: 1, trail: 0, stepBeats: 1 };
  const lit = (params, r = around) => renderKind(spec('step', params), r, frameAt(0.05)).out.map((s) => s.level > 0.5);
  assert.deepEqual(lit(p), [true, false, false, false]);
  assert.deepEqual(lit({ ...p, direction: 'reverse' }), [false, false, false, true]);
  const turned = { ...around, space: { ...around.space, listener: { ...around.space.listener, facingDeg: 90 } } };
  assert.deepEqual(lit(p, turned), [false, true, false, false]);
});

test('noise is deterministic and continuous across lattice boundaries', () => {
  const a = noise3(1 - 1e-5, 0.2, -0.5, 42), b = noise3(1 + 1e-5, 0.2, -0.5, 42);
  assert.ok(Math.abs(a - b) < 1e-4);
  assert.equal(a, noise3(1 - 1e-5, 0.2, -0.5, 42));
  assert.notEqual(a, noise3(1 - 1e-5, 0.2, -0.5, 43));
});

test('orbs traverse a low to high path on the beat and replay identically after seeking', () => {
  const p = particlesSchema.parse({ count: 1, trail: 0, cycleBeats: 8, fromAnchor: 'low', toAnchor: 'high' });
  const at = (beat) => particleObjects(p, room, frameAt(beat));
  assert.deepEqual(at(0)[0], { x: -2, y: 0, z: 2, radius: 0.8, level: 1, colour: 0 });
  assert.ok(Math.abs(at(2)[0].y - 2) < 1e-9);
  assert.equal(at(4)[0].y, 4);
  assert.deepEqual(at(2), at(10));
});

test('firework sparks follow gravity, and the room launch changes real height', () => {
  const p = particlesSchema.parse({ mode: 'fireworks', count: 8, trail: 0, gravity: 0.6, cycleBeats: 8 });
  const at = (beat) => particleObjects(p, room, frameAt(beat));
  assert.ok(at(1)[0].y > at(0)[0].y);
  const early = at(3), middle = at(3.1), late = at(3.2);
  assert.equal(early.length, 8);
  for (let i = 0; i < early.length; i++) {
    assert.ok(Math.abs(late[i].y - 2 * middle[i].y + early[i].y + 0.006) < 1e-9);
    assert.ok(late[i].level < early[i].level);
  }
});

test('a high firework launch bursts continuously at the ceiling instead of travelling above it then teleporting', () => {
  const origin = { x: 0.25, y: 3.5, z: -0.5 };
  const p = particlesSchema.parse({ mode: 'fireworks', count: 8, trail: 0, fromPoint: origin,
    gravity: 0.8, cycleBeats: 8, speed: 2 });
  let previous = particleObjects(p, room, frameAt(0));
  let burst = null;
  for (let beat = 0.001; beat <= 2.4; beat += 0.001) {
    const current = particleObjects(p, room, frameAt(beat));
    if (current.length === p.count) { burst = current; break; }
    assert.ok(current[0].y <= room.space.bounds.height + 1e-8, 'rocket stays below the physical ceiling');
    assert.ok(current[0].y >= previous[0].y, 'the launch rises continuously');
    previous = current;
  }
  assert.ok(burst, 'the rocket bursts before leaving the room');
  for (const spark of burst) {
    assert.ok(Math.abs(spark.y - room.space.bounds.height) < 0.005);
    assert.ok(Math.hypot(spark.x - previous[0].x, spark.y - previous[0].y, spark.z - previous[0].z) < 0.006,
      'spark positions start at the rocket, with no discontinuous clamp');
  }
});

test('a drop starts a bounded orb collision immediately instead of waiting for a whole orbit', () => {
  const p = particlesSchema.parse({ mode: 'orbs', collide: true, count: 3, trail: 0, cycleBeats: 8 });
  const at = (beat) => particleObjects(p, room, { ...frameAt(beat), modulation: { section: 'drop' } });
  assert.ok(at(0).every((o) => Math.hypot(o.x, o.z) <= p.pathRadiusM + 1e-9));
  assert.equal(at(0.8).length, 24);
});

test('orbs on explicit diagonal paths converge and burst at their path midpoint', () => {
  const p = particlesSchema.parse({ mode: 'orbs', collide: true, count: 3, trail: 0, cycleBeats: 8,
    fromPoint: { x: -1, y: 0, z: 1 }, toPoint: { x: 3, y: 4, z: -1 } });
  const at = (beat) => particleObjects(p, room, { ...frameAt(beat), modulation: { section: 'drop' } });
  const midpoint = { x: 1, y: 2, z: 0 };
  const distance = (p) => Math.hypot(p.x - midpoint.x, p.y - midpoint.y, p.z - midpoint.z);
  assert.ok(at(0.63).every((o) => distance(o) < 0.06), 'approaching the collision has no jump to the listener');
  const sparks = at(0.64);
  assert.equal(sparks.length, 24);
  assert.ok(sparks.every((o) => distance(o) < 1e-9));
});

test('rain falls, splashes at floor height, and the plan twin stays in its plane', () => {
  const p = particlesSchema.parse({ mode: 'rain', count: 1, trail: 0, speed: 2, gravity: 1, cycleBeats: 4 });
  const early = particleObjects(p, room, frameAt(0))[0], falling = particleObjects(p, room, frameAt(1))[0];
  assert.ok(early.y > falling.y);
  const hit = -2 + Math.sqrt(12), splash = particleObjects(p, room, frameAt(hit + 0.1));
  assert.equal(splash.length, 4);
  assert.ok(splash.every((p) => p.y >= 0 && p.y < 0.25));
  const plan = particleObjects({ ...p, space: 'plan' }, room, frameAt(1));
  assert.ok(plan.every((p) => p.y === 0));
});

test('coincident emitters on different devices sample the same particle field', () => {
  const coincident = pointsRoom([[2, 1.2, 0], [2, 1.2, 0], [-2, 1.2, 0]]);
  coincident.hue = [true, false, false];
  const out = renderKind(spec('particles', { count: 1, trail: 0 }), coincident, frameAt(0)).out;
  assert.deepEqual(out[0], out[1]);
  assert.equal(out[2].level, 0);
  assert.ok(out[0].level > 0.99);
});

test('actual silent stems leave every zone black despite nonzero fallback bands', () => {
  const f = { ...frameAt(0.1, { audio: audioOf({ bass: 1, mid: 1, high: 1 }) }),
    modulation: { stems: { bass: 0, drums: 0, vocals: 0, hats: 0 } } };
  const out = renderKind(spec('zones', { partition: 'stems' }), room, f).out;
  assert.ok(out.every((s) => s.level === 0));
});


test('particle spatial pruning preserves brute-force emitted bytes, including Float32 winner ties', () => {
  const points = Array.from({ length: 121 }, (_, i) => [Math.sin(i * 1.37) * 2, 2 + Math.cos(i * 0.73) * 2, Math.sin(i * 2.13) * 2]);
  points.push([0, 1.2, 0], [0, 1.2, 0], [2, 1.2, 0], [-2, 1.2, 0]);
  const r = pointsRoom(points);
  r.space.size = Float32Array.from(points, (_, i) => [0, 0.02, 0.2, 0.5, 2][i % 5]);
  const bytes = (slot) => ['r', 'g', 'b', 'w', 'a', 'uv'].map((channel) => Math.round(slot.level * slot.colour[channel]));
  for (const space of ['room', 'plan']) for (const mode of ['orbs', 'fireworks', 'rain', 'dense-rain']) {
    for (const radiusM of [0.05, 1, 5]) for (const beat of [0, 0.337, 2.35, 5.723]) {
      const p = particlesSchema.parse({ space, mode: mode === 'dense-rain' ? 'rain' : mode, count: 64, trail: 8, radiusM, colour: 'along',
        ...(mode === 'dense-rain' ? { cycleBeats: 1, speed: 0.1, gravity: 0.05 } : {}) });
      const frame = frameAt(beat), positions = positionsOf(r, space);
      const expected = Array.from({ length: r.n }, () => ({ colour: null, level: 0, strength: 0 }));
      const levels = new Float32Array(r.n), colours = new Float32Array(r.n);
      for (const particle of particleObjects(p, r, frame)) for (let i = 0; i < r.n; i++) {
        const distance = Math.hypot(positions.x[i] - particle.x, positions.plan ? 0 : positions.y[i] - particle.y, positions.z[i] - particle.z);
        const level = soft(distance, particle.radius, positions.size[i]) * particle.level;
        if (level > levels[i]) { levels[i] = level; colours[i] = particle.colour; }
      }
      for (let i = 0; i < r.n; i++) paint(p, frame, colours[i], levels[i] * triggerLevel(p, frame), expected[i]);
      const actual = renderKind(spec('particles', p), r, frame).out;
      assert.deepEqual(actual.map(bytes), expected.map(bytes), `${space}/${mode}/radius=${radiusM}/beat=${beat}`);
    }
  }
});


test('a classic firework explicit launch uses room X and height, independently of depth and lamp placement', () => {
  const first = (y, z, r = room) => particleObjects(particlesSchema.parse({ mode: 'fireworks', space: 'plan', trail: 0,
    fromPoint: { x: 1, y, z } }), r, frameAt(0))[0];
  assert.deepEqual(first(1, -2), { x: 0.75, y: 0, z: 0.75, radius: 0.1, level: 1, colour: 0.15 });
  assert.equal(first(3, 2).z, 0.25, 'a higher launch starts higher on the plot');
  assert.deepEqual(first(1, 2), first(1, -2), 'depth is omitted in the vertical classic animation');
  assert.deepEqual(first(1, 0, pointsRoom([[1, 1, 0]])), first(1, 0), 'adding lamps cannot move an explicit launch');
});
