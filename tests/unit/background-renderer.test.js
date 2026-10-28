import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { migrateEffectSpec } from '../../src/shared/effects/migrate.ts';
import { DEFAULT_BACKGROUND, composeBackground } from '../../src/shared/background.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { harness, row } from '../helpers/ldj-harness.js';

const emitters = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const profile = { id: 'six-emitter-background', channelCount: 6,
  channelMap: Object.fromEntries(emitters.map((channel, index) => [channel, index])) };
const fixtures = Array.from({ length: 8 }, (_, id) => ({ id, address: id * 6 + 1, universe: 0,
  profileId: profile.id, maxBrightness: 255, override: null, position: { x: id * 100 / 7, y: 50 }, group: null, geometry: null, hue: false }));
const colour = { r: 160, g: 120, b: 80, w: 100, a: 90, uv: 60 };
const off = { ...DEFAULT_BACKGROUND, mode: 'off' };
const fixed = { ...DEFAULT_BACKGROUND, mode: 'fixed', colour, level: .3 };
const look = { running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null,
  pixelMap: 'stage', masterDimmer: 255, beatDivision: 1, fixtures, universes: [0], flashLimit: false,
  safety: { acknowledged: true, hdFlashIntervalMs: 0 }, paletteOverride: [colour] };
function engine(patch = {}) {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  return { renderer, draw(now, change = {}) {
    renderer.frame(withInputDefaults({ ...look, ...patch, ...change }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return [...store.getBuffer(0).slice(0, fixtures.length * 6)];
  } };
}
const lit = (bytes) => bytes.some((byte) => byte > 0);
const dark = (bytes) => bytes.every((byte) => byte === 0);

for (const [name, kind, params, times] of [
  ['V2 authored idle', 'v2.neural', { background: .3, idle: .2, backgroundColour: '#FF8040' }, [0, 500]],
  ['Studio moving swirl', 'ldj.StudioSwirl', {}, [0, 500, 1000]],
  ['Studio moving wave', 'ldj.StudioWave', {}, [0, 500, 1000]],
  ['Visualizer mellow field', 'ldj.visualizer', { mellow: 'swirl' }, [0, 500, 1000]],
  ['Disco idle wash', 'hd.disco', { style: 'neural' }, [0, 2000, 4000]],
]) test(`${name}: actual six-emitter output removes the authored background`, () => {
  const effect = validateSpec({ kind, params, palette: ['#A07850645A3C'] });
  const legacy = engine({ effect }), disabled = engine({ effect, background: off });
  let before, after;
  for (const now of times) { before = legacy.draw(now); after = disabled.draw(now); }
  assert.ok(lit(before), 'negative control: the authored field is visibly lit');
  assert.ok(dark(after), `Off must remove every background emitter: ${after}`);
});

for (const kind of ['ldj.BLStrobeCycle', 'ldj.BLFadeCycle', 'ldj.BLGrowCycle', 'ldj.StrobeCycle', 'ldj.FillCycle']) {
  test(`${kind}: background extraction preserves active lamps and removes idle lamps`, () => {
    const effect = validateSpec({ kind, palette: ['#A07850645A3C', '#A07850645A3C'] });
    const legacy = engine({ effect, paletteOverride: null }), disabled = engine({ effect, paletteOverride: null, background: off });
    const before = legacy.draw(0), after = disabled.draw(0);
    assert.ok(lit(after), 'foreground remains visible');
    assert.ok(before.some((byte, index) => byte > 0 && after[index] === 0), 'negative control: authored lit rests become dark');
  });
}

test('classic chase uses independent Fixed RGBWAUV; Off does not turn off its foreground', () => {
  const legacy = engine({ pattern: 'chase' }).draw(0);
  const disabled = engine({ pattern: 'chase', background: off }).draw(0);
  const replacement = engine({ pattern: 'chase', background: fixed }).draw(0);
  assert.deepEqual(disabled.slice(0, 6), legacy.slice(0, 6));
  assert.ok(dark(disabled.slice(6)));
  assert.ok(replacement.slice(6).every((byte) => byte > 0), 'all six fixed emitters contribute');
});

for (const pattern of ['solid', 'breathe', 'fire', 'gradient']) test(`Off preserves ${pattern} primary content`, () => {
  const a = engine({ pattern }), b = engine({ pattern, background: off });
  for (const now of [0, 250, 500, 1500]) assert.deepEqual(b.draw(now), a.draw(now));
});

test('bitmap raster distinguishes authored colour beds from mandatory black rests', () => {
  for (const pattern of ['SolidBGSineWave', 'SolidBlackBGSineWave']) {
    const effect = validateSpec({ kind: 'ldj.bitmap', params: { pattern } });
    const a = engine({ effect }), b = engine({ effect, background: off }), c = engine({ effect, background: fixed });
    const before = a.draw(0), after = b.draw(0), replaced = c.draw(0);
    if (pattern === 'SolidBGSineWave') assert.ok(before.some((byte, index) => byte > after[index]), 'coloured raster bed is removable');
    else {
      assert.deepEqual(after, before, 'authored black is already dark');
      for (let i = 0; i < before.length; i += 6) if (dark(before.slice(i, i + 6))) assert.ok(dark(replaced.slice(i, i + 6)));
    }
  }
});

test('migration captures authored gain once; foreground brightness edits leave it unchanged', () => {
  const migrated = migrateEffectSpec({ kind: 'v2.neural', params: { background: .4 }, brightness: .3 }, 2);
  assert.deepEqual(migrated.background, { version: 1, level: .3 });
  const changed = validateSpec({ ...migrated, brightness: 0 });
  assert.deepEqual(changed.background, migrated.background);
  const legacy = engine({ effect: migrated }), edited = engine({ effect: changed });
  assert.deepEqual(edited.draw(0), legacy.draw(0));
  assert.ok(lit(edited.draw(500)));
});

test('nested macro conversion retains child gains and Off reaches the child field', () => {
  const raw = { kind: 'macro', params: { steps: [{ beats: 4, effect: { kind: 'v2.neural', brightness: .2, params: { background: .5 } } }] } };
  const spec = migrateEffectSpec(raw, 2);
  assert.equal(spec.params.steps[0].effect.background.level, .2);
  assert.ok(lit(engine({ effect: spec }).draw(0)));
  assert.ok(dark(engine({ effect: spec, background: off }).draw(0)));
});

test('Stop holds the resolved moving background and allows Fixed or Off without stale foreground', () => {
  const effect = validateSpec({ kind: 'ldj.StudioSwirl' });
  const e = engine({ effect });
  e.draw(0);
  const before = e.draw(500);
  const stopped = e.draw(500, { programmePlaying: false, running: false });
  assert.deepEqual(stopped, before);
  assert.deepEqual(e.draw(5000, { programmePlaying: false, running: false }), stopped);
  assert.ok(dark(e.draw(5500, { programmePlaying: false, background: off })));
  assert.ok(lit(e.draw(6000, { programmePlaying: false, background: fixed })));
});

test('a foreground tail is retained when the Disco release baseline is disabled', () => {
  const h = harness('hd.disco', row(1), { params: { style: 'peak' } });
  const audio = { t: 1, party: { full: 1, bass: 1, mid: 1, high: 1 }, disco: { peakHit: true }, spl: null };
  h.draw({ nowMs: 0, beatPos: 0 });
  h.draw({ nowMs: 100, beatPos: .2, audioMode: 'reactive', audio });
  const tail = h.draw({ nowMs: 300, beatPos: .6 })[0];
  const shown = composeBackground(tail.colour, tail.level, tail.background, off);
  assert.ok(Object.values(shown.colour).some((v) => v * shown.level > 0), 'the active release is foreground');
});

test('renderer and rehearsal use the same Fixed/Off composition for classic and stateful effects', () => {
  const rig = buildRig(fixtures, () => profile);
  for (const background of [off, fixed]) for (const [pattern, effect] of [['chase', null], ['ambient-test', validateSpec({ kind: 'v2.neural', params: { background: .3 } })]]) {
    const e = engine({ pattern, effect, background, paletteOverride: null });
    const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern, paletteOverride: null } }], null,
      { background, profiles: { [profile.id]: profile }, resolveEffect: () => effect, safety: look.safety });
    for (let tick = 0; tick < 10; tick++) {
      const now = tick * 1000 / 44;
      const wire = e.draw(now), shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap(c => ['r', 'g', 'b', 'w', 'a', 'uv'].map(k => c[k] ?? 0));
      wire.forEach((value, index) => assert.ok(Math.abs(value - shown[index]) <= 1, `${pattern}/${background.mode} emitter ${index}: ${value}/${shown[index]}`));
    }
  }
});

test('Fixed cannot fill a rapid effect’s owned dark rest; stopped Fixed remains an explicit ambient command', () => {
  const effect = validateSpec({ kind: 'v2.scatter', params: { density: 0, background: 0, stepBeats: .25,
    envelope: { curve: 'cut', attack: 0, hold: .05, release: 0 } } });
  const e = engine({ effect, background: fixed });
  assert.ok(dark(e.draw(0)), 'mandatory rapid-flash rest owns every covered emitter');
  assert.ok(lit(e.draw(500, { programmePlaying: false })), 'Stop removes programme ownership');
});

test('winning sequence background survives internal hold and global Stop without revealing its foreground', () => {
  const e = engine();
  const spec = validateSpec({ kind: 'ldj.StudioSwirl' });
  e.renderer.setSequence({ revision: 1,
    lanes: [{ id: 'one', kind: 'shared', name: 'one', mute: false, solo: false }],
    clips: [{ id: 'clip', laneId: 'one', fixtureIds: null, startBeat: 0, lengthBeats: 8, loopBeats: 8,
      spec, seed: [1, 2, 3, 4], mute: false }] });
  const sequenceTransport = { startBeat: 0, generation: 0, loop: null };
  e.draw(0, { sequenceRevision: 1, sequenceTransport });
  const live = e.draw(500, { sequenceRevision: 1, sequenceTransport });
  assert.ok(lit(live));
  const hold = { ...sequenceTransport, stop: { mode: 'hold', position: 1, traversal: 0 } };
  assert.deepEqual(e.draw(1000, { sequenceRevision: 1, sequenceTransport: hold }), live);
  assert.ok(dark(e.draw(1500, { sequenceRevision: 1, sequenceTransport: hold, background: off })), 'held clips retain semantic fields');
  assert.deepEqual(e.draw(2000, { sequenceRevision: 1, sequenceTransport: hold, programmePlaying: false }), live);
});

test('stopping during a scene fade retains the actual intermediate background field', () => {
  const e = engine({ effect: validateSpec({ kind: 'v2.neural', params: { background: .4, backgroundColour: '#FF0000' } }) });
  e.draw(0);
  const change = { effect: validateSpec({ kind: 'v2.neural', params: { background: .4, backgroundColour: '#0000FF' } }),
    fade: { seq: 1, ms: 1000, at: 0 } };
  const middle = e.draw(500, change);
  assert.ok(middle[0] > 0 && middle[2] > 0, 'negative control: both colours contribute mid-fade');
  const held = e.draw(500, { ...change, programmePlaying: false, running: false });
  held.forEach((byte, i) => assert.ok(Math.abs(byte - middle[i]) <= 1));
});

test('Stop uncovers the complete authored bed beneath an active chase lamp', () => {
  const e = engine({ pattern: 'chase' });
  const running = e.draw(0);
  assert.notDeepEqual(running.slice(0, 6), running.slice(6, 12));
  const stopped = e.draw(0, { programmePlaying: false, running: false });
  for (let i = 0; i < stopped.length; i += 6) assert.deepEqual(stopped.slice(i, i + 6), running.slice(6, 12));
});
