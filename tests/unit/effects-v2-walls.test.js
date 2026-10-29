// Rising and Falling Wall picked by hand keep moving; a show's scheduled span still plays each once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { profilesRevision } from '../../src/server/profiles.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { lookInput } from '../../scripts/golden-party-looks.js';

// RGB lamps at the ceiling, mid height, low and on the floor, placed by plot height as an unimported room places them.
// The floor lamp is the bottom of the wall: a release reaches it at the bar line.
const HEIGHTS = [100, 45, 10, 0];
const LAMP = { id: 'v2-test-wall-lamp', name: 'Lamp', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const getProfile = () => LAMP;
const fixtures = HEIGHTS.map((height, i) => ({ id: i, address: 1 + 3 * i, universe: 0, profileId: LAMP.id, maxBrightness: 255,
  override: null, position: { x: 30 + 20 * i, y: 50, height }, group: null, geometry: null, hue: false }));
const rig = buildRig(fixtures, getProfile);
const space = buildUnitSpace(rig, null);
const BPM = 120, FRAME_BEATS = 1 / 22;
const resolve = (id) => presetById(id)?.spec ?? null;

function play(pattern, beats, { effect = resolve(pattern), ...extra } = {}) {
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  renderer.setSpace(space);
  const store = universes.createUniverseStore(universes.allocateShared());
  const input = { ...lookInput(pattern, fixtures, () => effect), ...extra };
  const frames = [];
  for (let k = 0; k * FRAME_BEATS <= beats; k++) {
    const beat = k * FRAME_BEATS, ms = beat * 60000 / BPM;
    renderer.frame(input, { beatPos: beat, bpm: BPM, epoch: 0 }, ms, store);
    const bytes = store.getBuffer(0);
    frames.push({ beat, bytes: Array.from(bytes.subarray(0, fixtures.length * 3)),
      levels: fixtures.map((f) => Math.max(...bytes.subarray(f.address - 1, f.address + 2))) });
  }
  return frames;
}

const within = (frames, from, to) => frames.filter((f) => f.beat >= from - 1e-9 && f.beat < to - 1e-9);
const firstBeat = (frames, lamp, test) => frames.find((f) => test(f.levels[lamp]))?.beat ?? null;

test('Falling Wall picked by hand releases from the ceiling down on every bar, not once', () => {
  const frames = play('v2.fallingWall', 16);
  for (let bar = 0; bar < 4; bar++) {
    const span = within(frames, bar * 4, bar * 4 + 4);
    const dark = [0, 1, 2].map((lamp) => firstBeat(span, lamp, (v) => v === 0));
    assert.ok(span[1].levels.every((v) => v > 0), `bar ${bar + 1} starts with the room filled: ${span[1].levels}`);
    assert.ok(dark.every((b) => b !== null), `bar ${bar + 1}: every lamp above the floor is released (${dark})`);
    assert.ok(dark[0] < dark[1] && dark[1] < dark[2], `bar ${bar + 1}: ceiling, then mid, then low (${dark})`);
  }
});

test('Rising Wall picked by hand rises from the floor again after its sixteen beats', () => {
  const frames = play('v2.risingWall', 40);
  for (const from of [0, 16]) {
    const span = within(frames, from, from + 16);
    const lit = HEIGHTS.map((_, lamp) => firstBeat(span, lamp, (v) => v > 0));
    assert.ok(lit.every((b) => b !== null), `from beat ${from}: every lamp is reached (${lit})`);
    assert.ok(lit[3] < lit[2] && lit[2] < lit[1] && lit[1] < lit[0], `from beat ${from}: floor, low, mid, then ceiling (${lit})`);
  }
  assert.equal(within(frames, 16.1, 16.2)[0].levels[0], 0, 'the ceiling is dark again once the wall restarts');
});

test('from a pad both walls keep repeating, since a voice carries no show span', () => {
  for (const [id, length] of [['v2.fallingWall', 4], ['v2.risingWall', 16]]) {
    const pad = { id: `pad:${id}`, spec: resolve(id), targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null,
      anchorBeat: 0, seed: seedFrom(`pad:${id}`) };
    const frames = play('', length * 3, { effect: null, voices: [pad] });
    const lit = (f) => f.levels.map((v) => v > 0).join();
    const first = within(frames, 0, length).map(lit), third = within(frames, 2 * length, 3 * length).map(lit);
    assert.ok(new Set(first).size > 2, `${id} moves through the room`);
    assert.deepEqual(third, first.slice(0, third.length), `${id} lights the same lamps a cycle later`);
  }
});

// The one-pass spec both walls played before: a show's span must reproduce it byte for byte.
const once = (id) => { const spec = resolve(id); return { ...spec, params: { ...spec.params, fillSource: 'once' } }; };

test('the director\'s one-bar release and the live build\'s span play each wall once, as before', () => {
  const release = play('v2.fallingWall', 10, { pixelSpan: 4, pixelFrom: null });
  assert.deepEqual(release.map((f) => f.bytes), play('v2.fallingWall', 10, { effect: once('v2.fallingWall') }).map((f) => f.bytes));
  assert.ok(within(release, 4, 10).every((f) => f.levels.every((v) => v === 0)), 'dark after the bar until the next scene');
  const build = play('v2.risingWall', 40, { pixelSpan: 16, pixelFrom: null, beatDivision: 2 });
  assert.deepEqual(build.map((f) => f.bytes), play('v2.risingWall', 40, { effect: once('v2.risingWall'), beatDivision: 2 }).map((f) => f.bytes));
  assert.ok(within(build, 16, 40).every((f) => f.levels.every((v) => v > 0)), 'the build holds the filled room');
});

test('a scheduled release draws the same frames in the preview as on the rig', () => {
  const data = { pattern: 'v2.fallingWall', colorA: 0, colorB: 6, colorC: 4, colorD: 8, bpm: BPM, pixelSpan: 4 };
  const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data }], null,
    { resolveEffect: resolve, space, profiles: { [LAMP.id]: LAMP }, safety: { acknowledged: true, hdFlashIntervalMs: 350 } });
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  renderer.setSpace(space);
  const store = universes.createUniverseStore(universes.allocateShared());
  const input = { ...lookInput('v2.fallingWall', fixtures, resolve), pixelSpan: 4 };
  for (let k = 0; k * FRAME_BEATS <= 8; k++) {
    const ms = k * FRAME_BEATS * 60000 / BPM;
    renderer.frame(input, { beatPos: k * FRAME_BEATS, bpm: BPM, epoch: 0 }, ms, store);
    const preview = sample(ms, fixtures, COLOR_PRESETS, rig), bytes = store.getBuffer(0);
    for (let u = 0; u < fixtures.length; u++) {
      assert.deepEqual([preview[u].r, preview[u].g, preview[u].b], Array.from(bytes.subarray(u * 3, u * 3 + 3)), `${ms} ms, lamp ${u}`);
    }
  }
});
