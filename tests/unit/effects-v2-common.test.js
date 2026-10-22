// The modifiers every v2 generator shares: where it samples, when it fires, how it fades and what colour it paints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoom } from '../../src/shared/room.ts';
import { v2CommonSchema, positionsOf, triggerLevel, soft, paint, PLAN_METRES, lengthIn } from '../../src/shared/effects/v2/common.ts';
import { frameAt, audioOf, RED, BLUE } from '../helpers/v2-frames.js';

const common = (patch = {}) => v2CommonSchema.parse(patch);

test('the shared modifiers default to the room, the timeline and a short linear envelope', () => {
  assert.deepEqual(common(), {
    space: 'room', trigger: { mode: 'timeline', band: 'full', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 },
    envelope: { curve: 'linear', attack: 0, hold: 0.25, release: 0.5 }, colour: 'along', background: 0, backgroundColour: '#FFFFFF',
  });
  assert.equal(v2CommonSchema.safeParse({ space: 'floor' }).success, false);
  assert.equal(v2CommonSchema.safeParse({ background: 2 }).success, false);
});

test('a soft crest is full at its centre, gone two widths out, and widened by a large emitter', () => {
  assert.equal(soft(0, 0.3, 0), 1);
  assert.ok(soft(0.6, 0.3, 0) < 0.01);
  assert.ok(Math.abs(soft(0.15, 0.3, 0) - 0.5) < 1e-9, 'half height at half the width');
  assert.ok(soft(0.3, 0.1, 0.3) > soft(0.3, 0.1, 0));
  assert.equal(soft(0, 0.1, 1), 1, 'a big lamp still reaches full as a thin line crosses its centre');
  assert.ok(soft(0.5, 0.1, 1) > 0 && soft(0.5, 0.1, 0) === 0, 'and fades across its whole extent');
  assert.equal(soft(-0.2, 0.3, 0), soft(0.2, 0.3, 0));
});

test('a timeline trigger is always on', () => {
  for (const beat of [0, 0.3, 2.75]) assert.equal(triggerLevel(common(), frameAt(beat)), 1);
});

test('a beat accent pulses on its interval with the envelope', () => {
  const accent = common({ trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } });
  assert.ok(triggerLevel(accent, frameAt(2.0)) >= 0.99);
  assert.ok(triggerLevel(accent, frameAt(2.75)) <= 0.05);
  assert.ok(Math.abs(triggerLevel(accent, frameAt(2.5)) - 0.5) < 1e-9, 'half way down the release');
  const everyTwo = common({ trigger: { ...accent.trigger, beatInterval: 2 } });
  assert.ok(triggerLevel(everyTwo, frameAt(3.0)) <= 0.05, 'no pulse between intervals');
  const shallow = common({ trigger: { ...accent.trigger, reactiveDepth: 0.4 } });
  assert.ok(Math.abs(triggerLevel(shallow, frameAt(2.75)) - 0.6) < 1e-9, 'depth keeps a floor');
});

test('a beat accent with live audio is as strong as its band', () => {
  const accent = common({ trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } });
  assert.equal(triggerLevel(accent, frameAt(2.0, { audio: audioOf({ bass: 0.1 }) })), 0);
  assert.ok(triggerLevel(accent, frameAt(2.0, { audio: audioOf({ bass: 1 }) })) >= 0.99);
});

test('a volume gate follows its band above the threshold', () => {
  const gate = common({ trigger: { mode: 'volumeGate', band: 'mid', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } });
  assert.equal(triggerLevel(gate, frameAt(1, { audio: audioOf({ mid: 0.1 }) })), 0);
  assert.ok(Math.abs(triggerLevel(gate, frameAt(1, { audio: audioOf({ mid: 0.6 }) })) - 0.45 / 0.85) < 1e-9);
  assert.equal(triggerLevel(gate, frameAt(1)), 1, 'without live input the show keeps running');
});

test('plan positions come from the plot, never the room space', () => {
  const room = buildRoom(3, (i) => [0.1, 0.5, 0.9][i], (i) => [0.2, 0.8, 0.5][i], (i) => [0, 0.5, 1][i], null);
  const plan = positionsOf(room, 'plan');
  const spaced = { ...room, space: { x: new Float32Array([5, 6, 7]), y: new Float32Array([1, 1, 1]), z: new Float32Array([0, 0, 0]),
    size: new Float32Array([0.1, 0.1, 0.1]), bounds: { width: 20, depth: 20, height: 3 }, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 }, anchors: {} } };
  assert.deepEqual(positionsOf(spaced, 'plan'), plan);
  assert.deepEqual(plan.bounds, { width: 1, depth: 1, height: 1 });
  const round = (values) => [...values].map((v) => Math.round(v * 1e6) / 1e6);
  assert.deepEqual(round(plan.x), [0, 0.5, 1]);
  assert.deepEqual(round(plan.z), [0, 1, 0.5], 'plot rows, top of the plot first');
  assert.deepEqual(round(plan.y), [0, 0.5, 1], 'height');
  assert.ok([...plan.size].every((s) => Math.abs(s - 0.02) < 1e-9));
  assert.equal(positionsOf(spaced, 'room').x, spaced.space.x);
  assert.deepEqual(positionsOf(room, 'room'), plan, 'without a space the room form plays on the plan');
});

test('metric lengths read against a nominal plot in plan space', () => {
  assert.equal(lengthIn('room', 1.5), 1.5);
  assert.equal(lengthIn('plan', 1.5), 1.5 / PLAN_METRES);
});

test('paint takes its colour by mode and keeps the background floor', () => {
  const slot = () => ({ colour: { r: 0, g: 0, b: 0 }, level: 0, strength: 0 });
  const along = slot();
  paint(common(), frameAt(0), 0.25, 1, along);
  assert.deepEqual([along.colour.r, along.colour.b, along.level, along.strength], [128, 128, 1, 1]);
  const solid = slot();
  paint(common({ colour: 'solid' }), frameAt(0), 0.5, 0.25, solid);
  assert.deepEqual([solid.colour, solid.level], [RED, 0.25]);
  const floor = slot();
  paint(common({ background: 0.2 }), frameAt(0), 0, 0, floor);
  assert.deepEqual([floor.level, floor.strength], [0.2, 1]);
  const dark = slot();
  paint(common(), frameAt(0), 0, 0, dark);
  assert.deepEqual([dark.level, dark.strength], [0, 1]);
  assert.deepEqual(dark.colour, { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 });
  paint(common({ background: 0.2, backgroundColour: '#0000FF' }), frameAt(0), 0, 0, floor);
  assert.deepEqual(floor.colour, BLUE, 'background uses its own selected colour, not colour A');
  const timed = [0, 8].map((beat) => { const s = slot(); paint(common({ colour: 'time' }), frameAt(beat), 0.9, 1, s); return s.colour; });
  assert.deepEqual(timed, [RED, BLUE], 'time mode walks the palette over four bars');
});
