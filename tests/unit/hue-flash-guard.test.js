import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { HardwareGuard } from '../../src/shared/hardware-guard.ts';
import { hueLightMeasure } from '../../src/shared/hue-light.ts';
import { hueSectionColour } from '../../src/shared/hue-colour.ts';
import { effectNeeds } from '../../src/shared/effects/hardware.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { HUE_COLOR, HUE_WHITE, HUE_AMBIANCE, HUE_GRADIENT } from './hue-test-lamps.js';
import '../../src/shared/effects/index.ts';

const hardware = { technologies: {}, products: {} };
const safety = { acknowledged: true, hdFlashIntervalMs: 350 };
const look = { pattern: 'solid', colorA: 14, colorB: 5, colorC: 0, colorD: 5, beatDivision: 1 };
const base = { ...look, running: true, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
  fade: null, syncTest: null, universes: [0], hardware, safety };
const mapsOf = (profile) => profile.cells?.map((cell) => cell.channelMap) ?? [profile.channelMap];
const fixtureOf = (profile, minTransitionMs = 0) => ({ id: 0, profileId: profile.id, address: 1, universe: 0,
  maxBrightness: 255, override: null, output: { protocol: 'hue', bridge: 'test', channels: mapsOf(profile).map((_, i) => i) },
  hardware: { maxFlashHz: 1, minTransitionMs } });
const program = (fn, extra = {}, palette = ['#FFFFFFFF']) => validateSpec({ kind: 'strobe', palette,
  params: { function: fn, speed: 255, continueBetween: false, ...extra } });
const voiceOf = (spec, launchSeq = 1, startedAtMs = 0) => ({ id: 'strobe', tier: 'strobe', spec, launchSeq,
  targets: null, startedAtMs, untilMs: null, anchorBeat: 0, seed: seedFrom('strobe') });
const wire = (profile, store) => mapsOf(profile).map((ch) => ({ ...hueSectionColour(ch,
  (offset) => offset === undefined ? 0 : store.getBuffer(0)[offset], profile.hue), w: 0, a: 0, uv: 0 }));

function trace(profile, patch, minTransitionMs = 0, duration = 10000) {
  const fixture = fixtureOf(profile, minTransitionMs), store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: () => profile, now: 0 });
  const frames = [];
  for (let k = 0; k * FRAME_MS < duration; k++) {
    const t = k * FRAME_MS, current = typeof patch === 'function' ? patch(t, k) : patch;
    renderer.frame({ ...base, fixtures: [fixture], ...current }, { beatPos: t / 300, bpm: 200, epoch: 0 }, t, store, 0);
    frames.push({ t, lights: wire(profile, store) });
  }
  return frames;
}

function assertRate(frames, visible = true) {
  const rises = frames[0].lights.map(() => []), previous = rises.map(() => false);
  for (const { t, lights } of frames) lights.forEach((light, i) => {
    const bright = Math.max(light.r, light.g, light.b) > 255 * .15;
    if (bright && !previous[i]) rises[i].push(t);
    previous[i] = bright;
  });
  for (const [cell, times] of rises.entries()) {
    if (visible) assert.ok(times.length > 0, `cell ${cell} emits visible light`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1000 - 1e-6,
      `cell ${cell}: visible rises ${times[i - 1]} and ${times[i]} are less than one second apart`);
  }
}

test('program admission uses its maximum curve rate independently of palette strobe settings', () => {
  assert.equal(effectNeeds(program('palette', { flashesPerSecond: 2 }), 200).flashHz, 2);
  for (const fn of ['ramp-up', 'ramp-down', 'ramp-up-down', 'random', 'break']) {
    assert.equal(effectNeeds(program(fn, { flashesPerSecond: 1 }), 200).flashHz, 5);
  }
});

for (const profile of [HUE_COLOR, HUE_GRADIENT]) {
  test(`${profile.modeName}: mixed RGB+white curves respect the physical one-flash limit`, () => {
    for (const fn of ['ramp-up', 'ramp-down', 'ramp-up-down', 'random', 'break']) {
      for (const flashLimit of [false, true]) {
        assertRate(trace(profile, { voices: [voiceOf(program(fn))], flashLimit }));
      }
    }
  });
  test(`${profile.modeName}: rapid voice replacements retain mixed-light flash history`, () => {
    for (const minTransitionMs of [0, 80, 600]) for (const fn of ['ramp-up-down', 'ramp-down']) {
      assertRate(trace(profile, (t) => ({ voices: Math.floor(t / 100) % 2 ? [] : [voiceOf(program(fn,
        { speed: 1, brightness: .1 }), Math.floor(t / 100) + 1)] }), minTransitionMs), minTransitionMs === 0);
    }
  });
}

for (const profile of [HUE_COLOR, HUE_WHITE, HUE_AMBIANCE, HUE_GRADIENT]) {
  test(`${profile.modeName}: standard, program, palette, master and blackout handovers share final admission`, () => {
    assertRate(trace(profile, (t) => {
      const step = Math.floor(t / 170), fn = ['standard', 'ramp-up', 'palette'][step % 3];
      return { pattern: 'strobe', colorA: 9, strobeFunction: fn, strobeSpeed: 255,
        masterDimmer: step % 5 === 0 ? 18 : 255, masterBlackout: step % 7 === 0,
        voices: fn === 'palette' ? [voiceOf(program('palette', { brightness: .2 }, ['#FFFFFFFF', '#FF0000FF']), step)] : [] };
    }, 80));
  });
}

test('identification shares Hue admission with show output, including its explicit blackout override', () => {
  for (const masterBlackout of [false, true]) assertRate(trace(HUE_COLOR, (t) => ({ pattern: 'strobe', colorA: 9,
    strobeFunction: 'ramp-down', strobeSpeed: 255, masterBlackout,
    identify: { seq: Math.floor(t / 300) + 1, ids: Math.floor(t / 300) % 2 ? [0] : [], at: t, ms: 150 } }), 80));
});

test('ordinary blackout immediately clears Hue output through transitions', () => {
  const frames = trace(HUE_GRADIENT, (t) => ({ voices: [voiceOf(program('ramp-down'))],
    masterBlackout: Math.floor(t / 100) % 7 === 0 }), 80);
  for (const { t, lights } of frames) if (Math.floor(t / 100) % 7 === 0) {
    assert.ok(lights.every(({ r, g, b }) => r + g + b === 0), `blackout at ${t}`);
  }
  assertRate(frames);
});

test('measured admission records actual quantized crossings after long transitions and clipped mixes', () => {
  const profile = HUE_COLOR, measure = hueLightMeasure(profile, profile.channelMap);
  const guard = new HardwareGuard(), limits = { maxFlashHz: 1, minTransitionMs: 700 };
  const mixed = { r: 255, g: 255, b: 255, w: 255, a: 255, uv: 255 };
  let previous = false, lastRise = -Infinity, rises = 0;
  for (let k = 0; k < 880; k++) {
    const t = k * FRAME_MS, on = k % 37 < 20;
    const result = guard.light('lamp', mixed, on ? 255 : 0, t, limits, `voice:${Math.floor(k / 19)}`, false, measure);
    const bright = measure(result.colour, result.dim, 1) > .15;
    if (bright && !previous) { assert.ok(t - lastRise >= 1000 - 1e-6); lastRise = t; rises++; }
    previous = bright;
  }
  assert.ok(rises > 1);
});

test('generated Hue mixed-light program rehearsal matches emitted RGB and backwards seeks', () => {
  for (const profile of [HUE_COLOR, HUE_GRADIENT]) {
    const fixture = fixtureOf(profile, 80), spec = program('ramp-up-down', { brightness: .3 });
    const frames = trace(profile, { voices: [voiceOf(spec)] }, 80, 3000);
    const sample = createPreviewSampler([
      { timeMs: 0, action: 'patch', data: { ...look, bpm: 200 } },
      { timeMs: 0, action: 'voice', data: { id: 'strobe', tier: 'strobe', launchSeq: 1, effect: spec, targets: 'shared', seed: seedFrom('strobe') } },
    ], { beats: Array.from({ length: 51 }, (_, i) => i * .3) }, { hardware, safety, profiles: { [profile.id]: profile } });
    const rig = buildRig([fixture], () => profile);
    for (const frame of [...frames, ...frames.toReversed()]) {
      assert.deepEqual(sample(frame.t, [fixture], COLOR_PRESETS, rig), frame.lights, `${profile.modeName} at ${frame.t}`);
    }
    assertRate(frames);
  }
});

test('rapid mixed-palette voice handovers keep emitted Hue RGB and rehearsal history aligned', () => {
  const profile = HUE_GRADIENT, fixture = fixtureOf(profile), events = [{ timeMs: 0, action: 'patch', data: { ...look, bpm: 200 } }];
  const specs = [program('ramp-down', { brightness: .1, speed: 1 }),
    program('ramp-up-down', { brightness: .1, speed: 1 }, ['#FF0000FF'])];
  for (let step = 0; step < 28; step++) {
    const timeMs = step * 5 * FRAME_MS;
    events.push(step % 2 ? { timeMs, action: 'voice-end', data: { id: 'strobe' } }
      : { timeMs, action: 'voice', data: { id: 'strobe', tier: 'strobe', launchSeq: step + 1,
        effect: specs[Math.floor(step / 2) % 2], targets: 'shared', seed: seedFrom('strobe') } });
  }
  const frames = trace(profile, (_t, k) => {
    const step = Math.floor(k / 5);
    return { voices: step % 2 ? [] : [{ ...voiceOf(specs[Math.floor(step / 2) % 2], step + 1, step * 5 * FRAME_MS),
      anchorBeat: step * 5 * FRAME_MS / 300 }] };
  }, 0, 3000);
  const sample = createPreviewSampler(events, { beats: Array.from({ length: 51 }, (_, i) => i * .3) },
    { hardware, safety, profiles: { [profile.id]: profile } });
  const rig = buildRig([fixture], () => profile);
  for (const { t, lights } of [...frames, ...frames.toReversed()]) assert.deepEqual(sample(t, [fixture], COLOR_PRESETS, rig), lights, `handover at ${t}`);
  assertRate(frames);
});
