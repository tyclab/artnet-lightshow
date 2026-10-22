// Orbit: Light DJ's rotation family as a beam turning round the listener, in the room and on the plot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import '../../src/shared/effects/index.ts';
import { frameAt, syntheticRoom, renderKind, RED, BLUE } from '../helpers/v2-frames.js';

const { room, layout, rig } = syntheticRoom();
const plain = syntheticRoom({ space: false }).room;
const slotOf = (fixtureId) => layout.units.list.findIndex((u) => rig.fixtures[rig.units[u].fixture].id === fixtureId);
const orbit = (params) => ({ kind: 'v2.orbit', params, palette: ['#FF0000', '#0000FF'] });
const BEATS = Array.from({ length: 80 }, (_, k) => k * 0.05);
const peakOf = (spec, onRoom, fixtureId) => {
  const levels = BEATS.map((beat) => renderKind(spec, onRoom, frameAt(beat)).out[slotOf(fixtureId)].level);
  return BEATS[levels.indexOf(Math.max(...levels))];
};
const near = (a, b) => Math.abs(a - b) < 0.051;

test('Orbit registers as an own cell-level kind with its defaults', () => {
  assert.equal(kindOf('v2.orbit').app, 'own');
  assert.equal(kindOf('v2.orbit').level, 'cell');
  const p = validateSpec({ kind: 'v2.orbit', params: {} }).params;
  assert.deepEqual([p.axis, p.profile, p.sectors, p.beamDeg, p.turnsPerBar, p.heightTiltDeg], ['listener', 'beacon', 4, 40, 1, 0]);
});

test('a beacon turning once a bar reaches the right of the listener on beat 1 and the left on beat 3', () => {
  const spec = orbit({ turnsPerBar: 1 });
  assert.ok(near(peakOf(spec, room, 2), 1), `right: ${peakOf(spec, room, 2)}`);
  assert.ok(near(peakOf(spec, room, 3), 3), `left: ${peakOf(spec, room, 3)}`);
  assert.ok(near(peakOf(spec, room, 6), 0), 'ahead on the downbeat');
});

test('four sectors alternate the palette by quarter round the listener', () => {
  const out = renderKind(orbit({ profile: 'sectors', sectors: 4 }), room, frameAt(0)).out;
  const colour = (id) => out[slotOf(id)].colour;
  assert.deepEqual([colour(6), colour(2), colour(4), colour(3)], [RED, BLUE, RED, BLUE]);
  assert.ok([6, 2, 4, 3].every((id) => out[slotOf(id)].level === 1));
});

test('the plan form turns round the centre of the plot', () => {
  const spec = orbit({ space: 'plan' });
  assert.ok(near(peakOf(spec, room, 2), 1), 'right of the plot centre on beat 1');
  assert.ok(near(peakOf(spec, room, 4), 2), 'the plot bottom on beat 2');
  assert.deepEqual(renderKind(spec, room, frameAt(1.3)).out.map((s) => s.level), renderKind(spec, plain, frameAt(1.3)).out.map((s) => s.level));
});

test('a listener facing right starts the turn a beat on', () => {
  const facing = { ...room, space: { ...room.space, listener: { ...room.space.listener, facingDeg: 90 } } };
  assert.ok(near(peakOf(orbit({}), facing, 2), 0));
  assert.ok(near(peakOf(orbit({}), facing, 4), 1));
});

test('a tilted beam climbs as it turns', () => {
  const flat = orbit({ heightTiltDeg: 0 }), tilted = orbit({ heightTiltDeg: 45 });
  assert.ok(near(peakOf(tilted, room, 2) - peakOf(flat, room, 2), (45 * (2.6 - 1.15)) / 90), 'the ceiling par lags by its height');
});

test('gradient lays the palette round the listener and turns it', () => {
  const at = (beat) => renderKind(orbit({ profile: 'gradient' }), room, frameAt(beat)).out;
  assert.ok(at(0).every((s) => s.level === 1));
  assert.notDeepEqual(at(0)[slotOf(2)].colour, at(1)[slotOf(2)].colour);
});

test('without a room the orbit turns on the plot', () => {
  assert.ok([0, 1, 2, 3].some((beat) => renderKind(orbit({}), plain, frameAt(beat)).out.some((s) => s.level > 0.5)));
});
