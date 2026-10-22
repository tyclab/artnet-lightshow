import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { LEGACY_PRESETS, V2_ALIASES, CATALOGUE, presetById } from '../../src/shared/effects/catalogue.ts';
import { migrateEffectSpec, legacyKind, EFFECT_LIBRARY_VERSION } from '../../src/shared/effects/migrate.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { frameAt, syntheticRoom } from '../helpers/v2-frames.js';

const { room } = syntheticRoom();
const seed = [1, 2, 3, 4];
const instance = (spec) => ({ id: 'migration', spec, seed, targets: null, anchorBeat: 0, startedAtMs: 0 });

test('every retained authored legacy spec renders identically after the versioned migration', () => {
  for (const preset of LEGACY_PRESETS.filter((p) => !p.legacy)) {
    const original = validateSpec({ ...preset.spec, brightness: 0.73 });
    const migrated = migrateEffectSpec(original);
    const before = new EffectStepper(), after = new EffectStepper();
    assert.equal(requiresAcknowledgement(migrated), requiresAcknowledgement(original), preset.id);
    assert.deepEqual(migrateEffectSpec(migrated, EFFECT_LIBRARY_VERSION), migrated);
    for (let tick = 0; tick < 44; tick++) {
      const frame = frameAt(tick / 11);
      const a = [], b = [];
      renderEffect(instance(original), frame, room, before, a);
      renderEffect(instance(migrated), frame, room, after, b);
      const normalized = (slots) => slots.map((slot) => slot.kind ? { ...slot, kind: legacyKind(slot.kind) } : slot);
      assert.deepEqual(normalized(b), normalized(a), `${preset.id}, frame ${tick}`);
    }
  }
});

test('an old stored library migrates nested specs without losing rich parameters or metadata', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-v2-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'effects.json');
  const effect = validateSpec({ kind: 'hd.spatialWash', admission: 'hold', palette: ['#FF0088', '#0044FF'],
    brightness: 0.61, params: { direction: 'alternate', probability: 0.37, repetitions: 3, trail: 0.7,
      spatial: { angle: 73, radius: 0.67 }, trigger: { band: 'mid', reactiveDepth: 0.42 } } });
  const spec = validateSpec({ kind: 'macro', params: { steps: [{ effect, beats: 8 }], loopBeats: 8 } });
  const entry = { id: 'user.saved', name: 'Authored legacy', spec, createdAt: '2026-10-01', updatedAt: '2026-10-02' };
  fs.writeFileSync(file, JSON.stringify({ presets: [entry] }));
  const library = new EffectLibrary(file).load(), saved = library.get(entry.id).preset;
  assert.equal(saved.spec.params.steps[0].effect.kind, 'compat.hd.spatialWash');
  assert.deepEqual(saved.spec.params.steps[0].effect.params, effect.params);
  assert.equal(saved.createdAt, entry.createdAt);
  assert.equal(saved.updatedAt, entry.updatedAt);
  library.update(entry.id, { name: 'Authored again' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, EFFECT_LIBRARY_VERSION);
  assert.deepEqual(new EffectLibrary(file).load().resolve(entry.id), saved.spec);
});

test('all old preset ids resolve, curated aliases are explicit, and Popcorn is absent from the picker', () => {
  for (const old of LEGACY_PRESETS) assert.ok(presetById(old.id), old.id);
  for (const [alias, target] of Object.entries(V2_ALIASES)) assert.equal(presetById(alias), presetById(target), alias);
  assert.equal(presetById('ldj.PartyStrobe'), presetById('ldj.MatrixPulse'));
  assert.ok(CATALOGUE.filter((p) => !p.retired).every((p) => !/popcorn/i.test(p.id + p.name)));
  assert.ok(CATALOGUE.filter((p) => p.app !== 'own').every((p) => p.retired));
});
