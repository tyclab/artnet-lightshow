// Neural: the music in space. Bass, mids and highs take their own places in the
// room (by height, by distance from the speakers, or by zone round the listener).
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { neuralReading } from '../../src/shared/effects/disco.ts';
import '../../src/shared/effects/index.ts';
import { frameAt, audioOf, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

const { room, layout, rig } = syntheticRoom();
const plain = syntheticRoom({ space: false }).room;
const neural = (params) => ({ kind: 'v2.neural', params, palette: ['#FF0000', '#00FF00', '#0000FF'] });
const heard = (bands, neuralReadingValue = { mainFrequency: 0.5, amplitude: 0.8 }) => {
  const audio = audioOf(bands);
  audio.disco.neural = neuralReadingValue;
  return audio;
};
const levels = (spec, audio, onRoom = room) => renderKind(spec, onRoom, frameAt(1, { audio })).out.map((s) => s.level);
const heights = Array.from({ length: room.n }, (_, i) => room.space.y[i]);
const below = (lv, metres) => lv.filter((_, i) => heights[i] < metres);
const above = (lv, metres) => lv.filter((_, i) => heights[i] > metres);
const slotOf = (fixtureId) => layout.units.list.findIndex((u) => rig.fixtures[rig.units[u].fixture].id === fixtureId);

test('Neural registers with its defaults', () => {
  assert.equal(kindOf('v2.neural').app, 'own');
  const p = validateSpec(neural({})).params;
  assert.deepEqual([p.layout, p.idle, p.smoothing, p.pitchColour], ['height', 0.08, 0.35, true]);
});

test('Disco and Neural share one reading of pitch and level', () => {
  const reading = neuralReading(heard({}, { mainFrequency: 0.3, amplitude: 1.7 }));
  assert.deepEqual(reading, { frequency: Math.fround(0.3), amplitude: 1 });
  assert.equal(neuralReading(null), null);
  const state = {};
  neuralReading(heard({}, { mainFrequency: 0.6, amplitude: 0.4 }), state);
  assert.deepEqual(neuralReading(null, state), { frequency: Math.fround(0.6), amplitude: Math.fround(0.4) }, 'held between readings');
});

test('bass lights the floor and highs the ceiling', () => {
  const bass = levels(neural({}), heard({ bass: 1 }));
  assert.ok(below(bass, 0.9).every((v) => v >= 0.8), `low: ${below(bass, 0.9)}`);
  assert.ok(above(bass, 1.8).every((v) => v <= 0.1), `high: ${above(bass, 1.8)}`);
  const high = levels(neural({}), heard({ high: 1 }));
  assert.ok(above(high, 1.8).every((v) => v >= 0.8));
  assert.ok(below(high, 0.9).every((v) => v <= 0.1));
  const mid = levels(neural({}), heard({ mid: 1 }));
  assert.ok(mid[slotOf(4)] >= 0.8, 'mids at head height');
});

test('with no music every unit idles', () => {
  const quiet = renderKind(neural({ idle: 0.08 }), room, frameAt(1)).out;
  assert.ok(quiet.every((s) => Math.abs(s.level - 0.08) < 1e-9));
});

test('bass spreads out from the speakers first', () => {
  const lv = levels(neural({ layout: 'distance' }), heard({ bass: 0.3 }));
  assert.ok(lv[slotOf(1)] >= 0.8 && lv[slotOf(5)] >= 0.8, 'within a metre of a speaker');
  assert.ok(lv[slotOf(7)] <= 0.1 && lv[slotOf(4)] <= 0.1, 'the far side of the room waits');
  const loud = levels(neural({ layout: 'distance' }), heard({ bass: 1 }));
  assert.ok(loud[slotOf(4)] >= 0.8, 'a full bass reaches across');
});

test('zones answer bass in front, mids at the sides and highs behind', () => {
  const at = (bands, id) => levels(neural({ layout: 'zones' }), heard(bands))[slotOf(id)];
  assert.ok(at({ bass: 1 }, 6) >= 0.8 && at({ bass: 1 }, 4) <= 0.1, 'bass ahead of the listener');
  assert.ok(at({ mid: 1 }, 2) >= 0.8 && at({ mid: 1 }, 6) <= 0.1, 'mids to the side');
  assert.ok(at({ high: 1 }, 4) >= 0.8 && at({ high: 1 }, 6) <= 0.1, 'highs behind');
});

test('the plan form maps the bands to plot rows', () => {
  const spec = neural({ space: 'plan' });
  const bass = levels(spec, heard({ bass: 1 }));
  assert.equal(bass[slotOf(1)], bass[slotOf(6)], 'same plot row, different heights');
  assert.ok(bass[slotOf(4)] >= 0.8, 'the bottom row of the plot');
  assert.ok(bass[slotOf(6)] <= 0.1, 'the top row of the plot');
  assert.deepEqual(levels(spec, heard({ bass: 1 }), plain), bass, 'the plan ignores the room');
});

test('the hue follows the pitch', () => {
  const at = (frequency) => renderKind(neural({}), room, frameAt(1, { audio: heard({ bass: 1 }, { mainFrequency: frequency, amplitude: 1 }) })).out[slotOf(3)].colour;
  assert.notDeepEqual(at(0), at(1 / 3));
  const fixed = renderKind(neural({ pitchColour: false }), room, frameAt(1, { audio: heard({ bass: 1 }, { mainFrequency: 0.9, amplitude: 1 }) })).out[slotOf(3)].colour;
  assert.deepEqual(fixed, renderKind(neural({ pitchColour: false }), room, frameAt(1, { audio: heard({ bass: 1 }, { mainFrequency: 0.1, amplitude: 1 }) })).out[slotOf(3)].colour);
});

test('smoothing eases a change between frames', () => {
  const spec = neural({ smoothing: 0.5 });
  const first = renderKind(spec, room, frameAt(1, { audio: heard({ bass: 1 }) }));
  const next = renderKind(spec, room, frameAt(1.05, { audio: heard({ bass: 0 }) }), first.state).out;
  const floor = slotOf(3);
  assert.ok(next[floor].level > 0.3 && next[floor].level < 0.9, `eased: ${next[floor].level}`);
});
