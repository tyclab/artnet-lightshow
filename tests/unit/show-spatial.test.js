import test from 'node:test';
import assert from 'node:assert/strict';
import { ShowDirector } from '../../src/show/director.ts';
import LiveDirector from '../../src/show/live-director.ts';
import { SPATIAL_AUTO_PATTERNS, pickPattern, availableFor } from '../../src/show/look.ts';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';
import { PATTERNS, COLOR_PRESETS } from '../../src/server/presets.ts';
import { INTENT } from '../../src/show/intents.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';

const patterns = [...PATTERNS, ...SPATIAL_AUTO_PATTERNS];
function track() {
  const roles = ['intro', 'verse', 'prechorus', 'drop', 'breakdown', 'outro'];
  return { duration: 96, bpm: 120, meter: 4, tempoStability: 0.95, key: 'A', scale: 'minor',
    mood: { valence: 0.6, arousal: 0.9, danceability: 0.9 }, genre: { label: 'edm', confidence: 0.9, style: 'dance' },
    beats: Array.from({ length: 192 }, (_, i) => i / 2), downbeats: Array.from({ length: 48 }, (_, i) => i * 2),
    beatStrengths: Array.from({ length: 192 }, () => 0.9), downbeatConfidence: 0.95,
    segments: roles.map((role, i) => ({ start: i * 16, end: (i + 1) * 16, role, label: String(i),
      level: i === 3 ? 'high' : i === 1 || i === 2 ? 'mid' : 'low', energy: i === 3 ? 0.95 : 0.4, bass: 0.7, confidence: 0.9 })),
    buildups: [{ start: 40, end: 48, intensity: 0.9, subdivision: 4 }],
    drops: [{ t: 48, confidence: 0.95, kind: 'proper', snapTo: 'downbeat', breakdownScore: 0.8, sustainScore: 0.9 }],
  };
}

test('automatic candidate set only offers acknowledged-independent room forms', () => {
  assert.ok(SPATIAL_AUTO_PATTERNS.length > 20);
  for (const { id } of SPATIAL_AUTO_PATTERNS) {
    const p = presetById(id);
    assert.equal(p.spec.params.space, 'room');
    assert.equal(requiresAcknowledgement(p.spec), false);
    assert.ok(!['v2.neural', 'v2.visualizer'].includes(p.spec.kind), 'automatic playback has no guaranteed external audio or picture');
  }
});

test('director builds upward, detonates drops and drifts in breakdown as one room field', () => {
  const director = new ShowDirector({ patterns, colorPresets: COLOR_PRESETS, pixels: true, panels: true, intensity: 80 });
  const plan = director.plan(track()), scenes = plan.intents.filter((i) => i.kind === INTENT.SCENE);
  const builds = scenes.filter((i) => i.source.startsWith('buildup:'));
  assert.ok(builds.length >= 2);
  assert.ok(builds.every((i) => i.pattern === 'v2.risingWall' && i.pixelSpan > 0));
  assert.ok(builds.at(-1).pixelFrom > builds[0].pixelFrom);
  const drops = scenes.filter((i) => i.source.startsWith('drop:'));
  assert.ok(drops.length > 0);
  assert.ok(drops.every((i) => ['v2.fallingWall', 'v2.speakerShockwave', 'v2.fireworks', 'v2.orbCollision'].includes(i.pattern)));
  assert.equal(drops.find((i) => i.source === 'drop:anchor').pattern, 'v2.fallingWall');
  assert.equal(drops.find((i) => i.source === 'drop:detonate').timeMs, 50000);
  const breakdown = scenes.find((i) => i.source === 'section:breakdown');
  assert.ok(['v2.noise', 'v2.aurora', 'v2.rain'].includes(breakdown.pattern));
  for (const scene of scenes.filter((i) => i.pattern?.startsWith('v2.'))) {
    assert.equal(scene.pixelPattern, null);
    assert.equal(scene.panelPattern, null);
    assert.equal(scene.pixelMap, 'stage');
    assert.equal(scene.strobeSpeed, 0);
    if (scene.pattern !== 'v2.risingWall') {
      assert.equal(scene.pixelSpan, null);
      assert.equal(scene.pixelFrom, null);
    }
  }
  assert.notEqual(scenes.find((i) => i.source === 'section:drop').pattern, breakdown.pattern);
});

test('look picker uses the spatial set while respecting constrained legacy callers', () => {
  const character = { energy: 0.9, kick: 0.9, bassline: 0.9, pulse: 0.9 };
  const spatial = pickPattern({ character, available: new Set(patterns.map((p) => p.id)), drive: 0.9 });
  assert.match(spatial, /^v2\./);
  assert.equal(pickPattern({ character, available: new Set(['chase']), drive: 0.9 }), 'chase');
});

test('live director selects a rising wall for builds and a spatial impact on a drop', () => {
  const patches = [];
  const director = new LiveDirector({ patterns, applyPatch: (p) => patches.push(p), setTimer: () => 1, clearTimer: () => {} });
  director.start();
  director.onEvent({ type: 'BUILDUP', data: {} });
  assert.equal(patches.at(-1).pattern, 'v2.risingWall');
  assert.equal(patches.at(-1).pixelSpan, null, 'an analyzed build cannot leave a span in the live build');
  assert.equal(patches.at(-1).pixelFrom, null);
  director.onEvent({ type: 'DROP', data: {} });
  const drop = patches.findLast((p) => p.pattern);
  assert.ok(['v2.speakerShockwave', 'v2.fireworks', 'v2.orbCollision'].includes(drop.pattern));
  assert.equal(drop.pixelPattern, null);
  assert.equal(drop.pixelSpan, null);
  assert.equal(drop.pixelFrom, null);
  director.stop();
});

test('sparse automatic shows avoid particle paths in every section and retain them for pixel rigs', () => {
  const all = [...PATTERNS, ...V2_PRESETS], sparse = availableFor(all, null), pixels = availableFor(all, null, { pixels: true });
  for (const p of V2_PRESETS) {
    if (p.spec.kind === 'v2.particles') {
      assert.equal(sparse.has(p.id), false, p.id);
      assert.equal(pixels.has(p.id), true, p.id);
    }
    if (['v2.neural', 'v2.visualizer'].includes(p.spec.kind)) {
      assert.equal(sparse.has(p.id), false, p.id);
      assert.equal(pixels.has(p.id), false, p.id);
    }
  }
  for (let seed = 0; seed < 30; seed++) {
    const analysis = track(); analysis.duration += seed * 0.01;
    analysis.segments[4].role = seed % 2 ? 'bridge' : 'breakdown';
    const plan = new ShowDirector({ patterns: all, colorPresets: COLOR_PRESETS, pixels: false, lamps: 4, intensity: 80 }).plan(analysis);
    for (const scene of plan.intents.filter((i) => i.kind === INTENT.SCENE)) {
      assert.ok(!['v2.particles', 'v2.neural', 'v2.visualizer'].includes(presetById(scene.pattern)?.spec.kind), scene.pattern);
    }
    for (const energy of [0.1, 0.5, 0.9]) {
      const id = pickPattern({ available: new Set(all.map((p) => p.id)), seed, pixels: false,
        drive: energy, character: { energy, kick: energy, pulse: energy, vocal: 1 - energy } });
      assert.ok(!['v2.particles', 'v2.neural', 'v2.visualizer'].includes(presetById(id)?.spec.kind), id);
    }
  }
});

test('live sparse rigs keep drop selection on a room-spanning field', () => {
  const patches = [], director = new LiveDirector({ patterns, pixels: () => false,
    applyPatch: (p) => patches.push(p), setTimer: () => 1, clearTimer: () => {} });
  director.start();
  for (let i = 0; i < 8; i++) director.onEvent({ type: 'DROP', data: {} });
  director.stop();
  const looks = patches.filter((p) => p.pattern);
  assert.ok(looks.slice(1).every((p) => p.pattern === 'v2.speakerShockwave'));
  assert.ok(looks.every((p) => presetById(p.pattern)?.spec.kind !== 'v2.particles'));
});
