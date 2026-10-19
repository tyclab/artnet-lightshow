import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { DRAWN_STROBE_FUNCTIONS } from '../../src/shared/strobe-fx.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { StrobeLampGuard } from '../../src/shared/effects/flash-guard.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import '../../src/shared/effects/index.ts';

const profile = { id: 'rgb', channelCount: 4, channelMap: { red: 0, green: 1, blue: 2, dimmer: 3 } };
const input = () => ({ running: true, pattern: 'strobe', colorA: 0, colorB: 5, colorC: 0, colorD: 5,
  beatDivision: 1, split: null, pixelMap: 'stage', strobeSpeed: 255, strobeFunction: 'random', masterDimmer: 255,
  masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  universes: [0], hardware: { technologies: {}, products: {} }, safety: { acknowledged: true, hdFlashIntervalMs: 350 },
  fixtures: [{ id: 0, address: 1, universe: 0, profileId: profile.id, maxBrightness: 255, override: null,
    hardware: { maxFlashHz: 1, minTransitionMs: 0 } }] });

function trace(patch, duration = 10000) {
  const renderer = createRenderer({ profileOf: () => profile, now: 0 });
  const store = createUniverseStore(allocateShared()), rises = [];
  let last = false;
  for (let k = 0; k * FRAME_MS < duration; k++) {
    const now = k * FRAME_MS, current = { ...input(), ...(typeof patch === 'function' ? patch(now) : patch) };
    renderer.frame(current, { beatPos: now / 300, bpm: 200, epoch: 0 }, now, store, 0);
    const dmx = store.getBuffer(0), bright = dmx[3] * dmx[0] / 255 > 255 * .15;
    if (bright && !last) rises.push(now);
    last = bright;
  }
  return { rises, dmx: store.getBuffer(0) };
}

for (const fn of DRAWN_STROBE_FUNCTIONS) {
  test(`${fn} obeys the device's one-flash limit with and without the global limiter`, () => {
    for (const flashLimit of [false, true]) {
      const { rises } = trace({ strobeFunction: fn, flashLimit });
      assert.ok(rises.length > 0 && rises.length <= 10, `${rises.length} rises`);
      for (let i = 1; i < rises.length; i++) assert.ok(rises[i] - rises[i - 1] >= 1000 - 1e-6);
    }
  });
}

test('drawn programs and palette voices share device history across replacements', () => {
  const { rises } = trace((now) => ({ pattern: 'solid', voices: [{ id: 'strobe', tier: 'strobe', launchSeq: Math.floor(now / 350),
    spec: validateSpec({ kind: 'strobe', palette: ['#FFFFFF'], params: { function: ['break', 'random', 'palette'][Math.floor(now / 350) % 3], speed: 255, continueBetween: false } }),
    targets: null, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('strobe') }] }));
  assert.ok(rises.length <= 10);
  for (let i = 1; i < rises.length; i++) assert.ok(rises[i] - rises[i - 1] >= 1000 - 1e-6);
});

test('drawn programs cannot brighten a blackout frame', () => {
  assert.ok(trace({ masterBlackout: true }, 300).dmx.every((v) => v === 0));
});

test('program ramps and palette flashes share lamp admission without flattening an admitted ramp', () => {
  const guard = new StrobeLampGuard();
  assert.equal(guard.apply(0, .2, 0, true), .2);
  assert.equal(guard.apply(0, .8, 1, true), .8);
  guard.clear(0);
  assert.equal(guard.apply(0, 1, 2), 0, 'palette handover cannot get an early permit');
  guard.clear(0);
  assert.equal(guard.apply(0, .5, 3, true), 0, 'program handover cannot get an early permit');
  guard.clear(0);
  assert.equal(guard.apply(0, .5, 10, true), .5);
});

for (const cells of [1, 3]) {
  test(`Hue ${cells === 1 ? 'bulbs and spots' : 'gradient strip sections'} run software programs within device limits`, () => {
    const maps = Array.from({ length: cells }, (_, i) => ({ red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 }));
    const hueProfile = { id: 'hue-program-test', hue: {}, channelCount: cells * 3,
      channelMap: cells === 1 ? maps[0] : {}, ...(cells > 1 ? { cells: maps.map((channelMap) => ({ channelMap })) } : {}) };
    for (const function_ of ['ramp-up', 'random', 'break']) {
      const renderer = createRenderer({ profileOf: () => hueProfile, now: 0 });
      const store = createUniverseStore(allocateShared());
      const config = input();
      config.strobeFunction = function_;
      config.fixtures[0] = { ...config.fixtures[0], profileId: hueProfile.id, hue: true, output: { protocol: 'hue', bridge: 'test', channel: 0 },
        emission: { kind: cells === 1 ? 'beam' : 'strip' } };
      const rises = maps.map(() => []), previous = maps.map(() => false);
      for (let frame = 0; frame < 440; frame++) {
        const now = frame * FRAME_MS;
        renderer.frame(config, { beatPos: now / 300, bpm: 200, epoch: 0 }, now, store, 0);
        maps.forEach((map, i) => {
          const bright = store.getBuffer(0)[map.red] > 255 * .15;
          if (bright && !previous[i]) rises[i].push(now);
          previous[i] = bright;
        });
      }
      for (const unit of rises) {
        assert.ok(unit.length > 0 && unit.length <= 10, `${function_}: ${unit.length} rises`);
        for (let i = 1; i < unit.length; i++) assert.ok(unit[i] - unit[i - 1] >= 1000 - 1e-6);
      }
    }
  });
}
