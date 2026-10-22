// The Spatial presets: the operator's list as parameter sets of the v2 generators,
// every one in the room and as its classic 2D twin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';
import { CATALOGUE, FAMILIES, presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { PATTERN_IDS, PRESET_ROWS } from '../../src/server/presets.ts';
import { frameAt, audioOf, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

const NAMES = ['Scatter Strobe', 'Scatter Fade', 'Scatter Grow', 'Groove Wave', 'Big Room Wave', 'Ascent', 'Double Wave', 'Swagger',
  'Impact', 'Vortex', 'Speaker Shockwave', 'Rotation', 'Swirl', 'Beacon', 'Neural', 'Neural Distance',
  'Beat Accent Wash', 'Volume Gate Wash', 'Frequency Burst', 'Wash', 'Breathe', 'Chase', 'Path Runner', 'Surround', 'Zones', 'Surround Answer',
  'Near and Far', 'Drifting Clouds', 'Aurora', 'Fire', 'Rising Wall', 'Falling Wall', 'Light Orbs', 'Orb Collision', 'Fireworks', 'Rain', 'Stems in Space',
  'Visualizer Flow', 'Visualizer Drift'];
const room = V2_PRESETS.filter((p) => !p.id.endsWith('.2d'));
const twinOf = (p) => V2_PRESETS.find((q) => q.id === `${p.id}.2d`);

test('every operator effect is a Spatial preset, in the room and in 2D', () => {
  assert.deepEqual(room.map((p) => p.name).sort(), [...NAMES].sort());
  assert.equal(V2_PRESETS.length, 2 * NAMES.length);
  for (const p of V2_PRESETS) {
    assert.match(p.id, /^v2\.[a-z][A-Za-z]*(\.2d)?$/);
    assert.equal(p.family, 'spatial');
    assert.equal(p.app, 'own');
    assert.ok(p.desc.length > 20, p.id);
  }
});

test('every preset validates and names its space', () => {
  for (const p of V2_PRESETS) {
    assert.deepEqual(validateSpec(p.spec), p.spec, p.id);
    assert.equal(p.spec.params.space, p.id.endsWith('.2d') ? 'plan' : 'room', p.id);
  }
});

test('each 2D twin differs from its room form only in space', () => {
  for (const p of room) {
    const twin = twinOf(p);
    assert.ok(twin, `${p.id} has a twin`);
    assert.equal(twin.name, `${p.name} 2D`);
    assert.deepEqual({ ...twin.spec, params: { ...twin.spec.params, space: 'room' } }, p.spec, p.id);
  }
});

test('no Spatial id collides with an existing id or alias', () => {
  const others = CATALOGUE.filter((p) => p.family !== 'spatial');
  const taken = new Set([...PATTERN_IDS, ...others.flatMap((p) => [p.id, ...(p.aliases ?? [])])]);
  for (const p of V2_PRESETS) assert.ok(!taken.has(p.id), p.id);
  for (const p of V2_PRESETS) assert.equal(presetById(p.id).spec, p.spec, 'the catalogue resolves it');
});

test('the catalogue lists them under Spatial for the Effects view', () => {
  const spatial = FAMILIES.find((f) => f.id === 'spatial');
  assert.equal(spatial.name, 'Spatial');
  for (const p of V2_PRESETS) assert.ok(spatial.kinds.some((k) => k.kind === p.spec.kind), p.spec.kind);
  const rows = PRESET_ROWS.filter((r) => r.family === 'spatial');
  assert.equal(rows.length, V2_PRESETS.length);
  assert.ok(rows.every((r) => r.app === 'own'));
});

test('the strobes ask for the acknowledgement and the washes do not', () => {
  const rapid = room.filter((p) => requiresAcknowledgement(p.spec)).map((p) => p.name).sort();
  assert.deepEqual(rapid, ['Frequency Burst', 'Scatter Strobe']);
});

test('every preset lights the synthetic room in both forms', () => {
  const { room: synthetic } = syntheticRoom();
  const audio = audioOf({ full: 0.9, bass: 0.9, mid: 0.7, high: 0.8 });
  for (const p of V2_PRESETS) {
    const lit = [0.01, 0.3, 0.55, 1.05, 2.2, 3.4].some((beat) =>
      renderKind(p.spec, synthetic, { ...frameAt(beat, { audio }),
        pictureFeatures: { palette: [{ r: 32, g: 160, b: 255, w: 0, a: 0, uv: 0 }], speed: 1, level: 1, expiresAt: 100000 } }).out.some((s) => s.level > 0.3));
    assert.ok(lit, p.id);
  }
});
