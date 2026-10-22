// Golden frames are kept per output unit, so a later step can say how far a
// look moved and on how many lights, instead of only that its bytes changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameDiff, renderGolden, syntheticRig, syntheticSpace } from '../../scripts/golden-frames.js';

test('identical frames differ by nothing', () => {
  const frames = [[0, 10, 255], [3, 4, 5]];
  assert.deepEqual(frameDiff(frames, structuredClone(frames)), { maxChannel: 0, units: 0 });
});

test('one changed channel names its size and its one unit', () => {
  const a = [[0, 10, 255], [3, 4, 5], [9, 9, 9]];
  const b = structuredClone(a);
  b[1][2] += 3;
  assert.deepEqual(frameDiff(a, b), { maxChannel: 3, units: 1 });
});

test('the synthetic rig renders one row per unit, the same on every call', () => {
  const first = renderGolden(['solid'], 'synthetic', [0, 1.25]);
  assert.deepEqual(Object.keys(first), ['solid']);
  assert.equal(first.solid.length, syntheticRig().units);
  assert.ok(first.solid.every((row) => row.length > 0 && row.every(Number.isInteger)));
  assert.ok(first.solid.some((row) => row.some((v) => v > 0)), 'solid lights the rig');
  assert.deepEqual(renderGolden(['solid'], 'synthetic', [0, 1.25]), first);
});

test('flat and placed rigs keep their party-look rigs', () => {
  assert.equal(renderGolden(['solid'], 'flat', [0]).solid.length, 4);
  assert.equal(renderGolden(['solid'], 'placed', [0]).solid.length, 8);
});

test('every existing id renders the same frames with the room space as without it', async () => {
  const { CATALOGUE } = await import('../../src/shared/effects/catalogue.ts');
  const { PATTERN_IDS } = await import('../../src/server/presets.ts');
  // The ids that existed before the unit space: the Spatial presets read it on purpose.
  const ids = [...new Set([...PATTERN_IDS, ...CATALOGUE.filter((row) => row.family !== 'spatial').map((row) => row.id)])];
  const beats = [0, 0.5, 1.25, 3, 7.5];
  const spaced = renderGolden(ids, 'synthetic', beats);
  const plain = renderGolden(ids, 'synthetic', beats, { space: false });
  const moved = ids.map((id) => [id, frameDiff(spaced[id], plain[id])]).filter(([, d]) => d.maxChannel > 0);
  assert.deepEqual(moved, []);
  assert.ok(ids.length > 250, `${ids.length} ids`);
});

test('the synthetic rig renders with its room space', () => {
  assert.equal(syntheticSpace().n, syntheticRig().units);
  assert.deepEqual(Object.keys(syntheticSpace().listeners), ['desk', 'couch']);
});
