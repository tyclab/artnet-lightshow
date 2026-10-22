import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRenderer } from '../src/server/renderer.ts';
import { createUniverseStore } from '../src/server/universes.ts';
import { V2_PRESETS } from '../src/shared/effects/v2/presets.ts';
import { validateSpec } from '../src/shared/effects/registry.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM, DEMO_DURATION_MS } from '../src/shared/demo-track.ts';
import { runtimeRig } from '../tests/helpers/runtime-rig.js';

const { fixtures, profileOf, rig, space, base } = runtimeRig();
assert.equal(rig.units.length, 3000);
const ids = new Set(['v2.scatterFade', 'v2.rotation', 'v2.rain.2d', 'v2.speakerShockwave', 'v2.noise', 'v2.stemsSpace', 'v2.visualizerDrift']);
const rows = V2_PRESETS.filter((p) => process.argv.includes('--all') || ids.has(p.id));
for (const mode of ['orbs', 'rain', 'fireworks']) for (const radiusM of [1, 5]) {
  rows.push({ id: `maximum ${mode} radius ${radiusM}`, spec: validateSpec({ kind: 'v2.particles',
    params: { mode, count: 64, trail: 8, radiusM } }) });
}
const secondsArg = process.argv.find((arg) => arg.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 32;
assert.ok(Number.isFinite(seconds) && seconds >= 8 && seconds <= 120, '--seconds must be between 8 and 120');
const switching = process.argv.includes('--switches');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const selected = only ? rows.filter((row) => row.id === only) : rows;
assert.ok(selected.length, '--only must name a selected preset; use --all for the full catalogue');
const sharedRenderer = switching ? createRenderer({ profileOf, now: 0 }) : null;
let totalFrames = 0;
function summary(samples) {
  const times = samples.map((sample) => sample.wall).sort((a, b) => a - b);
  const percentile = (p) => +times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(3);
  return { frames: samples.length, meanCpuMs: +(samples.reduce((sum, sample) => sum + sample.cpu, 0) / samples.length).toFixed(3),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: percentile(1),
    overFrameBudget: times.filter((ms) => ms > 1000 / 44).length };
}
for (const preset of selected) {
  const mode = switching && totalFrames > 0 ? 'switch-existing-renderer' : 'new-renderer';
  const renderer = sharedRenderer ?? createRenderer({ profileOf, now: 0 }), store = createUniverseStore();
  renderer.setSpace(space);
  const input = { ...base, pattern: preset.id, effect: preset.spec };
  const samples = [];
  let activeFrames = 0;
  for (let frame = 0; frame < Math.ceil(seconds * 44); frame++) {
    const now = (switching ? totalFrames++ : frame) * 1000 / 44, demoAt = now % DEMO_DURATION_MS;
    // Production worker snapshots are new objects; reference-only caches must not make this benchmark cheaper.
    input.fixtures = structuredClone(fixtures);
    input.audio = DEMO_AUDIO_SOURCE.frameAt(demoAt);
    input.modulation = DEMO_AUDIO_SOURCE.modulationAt(demoAt);
    input.pictureFeatures = { ...DEMO_AUDIO_SOURCE.pictureAt(demoAt), expiresAt: now + 1000 };
    const cpu0 = process.cpuUsage(), start = performance.now();
    renderer.frame(input, { beatPos: now * DEMO_BPM / 60000, bpm: DEMO_BPM, epoch: 0 }, now, store);
    const elapsed = performance.now() - start, used = process.cpuUsage(cpu0);
    samples.push({ wall: elapsed, cpu: (used.user + used.system) / 1000 });
    // This synthetic rig has exclusively RGB channels: there are no mode bytes that could fake light.
    if (base.universes.some((u) => store.getBuffer(u).some((value) => value > 0))) activeFrames++;
  }
  assert.ok(activeFrames, `${preset.id} must render visible bytes`);
  console.log(JSON.stringify({ id: preset.id, mode,
    units: rig.units.length, activeFrames, firstFrameMs: +samples[0].wall.toFixed(3), allFrames: summary(samples),
    firstSecond: summary(samples.slice(0, 44)), afterFirstSecond: summary(samples.slice(44)) }));
}
