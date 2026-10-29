import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { migrateEffectSpec } from '../../src/shared/effects/migrate.ts';
import { HD_DEFAULTS } from '../../src/shared/effects/hd.ts';
import { bundleSpec } from '../../src/shared/effects/bundle.ts';
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

test('Fixed cannot fill a rapid effect’s owned dark rest', () => {
  const effect = validateSpec({ kind: 'v2.scatter', params: { density: 0, background: 0, stepBeats: .25,
    envelope: { curve: 'cut', attack: 0, hold: .05, release: 0 } } });
  const e = engine({ effect, background: fixed });
  assert.ok(dark(e.draw(0)), 'mandatory rapid-flash rest owns every covered emitter');
});

test('winning sequence background survives an internal hold without revealing its foreground', () => {
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
});



test('Visualizer spike baseline and colour handoff are ambient; Off keeps no five-percent residue', () => {
  const effect = validateSpec({ kind: 'ldj.visualizer', params: { active: 'flash', mellow: 'none' } });
  const a = engine({ effect, audioMode: 'reactive' }), b = engine({ effect, audioMode: 'reactive', background: off });
  const audio = (t, beat) => ({ t, party: { full: 1, bass: 1, mid: 1, high: 1 },
    spl: { db: 0, level: 0, section: 'soft', beat, eventT: t } });
  a.draw(0); b.draw(0);
  a.draw(100, { audio: audio(1, 'loud') }); b.draw(100, { audio: audio(1, 'loud') });
  assert.ok(lit(a.draw(140, { audio: audio(1, 'loud') })));
  assert.ok(lit(b.draw(140, { audio: audio(1, 'loud') })), 'Off retains the flash foreground');
  const baseline = a.draw(500, { audio: audio(1, 'loud') });
  assert.ok(lit(baseline), 'negative control: the authored handoff still emits light');
  assert.ok(dark(b.draw(500, { audio: audio(1, 'loud') })), 'Off removes the handoff baseline');
});

const hdGap = (kind, over = {}) => validateSpec({ kind, brightness: 1, ...over,
  params: { ...HD_DEFAULTS[kind].params, curve: 'cut', attack: 0, hold: .25, release: 0, stagger: 0, loopLength: 4, probability: 1,
    trigger: { ...HD_DEFAULTS[kind].params.trigger, mode: 'timeline' },
    ...(kind === 'hd.simpleAdsr' ? { rgbEnvelope: { ...HD_DEFAULTS[kind].params.rgbEnvelope,
      brightness: { attack: 0, hold: .1, decay: 0, sustain: 0, release: 0, peak: 1 } } } : {}),
    ...over.params } });

for (const kind of Object.keys(HD_DEFAULTS).filter(kind => kind !== 'hd.frequencyBurst')) {
  test(`${kind}: Fixed fills ordinary idle coverage in all six emitters while Follow and Off stay dark`, () => {
    const effect = hdGap(kind);
    const follow = engine({ effect }), removed = engine({ effect, background: off }), filled = engine({ effect, background: fixed });
    follow.draw(0); removed.draw(0); filled.draw(0);
    const original = follow.draw(900), disabled = removed.draw(900), wash = filled.draw(900);
    assert.ok(dark(original), 'negative control: this phase is an actual authored gap');
    assert.deepEqual(disabled, original, 'Off does not change foreground-only output');
    // Wire values include the established 1.8× UV calibration, applied after composition.
    for (let i = 0; i < wash.length; i += 6) assert.deepEqual(wash.slice(i, i + 6), [48, 36, 24, 30, 27, 32]);
    const dim = engine({ effect: validateSpec({ ...effect, brightness: .05 }), background: fixed });
    dim.draw(0);
    assert.deepEqual(dim.draw(900), wash, 'foreground brightness does not dim the independent wash');
  });
}

test('HD spatial coverage reveals Fixed without recolouring its fully covered foreground', () => {
  const effect = hdGap('hd.positionChase', { params: { stagger: .25, hold: .125 } });
  const a = engine({ effect, paletteOverride: null, background: off }), b = engine({ effect, paletteOverride: null, background: fixed });
  const foreground = a.draw(40), wash = b.draw(40);
  assert.ok(lit(foreground.slice(0, 6)), 'negative control: the first lamp owns foreground');
  assert.deepEqual(wash.slice(0, 6), foreground.slice(0, 6));
  assert.ok(dark(foreground.slice(6)));
  assert.ok(wash.slice(6).every(v => v > 0));
});

test('an explicitly black HD foreground owns its lamps independently of RGB brightness', () => {
  for (const kind of ['hd.positionChase', 'hd.simpleAdsr']) {
    const effect = hdGap(kind, { palette: ['#000000'],
      ...(kind === 'hd.simpleAdsr' ? { params: { rgbEnvelope: { ...HD_DEFAULTS[kind].params.rgbEnvelope, singleColour: '#000000',
        brightness: { attack: 0, hold: .1, decay: 0, sustain: 0, release: 0, peak: 1 } } } } : {}) });
    const e = engine({ effect, paletteOverride: null, background: fixed });
    assert.ok(dark(e.draw(20)), `${kind}: an active black foreground must not be mistaken for an empty slot`);
    assert.ok(lit(e.draw(900)), `${kind}: its later ordinary gap reveals Fixed`);
  }
});

test('a half-opacity black HD foreground reveals half the Fixed wash independently of its brightness', () => {
  const black = (sustain, brightness = 1) => hdGap('hd.simpleAdsr', { brightness, palette: ['#000000'],
    params: { rgbEnvelope: { ...HD_DEFAULTS['hd.simpleAdsr'].params.rgbEnvelope, singleColour: '#000000',
      brightness: { attack: 0, hold: .1, decay: 0, sustain, release: 0, peak: 1 } } } });
  const half = engine({ effect: black(.5), background: fixed }), dim = engine({ effect: black(.5, .05), background: fixed });
  const reference = engine({ effect: black(0), background: { ...fixed, level: .15 } });
  assert.ok(dark(half.draw(20)), 'negative control: the opaque black hold still occludes Fixed');
  reference.draw(20); dim.draw(20);
  const wash = half.draw(900);
  assert.ok(lit(wash), 'half coverage reveals the wash');
  assert.deepEqual(wash, reference.draw(900), 'half coverage of a .3 wash equals full coverage of a .15 wash');
  assert.deepEqual(dim.draw(900), wash, 'foreground brightness does not scale the revealed wash');
});

for (const kind of ['hd.frequencyBurst', 'hd.positionChase', 'hd.simpleAdsr']) {
  test(`${kind}: rapid rest coverage remains opaque under Fixed`, () => {
    const effect = hdGap(kind, { rapidFlash: true });
    const e = engine({ effect, background: fixed });
    assert.ok(lit(e.draw(20)), 'negative control: the admitted foreground can emit light');
    assert.ok(dark(e.draw(900)), 'Fixed cannot fill an owned rapid rest');
  });
}

test('HD zero-foreground coverage survives a sequence clip and its held snapshot', () => {
  const e = engine({ background: fixed });
  const effect = hdGap('hd.twinkle', { params: { probability: 0 } });
  e.renderer.setSequence({ revision: 1,
    lanes: [{ id: 'one', kind: 'shared', name: 'one', mute: false, solo: false }],
    clips: [{ id: 'gap', laneId: 'one', fixtureIds: null, startBeat: 0, lengthBeats: 8, loopBeats: 8,
      spec: effect, seed: [1, 2, 3, 4], mute: false }] });
  const sequenceTransport = { startBeat: 0, generation: 0, loop: null };
  const wash = e.draw(0, { sequenceRevision: 1, sequenceTransport });
  assert.ok(wash.every(v => v > 0));
  assert.ok(dark(e.draw(100, { sequenceRevision: 1, sequenceTransport, background: off })));
  const hold = { ...sequenceTransport, stop: { mode: 'hold', position: .2, traversal: 0 } };
  assert.deepEqual(e.draw(200, { sequenceRevision: 1, sequenceTransport: hold }), wash);
});

test('HD Fixed wash remains subordinate to explicit Kill and Blackout', () => {
  const effect = hdGap('hd.twinkle', { params: { probability: 0 } });
  const e = engine({ effect, background: fixed });
  assert.ok(lit(e.draw(0)), 'negative control: the transparent base exposes the wash');
  const kill = { id: 'kill', spec: validateSpec({ kind: 'energy.kill' }), targets: null, tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  assert.ok(dark(e.draw(100, { voices: [kill] })), 'Kill owns black above every background emitter');
  assert.ok(dark(e.draw(200, { masterBlackout: true })), 'Blackout owns the final output');
});

test('a pattern pad owns black through its HD gaps over a lit base and reveals Fixed there', () => {
  const gap = hdGap('hd.twinkle', { params: { probability: 0 } });
  const table = { revision: 0, lanes: [{ id: 'l', kind: 'shared', name: 'l', mute: false, solo: false }],
    clips: [{ id: 'gap', laneId: 'l', fixtureIds: null, startBeat: 0, lengthBeats: 4, loopBeats: 4, spec: gap, seed: [1, 2, 3, 4], mute: false }] };
  const pad = { id: 'pad', spec: validateSpec(bundleSpec({ patternId: 'p', lengthBeats: 4, table }, false), { internal: true }),
    targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  const base = engine();
  assert.ok(lit(base.draw(500)), 'negative control: the solid base is lit');
  assert.ok(dark(base.draw(500, { voices: [pad] })), 'the pad owns black in its gaps; the base never shows through');
  assert.ok(dark(engine({ background: off }).draw(500, { voices: [pad] })), 'Off is not transparency');
  assert.ok(lit(engine({ background: fixed }).draw(500, { voices: [pad] })), 'Fixed fills the pad gap');
});

for (const [pattern, now] of [['fade', 0], ['hit', 490]]) {
  test(`${pattern}: its floor is a bed that Off removes and Follow keeps`, () => {
    const follow = engine({ pattern }).draw(now), none = engine({ pattern, background: off }).draw(now);
    assert.ok(lit(follow), 'negative control: the curve rests on its floor');
    assert.ok(follow.every((byte) => byte < 64), 'the sample sits at the floor, not on the crest');
    assert.ok(dark(none), `Off removes the ${pattern} floor: ${none}`);
  });
}
