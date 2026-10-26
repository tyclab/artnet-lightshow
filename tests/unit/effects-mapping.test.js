import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, presetById, V2_ALIASES } from '../../src/shared/effects/catalogue.ts';
import { mappingOf } from '../../src/shared/effects/mapping.ts';
import { PRESET_ROWS } from '../../src/server/presets.ts';
import { frameAt, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

test('pickers offer one entry per spatial look and overlay while retaining every alias', () => {
  assert.equal(PRESET_ROWS.filter((p) => p.family === 'spatial' && !p.retired).length, 39);
  assert.equal(PRESET_ROWS.filter((p) => p.id.startsWith('overlay.') && !p.retired).length, 4);
  for (const row of CATALOGUE.filter((p) => p.variantOf)) {
    assert.equal(row.retired, true);
    assert.equal(presetById(row.variantOf).retired, undefined);
    assert.equal(presetById(row.id).spec.params.space, 'plan');
  }
  for (const [alias, target] of Object.entries(V2_ALIASES)) assert.equal(presetById(alias), presetById(target));
});

test('mapping choices follow the current motion and selection, not the preset id', () => {
  for (const id of ['v2.wash', 'v2.breathe', 'v2.pathRunner', 'overlay.all']) {
    assert.equal(mappingOf(presetById(id).spec), null, id);
    assert.equal(mappingOf(presetById(`${id}.2d`).spec), null, `${id}.2d`);
  }
  for (const id of ['v2.grooveWave', 'v2.speakerShockwave', 'v2.rotation', 'v2.rain', 'overlay.scatter']) {
    assert.equal(mappingOf(presetById(id).spec), 'room');
    assert.equal(mappingOf(presetById(`${id}.2d`).spec), 'plan');
  }
  const step = presetById('v2.pathRunner').spec;
  assert.equal(mappingOf({ ...step, params: { ...step.params, order: 'axis' } }), 'room');
  assert.equal(mappingOf({ ...step, params: { ...step.params, order: 'random' } }), null);
});

test('effects with no mapping choice render identical frames in both spaces', () => {
  const { room } = syntheticRoom();
  for (const id of ['v2.wash', 'v2.breathe', 'v2.pathRunner', 'overlay.all']) {
    let a, b;
    for (let tick = 0; tick < 80; tick++) {
      const frame = frameAt(tick / 10);
      const before = renderKind(presetById(id).spec, room, frame, a);
      const after = renderKind(presetById(`${id}.2d`).spec, room, frame, b);
      a = before.state; b = after.state;
      assert.deepEqual(before.out, after.out, `${id}, beat ${frame.beatPos}`);
    }
  }
});

test('zones by technology or group and single-cell scatter offer no mapping and match in both spaces', () => {
  const { room } = syntheticRoom();
  const variants = [
    ['v2.zones', { partition: 'technology' }], ['v2.zones', { partition: 'role' }],
    ['v2.scatterFade', { selection: 'cells', clusterM: 0 }],
  ];
  for (const [id, params] of variants) {
    const base = presetById(id).spec;
    const inSpace = (space) => ({ ...base, params: { ...base.params, ...params, space } });
    assert.equal(mappingOf(inSpace('room')), null, `${id} ${JSON.stringify(params)}`);
    let a, b;
    for (let tick = 0; tick < 80; tick++) {
      const frame = frameAt(tick / 10);
      const before = renderKind(inSpace('room'), room, frame, a);
      const after = renderKind(inSpace('plan'), room, frame, b);
      a = before.state; b = after.state;
      assert.deepEqual(before.out, after.out, `${id} ${JSON.stringify(params)}, beat ${frame.beatPos}`);
    }
  }
  const clustered = presetById('v2.scatterFade').spec;
  assert.equal(mappingOf({ ...clustered, params: { ...clustered.params, selection: 'cells', clusterM: 0.5 } }), 'room');
});
