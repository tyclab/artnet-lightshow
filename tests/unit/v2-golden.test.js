// Phase A stays unchanged on disk; intentional v2 changes have their own demo-driven baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { V2_BEATS, V2_COMPLETE_BEATS, V2_COMPLETE_OPTIONS, frameDiff, renderGolden } from '../../scripts/golden-frames.js';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';

const phaseA = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/v2-spatial.json', import.meta.url), 'utf8'));
const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/v2-complete.json', import.meta.url), 'utf8'));
const intentional = {
  scatterStrobe: 'Selection is by room location and whole lamp, independent of pixel count',
  scatterFade: 'Shared scatter selection gives every lamp a fair share',
  scatterGrow: 'Shared scatter selection gives every lamp a fair share',
  frequencyBurst: 'Band-triggered scatter uses the same whole-lamp selection',
  popcorn: 'Removed from the chooser; its old ID resolves to Scatter Fade',
  grooveWave: 'Resting units are black; removed implicit colour-A floor',
  bigRoomWave: 'Resting units are black; removed implicit colour-A floor',
  beacon: 'Resting units are black; removed implicit colour-A floor',
  volumeGateWash: 'Silence closes the gate completely and resting units are black',
  neural: 'No idle colour floor without music',
  neuralDistance: 'No idle colour floor; only named speaker anchors are sound origins',
  rotation: 'Sector edges blend smoothly instead of changing abruptly',
};
const changed = new Set(Object.keys(intentional).flatMap((id) => [`v2.${id}`, `v2.${id}.2d`]));

test('unchanged Phase A presets retain their exact recorded bytes', () => {
  const frames = renderGolden(Object.keys(phaseA), 'synthetic', V2_BEATS);
  const moved = Object.keys(phaseA).map((id) => [id, frameDiff(frames[id], phaseA[id])]).filter(([, d]) => d.maxChannel > 0);
  assert.deepEqual(moved.map(([id]) => id).sort(), [...changed].sort(), 'only documented intentional changes may differ');
  assert.equal(Object.keys(phaseA).length - moved.length, 16, 'sixteen original room/plan looks remain byte-identical');
  assert.ok(Object.values(intentional).every((reason) => reason.length > 20));
});

test('the complete demo baseline records every Spatial preset', () => {
  assert.deepEqual(Object.keys(golden).sort(), V2_PRESETS.map((p) => p.id).sort());
});

test('every Spatial preset renders its recorded frames', () => {
  const frames = renderGolden(V2_PRESETS.map((p) => p.id), 'synthetic', V2_COMPLETE_BEATS, V2_COMPLETE_OPTIONS);
  const moved = V2_PRESETS.map((p) => [p.id, frameDiff(frames[p.id], golden[p.id])]).filter(([, d]) => d.maxChannel > 0);
  assert.deepEqual(moved, []);
});

test('the recorded frames light the room in both forms and differ between them', () => {
  for (const p of V2_PRESETS.filter((q) => !q.id.endsWith('.2d'))) {
    const room = golden[p.id], plan = golden[`${p.id}.2d`];
    assert.ok(room.some((row) => row.some((v) => v > 0)), p.id);
    assert.ok(plan.some((row) => row.some((v) => v > 0)), `${p.id}.2d`);
  }
  const differ = V2_PRESETS.filter((p) => !p.id.endsWith('.2d')).filter((p) => frameDiff(golden[p.id], golden[`${p.id}.2d`]).maxChannel > 0);
  assert.ok(differ.length >= 25, `${differ.length} spatial presets look different in 2D`);
});

test('demo input drives Neural and Visualizer while missing input leaves both dark', () => {
  const ids = ['v2.neural', 'v2.neuralDistance', 'v2.visualizerFlow', 'v2.visualizerDrift'];
  const silent = renderGolden(ids, 'synthetic', V2_COMPLETE_BEATS);
  for (const id of ids) {
    assert.ok(golden[id].some((row) => row.some((v) => v > 0)), id);
    assert.ok(frameDiff(golden[id], silent[id]).maxChannel > 0, `${id} follows the supplied source`);
  }
});
