// What the 3D stage builds when a view hands it a rig or a room (public-src/stage3d/scene.js),
// on three.js with the renderer stubbed: a return to Show with nothing changed builds nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.join(import.meta.dirname, '..', '..');
const three = JSON.stringify(path.join(root, 'node_modules/three/build/three.module.js'));
const built = await esbuild.build({
  stdin: { contents: `export { createStageScene } from './public-src/stage3d/scene.js';
    export { keptRig } from './public-src/stage3d/kept-rig.js';
    export { built } from 'scene-counts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'stub-renderer', setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: 'three', namespace: 'stub' }));
    build.onResolve({ filter: /^scene-counts$/ }, () => ({ path: 'counts', namespace: 'stub' }));
    build.onLoad({ filter: /^counts$/, namespace: 'stub' }, () => ({ contents: 'export const built = { instanced: 0, groups: 0 };' }));
    // Real three.js, but no WebGL: InstancedMesh is built per rig, a Group per rig and per room.
    build.onLoad({ filter: /^three$/, namespace: 'stub' }, () => ({ resolveDir: root, contents: `
      import * as THREE from ${three};
      import { built } from 'scene-counts';
      export * from ${three};
      export class WebGLRenderer { setPixelRatio() {} setClearColor() {} setSize() {} render() {} dispose() {} forceContextLoss() {} }
      export class InstancedMesh extends THREE.InstancedMesh { constructor(...args) { super(...args); built.instanced++; } }
      export class Group extends THREE.Group { constructor() { super(); built.groups++; } }` }));
  } }],
});
const ui = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const noop = () => {};
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop: noop }), fillRect: noop }) }) };
const page = { addEventListener: noop, removeEventListener: noop };
const canvas = { ...page, style: {}, ownerDocument: page, getRootNode: () => page, parentElement: null, getBoundingClientRect: () => ({ width: 800, height: 450 }) };
const scene = () => ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: () => [0, 0, 0] });

const BAR = { id: 'scene-bar', name: 'Bar', channelCount: 24, channelMap: {},
  cells: Array.from({ length: 8 }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const profiles = { [BAR.id]: BAR };
const bar = (x) => ({ id: 1, label: 'Bar', universe: 1, address: 1, profileId: BAR.id, position: { x, y: 40 } });
const room = (name) => ({ version: 1, name, bounds: { width: 4, depth: 4, height: 2.5 }, rooms: [], bindings: [],
  objects: [{ id: 'wall', kind: 'box', role: 'wall', position: { x: 0, y: 1, z: 0 }, size: { x: 1, y: 2, z: 0.1 } }] });
const rigBuilds = () => ui.built.instanced / 6;

test('a rig the scene shows already is not built again; a patch changed meanwhile is', () => {
  const stage = scene();
  const before = rigBuilds();
  // The live state hands every mount the same fixtures array until the patch changes.
  const patch = [bar(30)];
  const shown = ui.keptRig(patch, profiles, null);
  stage.setRig(shown.placed, shown.rig.units.length);
  assert.equal(rigBuilds() - before, 1);
  const back = ui.keptRig(patch, profiles, null);
  stage.setRig(back.placed, back.rig.units.length);
  assert.equal(rigBuilds() - before, 1, 'a return with the patch unchanged builds nothing');
  const moved = ui.keptRig([bar(60)], profiles, null);
  stage.setRig(moved.placed, moved.rig.units.length);
  assert.equal(rigBuilds() - before, 2, 'a bar moved while the view was away is built again');
});

test('a room the scene shows already is not built again; another room is', () => {
  const stage = scene();
  const first = room('First');
  const groups = () => ui.built.groups;
  const start = groups();
  stage.setRoom(first);
  assert.equal(groups() - start, 1);
  stage.setRoom(first);
  assert.equal(groups() - start, 1, 'the same room object builds nothing');
  stage.setRoom(room('Second'));
  assert.equal(groups() - start, 2);
  stage.setRoom(null);
  stage.setRoom(first);
  assert.equal(groups() - start, 3, 'after the generic venue, the room is built again');
});
