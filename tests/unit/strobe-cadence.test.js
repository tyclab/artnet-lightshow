import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { hardwareOf } from '../../src/shared/hardware.ts';
import { hardwareStrobe } from '../../src/shared/hardware-strobe.ts';
import { HardwareGuard } from '../../src/shared/hardware-guard.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';

const HARDWARE = { technologies: {}, products: {} };
const SAFETY = { acknowledged: true, hdFlashIntervalMs: 350 };
const WHITE = { r: 255, g: 255, b: 255 };
const profile = (technology) => ({ id: `cadence-${technology}`, channelCount: 3,
  channelMap: { red: 0, green: 1, blue: 2 }, ...(technology === 'hue' ? { hue: { legacy: true } } : {}) });
const fixture = (technology) => ({ id: 1, address: 1, universe: 0, profileId: `cadence-${technology}`,
  maxBrightness: 255, override: null, output: { protocol: technology }, hue: technology === 'hue' });
const gapsOf = (rises) => rises.slice(1).map((at, i) => at - rises[i]);

test('slower devices join the shared pulse grid and the global flash cap still bounds every device', () => {
  const rgb = hardwareOf(fixture('ddp'), profile('ddp'));
  for (const [cap, every] of [[5, 4], [8, 2]]) {
    const hue = hardwareOf({ ...fixture('hue'), hardware: { maxFlashHz: cap } }, profile('hue'));
    const rises = [], fast = [];
    let previous = 0, fastPrevious = 0;
    for (let k = 0; k < 440; k++) {
      const now = k * FRAME_MS, a = hardwareStrobe(255, rgb, now), b = hardwareStrobe(255, hue, now);
      if (a.level && !fastPrevious) fast.push(k);
      if (b.level && !previous) rises.push(k);
      previous = b.level; fastPrevious = a.level;
      const limitedA = hardwareStrobe(255, rgb, now, 3), limitedB = hardwareStrobe(255, hue, now, 3);
      assert.deepEqual(limitedA, limitedB, 'the slower common request takes priority over hardware capacity');
    }
    assert.deepEqual(rises, fast.filter((_, index) => index % every === 0));
  }
});

for (const origin of [0, 123456.7]) for (const jitter of [0, 2, 6]) {
  test(`mixed room output keeps Hue rises on RGB pulses with ${jitter} ms jitter and clock origin ${origin}`, () => {
    const rgb = profile('ddp'), hue = { ...profile('hue'), channelCount: 7,
      channelMap: { dimmer: 0, red: 1, green: 2, blue: 3, warmWhite: 4, coolWhite: 5, uv: 6 } };
    const fixtures = [fixture('ddp'), { ...fixture('hue'), id: 2, address: 10 }];
    const profiles = { [rgb.id]: rgb, [hue.id]: hue };
    const store = createUniverseStore(allocateShared());
    const renderer = createRenderer({ profileOf: f => profiles[f.profileId], now: origin });
    const input = { running: true, pattern: 'energy.colorStrobe', effect: validateSpec({ kind: 'energy.colorStrobe', palette: ['#FF0000'] }),
      colorA: 0, colorB: 0, colorC: 0, colorD: 0, split: null, pixelMap: 'stage', beatDivision: 1,
      strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null,
      showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures,
      hardware: HARDWARE, safety: SAFETY, hueStrobe: 'flash' };
    let previous = [false, false];
    const rises = [[], []], times = [[], []];
    for (let k = 0; k < 440; k++) {
      const now = origin + k * FRAME_MS + (k ? [0, 1, -.5, -1, .5][k % 5] * jitter : 0);
      renderer.frame(input, { bpm: 144.5, beatPos: now / 60000 * 144.5, epoch: 0 }, now, store, origin);
      const dmx = store.getBuffer(0), bright = [dmx[0], dmx[10]].map(level => level > 255 * .15);
      bright.forEach((on, i) => { if (on && !previous[i]) { rises[i].push(k); times[i].push(now); } });
      previous = bright;
    }
    assert.ok(rises[1].length > 30);
    assert.ok(rises[1].slice(1).every(frame => rises[0].includes(frame)), 'every Hue flash starts on an RGB flash after joining');
    assert.ok(gapsOf(times[1]).every(gap => gap >= 200 - 1e-6), 'Hue keeps its rate limit');
    assert.ok(gapsOf(times[1]).slice(2).every(gap => gap <= 12 * FRAME_MS + 2 * jitter + 1e-6));
  });
}

for (const [technology, capHz, periodFrames] of [['ddp', 20, 3], ['hue', 5, 12]]) {
  test(`${technology}: software strobe plans stable whole-frame pulses below the device cap`, () => {
    const caps = hardwareOf(fixture(technology), profile(technology));
    const guard = new HardwareGuard(), rises = [];
    let previous = 0;
    for (let k = 0; k < 440; k++) {
      const now = k * FRAME_MS, plan = hardwareStrobe(255, caps, now);
      assert.equal(plan.raw, null);
      assert.equal(plan.previewLevel, plan.level);
      const output = guard.apply('lamp', plan.level, now, { ...caps, minTransitionMs: 0 });
      assert.equal(output, plan.level, 'the rate guard never needs to remove a scheduled flash');
      if (output && !previous) rises.push(k);
      previous = output;
    }
    assert.equal(rises.length, Math.ceil(440 / periodFrames));
    assert.ok(gapsOf(rises).every(gap => gap === periodFrames));
    assert.ok(1000 / (periodFrames * FRAME_MS) <= capHz);
  });

  for (const flashLimit of [false, true]) for (const jitter of [0, 2, 6]) for (const colour of ['#FF0000', '#FFFFFF']) {
    test(`${technology}: ${colour} output has no recurring pauses with ${jitter} ms jitter, global limit ${flashLimit}`, () => {
      const p = profile(technology), fixtures = [fixture(technology)];
      const spec = validateSpec({ kind: 'energy.colorStrobe', palette: [colour] });
      const renderer = createRenderer({ profileOf: () => p, profilesRevision: () => 0, now: 0 });
      const store = createUniverseStore(allocateShared()), rises = [];
      const rig = buildRig(fixtures, () => p);
      const preview = createPreviewSampler([
        { timeMs: 0, action: 'patch', data: { pattern: 'energy.colorStrobe', bpm: 144.5, flashLimit } },
        { timeMs: 200 * FRAME_MS, action: 'patch', data: { bpm: 80 } },
      ], null,
        { resolveEffect: () => spec, profiles: { [p.id]: p }, hardware: HARDWARE, safety: SAFETY });
      const input = { running: true, pattern: 'energy.colorStrobe', effect: spec,
        colorA: 0, colorB: 0, colorC: 0, colorD: 0, split: null, pixelMap: 'stage', beatDivision: 1,
        strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null,
        showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures,
        hardware: HARDWARE, safety: SAFETY, hueStrobe: 'flash', flashLimit };
      let previous = false;
      for (let k = 0; k < 440; k++) {
        const now = k * FRAME_MS + (k ? [0, 1, -.5, -1, .5][k % 5] * jitter : 0);
        const bpm = k < 200 ? 144.5 : 80;
        renderer.frame(input, { bpm, beatPos: now / 60000 * bpm + (k < 200 ? 0 : 1000), epoch: 0 }, now, store, 0);
        const output = [...store.getBuffer(0).subarray(0, 3)], bright = Math.max(...output) > 255 * .15;
        if (bright && !previous) rises.push(now);
        previous = bright;
        if (!jitter) {
          const visible = preview(now, fixtures, [WHITE], rig)[0];
          for (const [channel, key] of ['r', 'g', 'b'].entries()) assert.ok(Math.abs(output[channel] - visible[key]) <= 1,
            `${technology} frame ${k}, global limit ${flashLimit}: output ${output[channel]}, preview ${visible[key]}`);
        }
      }
      const frames = flashLimit ? 16 : periodFrames, rateCap = flashLimit ? 3 : capHz;
      const gaps = gapsOf(rises).slice(2), period = frames * FRAME_MS;
      assert.ok(rises.length >= Math.floor(440 / frames) - 2, `${rises.length} flashes`);
      assert.ok(gaps.every(gap => gap >= 1000 / rateCap - 1e-6), 'the output rate guard remains effective');
      assert.ok(gaps.every(gap => gap <= period + 2 * jitter + FRAME_MS + 1e-6), `longest gap ${Math.max(...gaps)}`);
    });
  }
}
