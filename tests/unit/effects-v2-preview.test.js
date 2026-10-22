import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM } from '../../src/shared/demo-track.ts';
import { lookInput } from '../../scripts/golden-party-looks.js';

const profile = barProfile({ id: 'spatial-parity-strip', name: 'Synthetic diagonal strip', cells: 48, firstChannel: 1, order: 'RGB' });
const fixtures = [{ id: 1, profileId: profile.id, address: 1, universe: 0, maxBrightness: 255, override: null,
  position: { x: 50, y: 50 }, geometry: { length: 90, angle: 45 } }];
const rig = buildRig(fixtures, () => profile);
const room = roomSceneSchema.parse({ version: 1, name: 'Synthetic diagonal', bounds: { width: 4, depth: 4, height: 4 },
  bindings: [{ id: 'diagonal', fixtureId: 1, position: { x: 0, y: 2, z: 0 }, confidence: 'measured',
    path: [{ x: -1.9, y: 0.05, z: 1.9 }, { x: 1.9, y: 3.95, z: -1.9 }] }] });
const space = buildUnitSpace(rig, room);
const resolveEffect = (id) => presetById(id)?.spec ?? null;

test('new generators and showpieces preview the same RGB values as the output renderer in both spaces', () => {
  for (const name of ['wash', 'breathe', 'chase', 'zones', 'noise', 'lightOrbs', 'orbCollision', 'fireworks', 'rain', 'stemsSpace',
    'risingWall', 'fallingWall', 'visualizerFlow', 'visualizerDrift']) for (const suffix of ['', '.2d']) {
    const id = `v2.${name}${suffix}`, renderer = createRenderer({ profileOf: () => profile, now: 0 });
    renderer.setSpace(space);
    const store = universes.createUniverseStore(universes.allocateShared());
    const input = lookInput(id, fixtures, resolveEffect);
    const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: {
      pattern: id, colorA: 0, colorB: 6, colorC: 4, colorD: 8, bpm: DEMO_BPM } }], null,
    { resolveEffect, space, profiles: { [profile.id]: profile }, audioSource: DEMO_AUDIO_SOURCE,
      safety: { acknowledged: true, hdFlashIntervalMs: 350 } });
    for (let frame = 0; frame <= 110; frame++) {
      const ms = frame * (1000 / 44);
      input.audio = DEMO_AUDIO_SOURCE.frameAt(ms); input.audioMode = 'reactive';
      input.modulation = DEMO_AUDIO_SOURCE.modulationAt(ms); input.pictureFeatures = DEMO_AUDIO_SOURCE.pictureAt(ms);
      renderer.frame(input, { beatPos: ms / 60000 * DEMO_BPM, bpm: DEMO_BPM, epoch: 0 }, ms, store);
      const preview = sample(ms, fixtures, COLOR_PRESETS, rig), bytes = store.getBuffer(0);
      for (let u = 0; u < rig.units.length; u++) {
        assert.deepEqual([preview[u].r, preview[u].g, preview[u].b], Array.from(bytes.subarray(u * 3, u * 3 + 3)), `${id}, ${ms} ms, unit ${u}`);
      }
    }
  }
});

test('authored build spans match preview without demo audio and take priority over analysis progress', () => {
  for (const suffix of ['', '.2d']) for (const withSource of [false, true]) {
    const id = `v2.risingWall${suffix}`, renderer = createRenderer({ profileOf: () => profile, now: 0 });
    renderer.setSpace(space);
    const store = universes.createUniverseStore(universes.allocateShared());
    const input = { ...lookInput(id, fixtures, resolveEffect), pixelSpan: 6, pixelFrom: 0.15, beatDivision: 2 };
    const modulation = { section: 'buildup', sectionProgress: 0.99 };
    const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: {
      pattern: id, colorA: 0, colorB: 6, colorC: 4, colorD: 8, bpm: 120, pixelSpan: 6, pixelFrom: 0.15, beatDivision: 2 } }], null,
    { resolveEffect, space, profiles: { [profile.id]: profile }, safety: { acknowledged: true, hdFlashIntervalMs: 350 },
      ...(withSource ? { audioSource: { frameAt: () => null, modulationAt: () => modulation } } : {}) });
    if (withSource) input.modulation = modulation;
    const lit = [];
    for (let frame = 0; frame <= 88; frame++) {
      const ms = frame * (1000 / 44);
      renderer.frame(input, { beatPos: ms / 60000 * 120, bpm: 120, epoch: 0 }, ms, store);
      const preview = sample(ms, fixtures, COLOR_PRESETS, rig), bytes = store.getBuffer(0);
      lit.push(preview.filter(unit => unit.r + unit.g + unit.b > 0).length);
      for (let u = 0; u < rig.units.length; u++) {
        assert.deepEqual([preview[u].r, preview[u].g, preview[u].b], Array.from(bytes.subarray(u * 3, u * 3 + 3)),
          `${id}, source=${withSource}, ${ms} ms, unit ${u}`);
      }
    }
    assert.ok(lit.at(-1) > lit[0] + 10, 'the wall visibly rises instead of latching at the analysis progress');
  }
});
