import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { registerKind } from '../../src/shared/effects/registry.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { demoFrameAt, demoPosition, DEMO_AUDIO_SOURCE, DEMO_BPM } from '../../src/shared/demo-track.ts';
import { colourHsv, hsvColour, huePair, CURATED_PALETTE_IDS } from '../../src/shared/colour-sliders.ts';
import { ALL_PALETTES } from '../../src/server/palette-catalogue.ts';
import { parseHex } from '../../src/shared/palette-model.ts';

const profile = { id: 'demo-rgb', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixtures = [{ id: 1, profileId: profile.id, address: 1, universe: 0, position: { x: 50, y: 50 }, maxBrightness: 255 }];
const rig = buildRig(fixtures, () => profile);
registerKind({ kind: 'test.audition', app: 'own', schema: z.object({}), defaults: { params: {} }, init: () => null,
  render(_p, _s, room, frame, out) {
    for (let i = 0; i < room.n; i++) out[i] = { level: 1, strength: 1, colour: {
      r: Math.round((frame.audio?.party.bass ?? 0) * 255),
      g: Math.round((frame.modulation?.sectionProgress ?? 0) * 255), b: frame.audioMode === 'reactive' ? frame.pictureFeatures?.palette[0].b ?? 0 : 0,
    } };
  },
});
const events = [{ timeMs: 0, action: 'patch', data: { pattern: 'demo', bpm: DEMO_BPM } }];
const options = { profiles: { [profile.id]: profile }, resolveEffect: () => ({ kind: 'test.audition', params: {} }),
  audioSource: DEMO_AUDIO_SOURCE, safety: { acknowledged: false } };
const sampleAt = (sample, t) => sample(t, fixtures, [{ r: 255, g: 255, b: 255 }], rig);

test('demo source supplies bounded bass/mid/high and deterministic build/drop/breakdown sections', () => {
  for (let beat = 0; beat < 64; beat += 0.25) {
    const t = beat * 60000 / DEMO_BPM, frame = demoFrameAt(t);
    assert.deepEqual(frame, demoFrameAt(t));
    assert.ok(Object.values(frame.party).every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  }
  assert.deepEqual([0, 16, 32, 48].map((beat) => demoPosition(beat * 60000 / DEMO_BPM).section), ['build', 'drop', 'breakdown', 'groove']);
  assert.equal(DEMO_AUDIO_SOURCE.pictureAt(500).expiresAt, 600);
  assert.deepEqual(DEMO_AUDIO_SOURCE.pictureAt(500), DEMO_AUDIO_SOURCE.pictureAt(500));
  assert.ok(demoFrameAt(16 * 60000 / DEMO_BPM).party.bass > demoFrameAt(32 * 60000 / DEMO_BPM).party.bass);
});

test('typed audition samples audio and section modulation, seeks reproducibly and leaves inputs untouched', () => {
  const original = JSON.stringify({ events, fixtures, profile });
  const sample = createPreviewSampler(events, null, options);
  for (const t of [250, 5000, 11000, 350, 9000]) {
    const result = sampleAt(sample, t);
    assert.deepEqual(result, sampleAt(createPreviewSampler(events, null, options), t));
    assert.equal(result[0].b, 255);
    assert.ok(result[0].g > 0);
  }
  const silent = createPreviewSampler(events, null, { ...options, audioSource: undefined });
  assert.deepEqual(sampleAt(silent, 500), [{ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }]);
  assert.equal(JSON.stringify({ events, fixtures, profile }), original);
});

test('hue sliders round trip RGB and retain white, amber and UV emitters', () => {
  for (const hex of ['#123456789ABC', '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#A0B0C0']) {
    assert.deepEqual(parseHex(hsvColour(colourHsv(hex), hex)), parseHex(hex));
  }
  const changed = parseHex(hsvColour({ hue: 180, saturation: 100, brightness: 50 }, '#AA0000112233'));
  assert.deepEqual(changed, { r: 0, g: 128, b: 128, w: 17, a: 34, uv: 51 });
  assert.deepEqual(huePair(0, 180, 100, 100), ['#FF0000', '#00FFFF']);
  assert.deepEqual(huePair(360, -180, 100, 100), ['#FF0000', '#00FFFF']);
  for (const id of CURATED_PALETTE_IDS) assert.ok(ALL_PALETTES.some((p) => p.id === id), id);
});
