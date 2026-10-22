// Serial CPU regression checks, including first frames. The separate runtime
// trace reports wall-time overruns; an average CPU budget cannot certify deadlines.

import test from 'node:test';
import assert from 'node:assert';

import { state } from '../../src/server/state.ts';
import { renderFrame, resizeFixtureBuffers } from '../../src/server/engine.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';

const CELLS = 16;

// What calibrate() takes on a quiet machine, in ms of CPU: a 2024 desktop core
// does it in about 2. A slower machine or a busy one scales the budget up by
// the ratio; a faster one never scales it down below the 8 ms it is written for.
const QUIET_CALIBRATION_MS = 2;
const FRAME_BUDGET_MS = 8;

/** CPU ms for a fixed piece of arithmetic, the cheapest of a few tries. */
function calibrate(tries = 5) {
  let best = Infinity;
  let sink = 0;
  for (let t = 0; t < tries; t++) {
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 1_000_000; i++) sink += Math.sqrt(i) * 1e-9;
    const used = process.cpuUsage(cpu0);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  if (sink < 0) throw new Error('unreachable');
  return best;
}
const BAR = {
  id: 'budget-bar-16', name: 'Budget bar', channelCount: 2 + CELLS * 4,
  channelMap: { dimmer: 0, strobe: 1 },
  cells: Array.from({ length: CELLS }, (_, i) => ({
    channelMap: { red: 2 + i * 4, green: 3 + i * 4, blue: 4 + i * 4, white: 5 + i * 4 },
  })),
};

test('a thousand cells stay within the calibrated mean CPU budget', () => {
  registerProfile(BAR);
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  let beat = 0;
  conductor.setProlinkSource(() => ({ beatPos: beat, bpm: 128 }));
  state.artnet.enabled = false;
  try {
    const perUniverse = Math.floor(512 / BAR.channelCount);
    state.fixtures = Array.from({ length: 64 }, (_, i) => ({
      id: i, label: `Bar ${i + 1}`, profileId: BAR.id, maxBrightness: 255, override: null,
      universe: Math.floor(i / perUniverse), address: 1 + (i % perUniverse) * BAR.channelCount,
      position: { x: 5 + (i % 16) * 6, y: 20 + Math.floor(i / 16) * 20 },
    }));
    resizeFixtureBuffers();

    const timings = {};
    const run = (label, patch, frames = 80, batches = 5) => {
      applyPatch({ running: true, masterDimmer: 255, masterBlackout: false, colorA: 1, colorB: 5, colorC: 3, colorD: 8, ...patch });
      const ms = [];
      let cpu = 0;
      for (let b = 0; b < batches; b++) {
        const cpu0 = process.cpuUsage();
        for (let f = 0; f < frames; f++) {
          beat += 0.1;
          const t0 = performance.now();
          renderFrame();
          ms.push(performance.now() - t0);
        }
        const used = process.cpuUsage(cpu0);
        cpu += (used.user + used.system) / 1000 / frames / batches;
      }
      ms.sort((a, b) => a - b);
      timings[label] = {
        cpu,
        mean: ms.reduce((a, b) => a + b, 0) / ms.length,
        p95: ms[Math.floor(ms.length * 0.95)],
      };
    };

    const calibration = calibrate();
    run('startup', { pattern: 'solid' }, 20, 1);
    run('wave', { pattern: 'wave' });
    run('ribbon', { pattern: 'ribbon', showDynamics: { level: 0.8, width: 0.6, air: 0.5, motion: 0.6 } });
    run('chase', { pattern: 'chase', showDynamics: null });
    run('twinkle', { pattern: 'twinkle' });
    run('gradient', { pattern: 'gradient', pixelMap: 'stage' });
    run('plasma', { pattern: 'plasma', pixelMap: 'mirror' });
    run('comet', { pattern: 'comet', pixelMap: 'bar' });
    run('two-part', { pattern: 'hit', pixelPattern: 'impact', pixelMap: 'stage' });
    run('crossfade', { pattern: 'wave', colorA: 6, fadeMs: 5000 });

    const slowdown = Math.max(1, calibration / QUIET_CALIBRATION_MS);
    const budget = FRAME_BUDGET_MS * slowdown;
    console.log(`[budget] ${state.fixtures.length} bars × ${CELLS} cells; calibration ${calibration.toFixed(2)} ms, budget ${budget.toFixed(1)} ms:`);
    for (const [label, { cpu, mean, p95 }] of Object.entries(timings)) {
      console.log(`[budget]   ${label.padEnd(10)} cpu ${cpu.toFixed(2)} ms  wall mean ${mean.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms`);
      assert.ok(cpu < budget, `${label} takes ${cpu.toFixed(2)} ms of CPU a frame on average, over ${budget.toFixed(1)} ms (machine ${slowdown.toFixed(1)}× slower than quiet)`);
    }
  } finally {
    conductor.setProlinkSource(null);
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    resizeFixtureBuffers();
    unregisterProfile(BAR.id);
  }
});

// Mixed DDP, OpenRGB and Hue capabilities exercise the real hardware guards as well as every generator.
test('three thousand lights keep every Spatial preset within the calibrated mean CPU budget', async () => {
  const { createRenderer } = await import('../../src/server/renderer.ts');
  const universes = await import('../../src/server/universes.ts');
  const { V2_PRESETS } = await import('../../src/shared/effects/v2/presets.ts');
  const { DEMO_AUDIO_SOURCE, DEMO_BPM } = await import('../../src/shared/demo-track.ts');
  const { runtimeRig } = await import('../helpers/runtime-rig.js');
  const { profileOf, rig, space, base } = runtimeRig();
  assert.equal(rig.units.length, 3000);
  const calibration = calibrate();
  const slowdown = Math.max(1, calibration / QUIET_CALIBRATION_MS);
  const budget = FRAME_BUDGET_MS * slowdown;
  const timings = [];
  // Beside the presets, the costliest Shell a spec allows: slow rings launched every sixteenth live long.
  const { validateSpec } = await import('../../src/shared/effects/registry.ts');
  const slowShell = (space, origin) => ({ id: `slow shell ${space} ${origin}`, spec: validateSpec({ kind: 'v2.shell',
    params: { space, origin, speed: 0.05, width: 0.3, trigger: { mode: 'timeline', band: 'full', beatInterval: 1 / 16, threshold: 0.15, reactiveDepth: 1 } } }) });
  const rows = [...V2_PRESETS, slowShell('room', 'anchor'), slowShell('plan', 'anchor'), slowShell('room', 'random'),
    { id: 'room-limited wash', flashLimit: true, spec: validateSpec({ kind: 'v2.wash', palette: ['#FFFFFF'],
      params: { shape: 'envelope', cycleBeats: 0.25, envelope: { attack: 0, hold: 0.04, release: 0.02, curve: 'linear' } } }) }];
  for (const preset of rows) {
    const renderer = createRenderer({ profileOf, now: 0 });
    renderer.setSpace(space);
    const store = universes.createUniverseStore(universes.allocateShared());
    const input = { ...base, pattern: preset.id, effect: preset.spec, audioMode: 'reactive', flashLimit: !!preset.flashLimit,
      safety: { acknowledged: true, hdFlashIntervalMs: preset.flashLimit ? 0 : 350 } };
    let frameIndex = 0, cpu = 0, activeFrames = 0;
    const wall = [];
    const frame = () => {
      const now = frameIndex++ * 1000 / 44, beat = now * DEMO_BPM / 60000;
      input.audio = DEMO_AUDIO_SOURCE.frameAt(now);
      input.modulation = DEMO_AUDIO_SOURCE.modulationAt(now);
      input.pictureFeatures = DEMO_AUDIO_SOURCE.pictureAt(now);
      const start = performance.now();
      renderer.frame(input, { beatPos: beat, bpm: DEMO_BPM, epoch: 0 }, now, store);
      wall.push(performance.now() - start);
      if (base.universes.some((u) => store.getBuffer(u).some((value) => value > 0))) activeFrames++;
    };
    for (let b = 0; b < 4; b++) {
      const cpu0 = process.cpuUsage();
      for (let f = 0; f < 36; f++) frame();
      const used = process.cpuUsage(cpu0);
      cpu += (used.user + used.system) / 1000 / 144;
    }
    assert.ok(activeFrames > 0, `${preset.id}: the measured path must write visible bytes`);
    wall.sort((a, b) => a - b);
    timings.push([preset.id, cpu, wall[Math.floor(wall.length * 0.95)]]);
  }
  timings.sort((a, b) => b[1] - a[1]);
  console.log(`[budget] 3,000 lights in a room; calibration ${calibration.toFixed(2)} ms, budget ${budget.toFixed(1)} ms; slowest Spatial presets:`);
  for (const [id, cpu, p95] of timings.slice(0, 5)) console.log(`[budget]   ${id.padEnd(24)} cpu ${cpu.toFixed(2)} ms wall p95 ${p95.toFixed(2)} ms`);
  for (const [id, cpu] of timings) assert.ok(cpu < budget, `${id} takes ${cpu.toFixed(2)} ms of CPU a frame, over ${budget.toFixed(1)} ms (machine ${slowdown.toFixed(1)}× slower than quiet)`);
});
