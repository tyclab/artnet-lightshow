import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { OutputGuard } from '../../src/shared/output-guard.ts';

const FRAME_MS = 1000 / 44;
const profile = { id: 'continuity-audit', channelCount: 6,
  channelMap: { red: 0, green: 1, blue: 2, white: 3, amber: 4, uv: 5 } };
const fixtures = [1, 2].map((id) => ({ id, address: (id - 1) * 6 + 1, universe: 0, profileId: profile.id,
  position: { x: id * 30, y: 50 }, maxBrightness: 255, output: { protocol: 'ddp' } }));
const specs = [validateSpec({ kind: 'v2.wash', palette: ['#FFFFFFFFFFFF'] }),
  validateSpec({ kind: 'strobe', palette: ['#FFFFFFFFFFFF'], params: { clock: 'wall', flashesPerSecond: 5, continueBetween: false } })];

function trace(mode, blackout = false) {
  const makeRenderer = () => createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  let renderer = makeRenderer(), previous = false;
  const store = createUniverseStore(allocateShared()), rises = [];
  for (let tick = 0; tick < 176; tick++) {
    const now = tick * FRAME_MS, on = tick % 2 === 0, launch = Math.floor(tick / 2);
    const voice = { id: `launch-${launch}`, spec: specs[launch % 2], targets: [1], tier: 'voice',
      launchSeq: launch + 1, startedAtMs: now, untilMs: null, anchorBeat: now / 500, seed: [1, 2, 3, 4] };
    let patch = fixtures;
    if (mode === 'geometry') patch = fixtures.map((f) => ({ ...f, position: { ...f.position, x: f.position.x + tick % 2 } }));
    if (mode === 'order' && launch % 2) patch = [...fixtures].reverse();
    if (mode === 'remove' && !on) patch = [];
    if (mode === 'fresh') renderer = makeRenderer();
    const input = { running: true, pattern: 'solid', basePalette: { colours: ['#000000'] },
      colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120, split: null, pixelMap: 'stage', beatDivision: 1,
      strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: blackout && !on,
      energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures: patch,
      safety: { acknowledged: true, hdFlashIntervalMs: 350 }, voices: on || blackout ? [voice] : [] };
    renderer.frame(input, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, mode === 'grid' ? tick % 2 * 5 : 0);
    const bytes = [...store.getBuffer(0).slice(0, 6)], bright = bytes.some((byte) => byte > 140);
    assert.deepEqual([...store.getBuffer(0).slice(6, 12)], [0, 0, 0, 0, 0, 0], 'untargeted physical fixture stays dark after reorder');
    if (bright && !previous) rises.push(tick);
    previous = bright;
  }
  return rises;
}

for (const mode of ['fixed', 'grid', 'geometry', 'order', 'remove']) for (const blackout of [false, true]) {
  test(`emitted cross-voice flash history survives ${mode} changes with ${blackout ? 'blackout' : 'empty'} gaps`, () => {
    const rises = trace(mode, blackout);
    assert.ok(rises.length >= 6, `enough emitted rises to exercise a complete rolling window: ${rises}`);
    for (let i = 5; i < rises.length; i++) assert.ok(rises[i] - rises[i - 5] >= 44, `at most five emitted rises in a rolling second: ${rises}`);
  });
}

test('the emitted-byte probe requests more than five rises if every launch loses its history', () => {
  const rises = trace('fresh');
  assert.ok(rises.filter((tick) => tick < 44).length > 5, 'positive control exposes unsafe resets instead of passing on a dark fixture');
});

for (const interval of [350, 3000]) test(`removed lamp histories expire after the ${Math.max(1000, interval)} ms safety window`, () => {
  const guard = new OutputGuard(interval), window = Math.max(1000, interval);
  guard.effectLevel('removed:0', 255, 1, 'v2.wash', 0);
  guard.retainEffects(new Set(['active:0']));
  guard.effectLevel('active:0', 0, 1, null, interval / 2);
  assert.equal(guard.effectLevel('removed:0', 255, 1, 'v2.wash', interval / 2), 0, 'remove/re-add retains the previous bright rise');
  guard.retainEffects(new Set(['active:0']));
  guard.effectLevel('active:0', 0, 1, null, window);
  assert.equal(guard.retainedEffectUnits, 2, 'a recent removed fixture remains guarded');
  guard.effectLevel('active:0', 0, 1, null, window * 2 + 1000);
  assert.equal(guard.retainedEffectUnits, 1, 'expired fixture identities are retired instead of accumulating across patches');
});
