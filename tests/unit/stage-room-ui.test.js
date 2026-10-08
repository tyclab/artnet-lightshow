import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { PerspectiveCamera, Vector3 } from 'three';
import { buildRig } from '../../src/shared/rig.ts';
import { placeRig, roomRig, roomViews, meanLightRGB, TRUSS_H, STAGE_FOV } from '../../public-src/stage3d/world.js';

const profiles = { lamp: { channelMap: { red: 0 } }, bar: { cells: [{ channelMap: { red: 0 } }, { channelMap: { red: 1 } }] } };
const fixtures = [{ id: 10, label: 'Lamp', profileId: 'lamp' }, { id: 20, label: 'Bar', profileId: 'bar' }];
const rig = buildRig(fixtures, (fixture) => profiles[fixture.profileId]);
const binding = (id, fixtureId, unit = 0) => ({ id, fixtureId, unit, position: { x: 1, y: 1.2, z: -1 }, confidence: 'estimated' });
const model = { version: 1, name: 'Test room', bounds: { width: 6, depth: 4, height: 2.8 }, rooms: [], objects: [], bindings: [] };

test('generic fixtures honor explicit floor-to-ceiling heights', () => {
  const fixture = { ...fixtures[0], position: { x: 50, y: 50, height: 25 }, group: 'front' };
  const placed = placeRig([fixture], profiles, buildRig([fixture], () => profiles.lamp));
  assert.equal(placed.lamps[0].position.y, TRUSS_H / 4);
});

test('room bindings resolve local unit indices after other fixtures', () => {
  const placed = roomRig(fixtures, rig, { ...model, bindings: [binding('cell', 20, 1)] });
  assert.equal(placed.cells[0].unit, 2);
});

test('shared channels can illuminate several physical positions', () => {
  const placed = roomRig(fixtures, rig, { ...model, bindings: [binding('a', 10), binding('b', 10)] });
  assert.deepEqual(placed.lamps.map((lamp) => lamp.unit), [0, 0]);
});

const average = (sources) => ({ id: 'physical', aggregation: 'weightedMean', sources,
  position: { x: 0, y: 1, z: 0 }, confidence: 'estimated' });

test('several source units render one physical marker', () => {
  const placed = roomRig(fixtures, rig, { ...model, bindings: [average([
    { fixtureId: 10, unit: 0, weight: 1 }, { fixtureId: 20, unit: 1, weight: 3 },
  ])] });
  assert.deepEqual([placed.lamps.length, placed.cells.length, placed.lamps[0].sources.map((source) => source.unit)], [1, 0, [0, 2]]);
});

test('physical averages use normalized linear RGB source weights', () => {
  const out = new Float32Array(3);
  meanLightRGB([{ unit: 0, weight: 1e300 }, { unit: 1, weight: 3e300 }], [{ r: 255 }, { b: 255 }], out);
  assert.deepEqual([...out], [0.25, 0, 0.75]);
});

test('missing source weights remain black in an incomplete physical average', () => {
  const placed = roomRig(fixtures, rig, { ...model, bindings: [average([
    { fixtureId: 10, unit: 0, weight: 1 }, { fixtureId: 999, unit: 0, weight: 3 },
  ])] });
  const out = new Float32Array(3);
  meanLightRGB(placed.lamps[0].sources, [{ w: 255 }], out);
  assert.deepEqual([...out], [0.25, 0.25, 0.25]);
  assert.equal(placed.incomplete[0].missingSources, 1);
});

test('an output frame missing a known source retains its black weight', () => {
  const out = new Float32Array(3);
  meanLightRGB([{ unit: 0, weight: 1 }, { unit: 2, weight: 3 }], [{ r: 255 }], out);
  assert.deepEqual([...out], [0.25, 0, 0]);
});

test('shared channel coverage identifies all affected physical markers', () => {
  const first = average([{ fixtureId: 10, unit: 0, weight: 1 }]);
  const second = { ...first, id: 'other' };
  const placed = roomRig(fixtures, rig, { ...model, bindings: [first, second] });
  assert.deepEqual(placed.shared, [{ fixtureId: 10, unit: 0, bindings: ['physical', 'other'] }]);
});

test('room placements never fabricate trusses', () => {
  assert.deepEqual(roomRig(fixtures, rig, { ...model, bindings: [binding('a', 10)] }).trusses, []);
});

test('unknown fixtures and unavailable cells remain unresolved', () => {
  const missing = [binding('missing', 999), binding('cell', 20, 4)];
  assert.deepEqual(roomRig(fixtures, rig, { ...model, bindings: missing }).unresolved, missing);
});

test('partly mapped bars remain distinct from fixtures without positions', () => {
  const placed = roomRig(fixtures, rig, { ...model, bindings: [binding('cell', 20, 1)] });
  assert.deepEqual([placed.partial.map((fixture) => fixture.id), placed.missing.map((fixture) => fixture.id)], [[20], [10]]);
});

test('room camera distance grows with the imported floor', () => {
  const small = roomViews({ width: 4, depth: 3, height: 2.5 });
  const large = roomViews({ width: 16, depth: 12, height: 2.5 });
  assert.ok(large.above.position[1] > small.above.position[1] * 2);
});

test('room cameras fit every corner in portrait and landscape viewports', () => {
  const bounds = { width: 8, depth: 10, height: 3 };
  for (const aspect of [0.5, 1, 3]) for (const view of Object.values(roomViews(bounds, aspect))) {
    const camera = new PerspectiveCamera(STAGE_FOV, aspect, 0.1, 1000);
    camera.position.set(...view.position);
    camera.lookAt(...view.target);
    camera.updateMatrixWorld();
    for (const x of [-4, 4]) for (const y of [0, 3]) for (const z of [-5, 5]) {
      const projected = new Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1);
    }
  }
});

const root = path.join(import.meta.dirname, '../..');
const built = await esbuild.build({
  stdin: { contents: "export { replaceStageRoom, withRoomBinding, StageRoomPanel } from './public-src/components/StageRoomPanel.jsx'; export { render } from 'preact-render-to-string'; export { h } from 'preact';", resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', jsxImportSource: 'preact',
  alias: { 'socket.io-client': path.join(root, 'tests/helpers/fake-socket-io.js') }, logLevel: 'silent',
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-room-ui-'));
const file = path.join(directory, 'ui.mjs');
fs.writeFileSync(file, built.outputFiles[0].text);
const ui = await import(file);
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('room replacement uses the loaded revision without patch writes', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ room: model, revision: 'next' }) };
  });
  await ui.replaceStageRoom(model, 'current');
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method, options.headers['If-Match']]), [['/api/stage/room', 'PUT', 'current']]);
});

test('clearing a room also requires the loaded revision', async (t) => {
  let call;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    call = options;
    return { ok: true, json: async () => ({ room: null, revision: 'empty' }) };
  });
  await ui.replaceStageRoom(null, 'current');
  assert.deepEqual([call.method, call.headers['If-Match'], call.body], ['DELETE', 'current', undefined]);
});

test('editing a binding preserves other bindings and room geometry', () => {
  const original = { ...model, bindings: [binding('a', 10), binding('b', 20)] };
  const changed = binding('a', 10); changed.position.x = 2;
  const next = ui.withRoomBinding(original, changed, 'a');
  assert.deepEqual(next.bindings, [original.bindings[1], changed]);
  assert.equal(next.objects, original.objects);
  assert.equal(original.bindings[0].position.x, 1);
});

test('unplaced fixtures expose a placement action', () => {
  const markup = ui.render(ui.h(ui.StageRoomPanel, { snapshot: { room: model, revision: 'current' }, fixtures, rig,
    coverage: roomRig(fixtures, rig, model), onChange() {} }));
  assert.equal((markup.match(/>Place<\/button>/g) || []).length, 2);
});
