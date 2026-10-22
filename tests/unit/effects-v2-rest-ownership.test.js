import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { audioOf } from '../helpers/v2-frames.js';

const names = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const profile = { id: 'rest-audit-strip', channelCount: 48, channelMap: {},
  cells: Array.from({ length: 8 }, (_, i) => ({ channelMap: Object.fromEntries(names.map((name, k) => [name, i * 6 + k])) })) };
const fixtures = [1, 2].map((id, i) => ({ id, address: i * 48 + 1, universe: 0, profileId: profile.id,
  maxBrightness: 255, position: { x: 20 + i * 60, y: 50 }, geometry: { length: 60, angle: 45 }, output: { protocol: 'ddp' } }));
const rig = buildRig(fixtures, () => profile), space = buildUnitSpace(rig, null);
const safety = { acknowledged: true, hdFlashIntervalMs: 350 };
const colours = [{ r: 255, g: 0, b: 0, w: 127, a: 63, uv: 31 }];
const look = { pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120,
  basePalette: { colours: ['#FF00007F3F1F'] }, beatDivision: 1, split: null, pixelMap: 'stage' };
const black = [0, 0, 0, 0, 0, 0], base = [255, 0, 0, 127, 63, 56];

function players(spec, targets = [1], reactive = false) {
  spec = { ...spec, palette: ['#00FFFF'] };
  const voice = { id: 'rest-audit', spec, targets, tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  renderer.setSpace(space);
  const store = createUniverseStore(allocateShared());
  const input = { ...look, running: true, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255,
    masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
    universes: [0], fixtures, safety, voices: [voice], audioMode: reactive ? 'reactive' : 'tempo', audio: reactive ? audioOf() : null };
  const preview = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: look },
    { timeMs: 0, action: 'voice', data: { ...voice, effect: spec, targets: targets ?? 'shared' } },
  ], null, { profiles: { [profile.id]: profile }, space, safety, ...(reactive ? { audioSource: { frameAt: () => audioOf() } } : {}) });
  return (tick) => {
    const now = tick * (1000 / 44);
    renderer.frame(input, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, 0);
    const bytes = store.getBuffer(0), visible = preview(now, fixtures, colours, rig);
    const out = rig.units.map(({ fixture, cell }, u) => {
      const wire = [...bytes.slice(fixtures[fixture].address - 1 + cell * 6, fixtures[fixture].address - 1 + cell * 6 + 6)];
      const shown = ['r', 'g', 'b', 'w', 'a', 'uv'].map((key) => visible[u][key] ?? 0);
      wire.forEach((value, channel) => assert.ok(Math.abs(value - shown[channel]) <= 1, `preview parity: frame ${tick}, unit ${u}, channel ${channel}`));
      return wire;
    });
    out.slice(8).forEach((wire) => assert.deepEqual(wire, base, 'untargeted fixture retains its base including auxiliary emitters'));
    return out.slice(0, 8);
  };
}

test('default Neural silence owns black above a red base, including auxiliary emitters', () => {
  const draw = players(presetById('v2.neural').spec, [1], true);
  for (let tick = 0; tick < 44; tick++) draw(tick).forEach((wire) => assert.deepEqual(wire, black));
});

for (const id of ['v2.scatterStrobe', 'v2.beacon', 'v2.grooveWave']) test(`${id} native spatial rests stay black inside a targeted voice`, () => {
  const draw = players(presetById(id).spec);
  let dark = 0, active = 0, mixed = 0;
  for (let tick = 0; tick < 176; tick++) {
    const rows = draw(tick), rest = rows.filter((wire) => wire.every((byte) => byte === 0)).length;
    dark += rest; active += rows.length - rest;
    if (rest > 0 && rest < rows.length) mixed++;
    rows.forEach((wire) => assert.notDeepEqual(wire, base, 'no selected cell leaks the underlying base colour'));
  }
  assert.ok(dark > 0 && active > 0, `${id}: ${dark} resting and ${active} active cell samples`);
  assert.ok(mixed > 0, `${id}: active and resting cells coexist within the fixture`);
});

test('an explicit strobe overlay still reveals the base between its flash and black gap', () => {
  const spec = validateSpec({ kind: 'strobe', params: { clock: 'wall', flashesPerSecond: 2, continueBetween: true } });
  const draw = players(spec);
  draw(0).forEach((wire) => assert.ok(wire[1] > 0));
  draw(6).forEach((wire) => assert.deepEqual(wire, black, 'the required black gap owns darkness'));
  draw(14).forEach((wire) => assert.deepEqual(wire, base, 'the explicit transparent interval preserves its base'));
});
