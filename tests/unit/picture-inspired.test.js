import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderInput } from '../../src/server/engine.ts';
import { settings, SettingsStore } from '../../src/server/settings.ts';
import { pictureSourceSchema } from '../../src/server/validation.ts';
import { pictureInput } from '../../src/server/picture-live.ts';
import { PictureInput } from '../../src/server/picture.ts';
import { pixelInputs } from '../../src/server/pixel-input-live.ts';

test('the explicit colour + motion source persists and passes the API schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picture-inspired-'));
  try {
    const file = path.join(dir, 'settings.json'), store = new SettingsStore(file).load();
    assert.equal(store.get('picture.source'), 'effects');
    for (const source of ['inspired', 'visualizer', 'effects']) {
      assert.deepEqual(pictureSourceSchema.parse({ source }), { source });
      store.update({ picture: { source } });
      assert.equal(new SettingsStore(file).load().get('picture.source'), source);
    }
    assert.equal(pictureSourceSchema.safeParse({ source: 'automatic' }).success, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inspired consumes room features without copying pixels; switching source clears features and stale panel frames', (t) => {
  const saved = settings._values;
  let picture = { leaseId: 'synthetic', signature: 'synthetic', units: 2, expiresAt: performance.now() + 10000,
    data: Uint8Array.from([255, 0, 0, 0, 0, 255]) };
  const stream = [{ fixtureId: 1, data: Uint8Array.from([0, 255, 0]), expiresAt: picture.expiresAt }];
  t.mock.method(pictureInput, 'current', () => picture);
  t.mock.method(pictureInput, 'image', () => null);
  t.mock.method(pixelInputs, 'frames', () => stream);
  const source = (value) => { settings._values = { ...saved, picture: { ...saved.picture, source: value } }; return renderInput(); };
  try {
    const inspired = source('inspired');
    assert.equal(inspired.picture, null, 'the renderer gets no pixel copy to override the spatial effect');
    assert.deepEqual(inspired.pixelInputs, [], 'old panel leases cannot replace the spatial field during their TTL');
    assert.deepEqual(inspired.pictureFeatures.palette.map(({ r, g, b }) => [r, g, b]), [[255, 0, 0], [0, 0, 255]]);
    const direct = source('visualizer');
    assert.equal(direct.picture, picture);
    assert.equal(direct.pictureFeatures, null);
    assert.equal(direct.pixelInputs, stream);
    const effects = source('effects');
    assert.equal(effects.picture, null); assert.equal(effects.pictureFeatures, null);
    picture = null;
    assert.equal(source('inspired').pictureFeatures, null, 'expired input does not leave an old palette/motion signal');
  } finally { settings._values = saved; }
});

test('a sender omitting later optional images still supplies fresh colours to the inspired engine', (t) => {
  const saved = settings._values;
  let now = performance.now();
  const input = new PictureInput({ now: () => now, armed: () => true, acknowledged: () => true,
    rig: () => ({ signature: 'synthetic', units: 2 }) });
  const { leaseId } = input.claim('test', { signature: 'synthetic' });
  t.mock.method(pictureInput, 'current', () => input.current());
  t.mock.method(pictureInput, 'image', (currentFrameOnly) => input.image(currentFrameOnly));
  settings._values = { ...saved, picture: { ...saved.picture, source: 'inspired' } };
  try {
    const red = Uint8Array.from([255, 0, 0, 255, 0, 0]);
    input.frame('test', { leaseId, data: red, image: { width: 2, height: 1, data: red } });
    assert.equal(renderInput().pictureFeatures.palette[0].r, 255);
    now += 100;
    input.frame('test', { leaseId, data: Uint8Array.from([0, 255, 0, 0, 255, 0]) });
    assert.equal(input.image().data[0], 255, 'Stage screens retain their last picture');
    assert.deepEqual(renderInput().pictureFeatures.palette.map(({ r, g, b }) => [r, g, b]), [[0, 255, 0]],
      'the effect follows fresh sampled unit colours instead of the retained picture');
  } finally { settings._values = saved; }
});
