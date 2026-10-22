import test from 'node:test';
import assert from 'node:assert/strict';
import { PictureFeatureExtractor } from '../../src/shared/picture-features.ts';
import '../../src/shared/effects/index.ts';
import { frameAt, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

const frame = (data, at = 0, leaseId = 'demo') => ({ leaseId, signature: 'synthetic', units: data.length / 3, expiresAt: at + 1000, data: Uint8Array.from(data) });
const pixels = (reverse = false) => Array.from({ length: 256 }, (_, i) => (i < 128) !== reverse ? [255, 0, 0] : [0, 0, 255]).flat();

test('picture inspiration extracts colours without preserving where source pixels are', () => {
  const first = new PictureFeatureExtractor().update(frame(pixels()), null, 0);
  const swapped = new PictureFeatureExtractor().update(frame(pixels(true)), null, 0);
  assert.deepEqual(first, swapped);
  assert.deepEqual(first.palette.map(({ r, g, b }) => [r, g, b]), [[255, 0, 0], [0, 0, 255]]);
  assert.equal(first.speed, 0, 'a first frame does not invent motion');
});

test('image sampling spans both dimensions instead of repeatedly sampling the same columns', () => {
  const data = Uint8Array.from(Array.from({ length: 128 * 128 }, (_, i) => i % 64 === 0 ? [255, 0, 0] : [0, 0, 255]).flat());
  const features = new PictureFeatureExtractor().update(frame(pixels()), { width: 128, height: 128, data }, 0);
  assert.ok(features.palette.some(({ r, b }) => b > 200 && r < 50), 'the blue field occupying 98% of the picture is represented');
});

test('motion follows changes within the picture; a static frame slows to rest', () => {
  const extractor = new PictureFeatureExtractor();
  extractor.update(frame(pixels()), null, 0);
  const moving = extractor.update(frame(pixels(true), 40), null, 40);
  assert.ok(moving.speed > 0);
  let still;
  for (let at = 80; at <= 2000; at += 40) still = extractor.update(frame(pixels(true), at), null, at);
  assert.ok(still.speed < moving.speed / 100);
  const stable = extractor.update(frame(pixels(true), 2000), null, 2001);
  assert.equal(stable, still, 'repeated control snapshots do not count as new visualizer frames');
});

test('uniform colour changes do not masquerade as spatial movement; black and expired inputs are dark', () => {
  const extractor = new PictureFeatureExtractor();
  extractor.update(frame(new Array(256).fill([255, 0, 0]).flat()), null, 0);
  assert.equal(extractor.update(frame(new Array(256).fill([0, 255, 0]).flat(), 40), null, 40).speed, 0);
  assert.equal(extractor.update(frame(new Array(768).fill(0), 80), null, 80).level, 0);
  assert.equal(extractor.update(frame(pixels(), 80), null, 1080), null);
  assert.equal(extractor.update(null, null, 1100), null);
});

test('the inspired effect draws its own field in both spaces and stops without input', () => {
  const { room } = syntheticRoom();
  const source = new PictureFeatureExtractor().update(frame(pixels(), 1000), null, 1000);
  for (const space of ['room', 'plan']) {
    const spec = { kind: 'v2.visualizer', params: { space } };
    const f = { ...frameAt(0), pictureFeatures: { ...source, speed: 0.8, expiresAt: 10000 } };
    const first = renderKind(spec, room, f);
    const later = renderKind(spec, room, { ...f, beatPos: 0.4, nowMs: 200 }, first.state);
    assert.notDeepEqual(later.out, first.out, `${space}: picture motion moves the own field`);
    const stop = renderKind(spec, room, { ...f, pictureFeatures: null }, later.state);
    assert.ok(stop.out.every((slot) => slot.level === 0 && Object.values(slot.colour).every((v) => v === 0)));
  }
});
