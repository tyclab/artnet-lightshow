// Every Spatial preset, room and 2D, frame by frame on the synthetic room as recorded.
// Regenerate with `node scripts/golden-frames.js` only for an intentional visual change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { V2_BEATS, frameDiff, renderGolden } from '../../scripts/golden-frames.js';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';

const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/v2-spatial.json', import.meta.url), 'utf8'));

test('the golden file records every Spatial preset', () => {
  assert.deepEqual(Object.keys(golden).sort(), V2_PRESETS.map((p) => p.id).sort());
});

test('every Spatial preset renders its recorded frames', () => {
  const frames = renderGolden(V2_PRESETS.map((p) => p.id), 'synthetic', V2_BEATS);
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
  assert.ok(differ.length >= 15, `${differ.length} of 20 presets look different in 2D`);
});
