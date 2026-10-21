import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import * as THREE from 'three';
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { lightRGB } from './public-src/stage3d/world.js';
    document.body.innerHTML = '<div style="width:800px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    let disposedLights = 0;
    const disposeLight = THREE.Light.prototype.dispose;
    THREE.Light.prototype.dispose = function() { disposedLights++; disposeLight.call(this); };
    let materials = [];
    const addObject = THREE.Group.prototype.add;
    THREE.Group.prototype.add = function(...objects) {
      for (const object of objects) if (object.material?.isMeshLambertMaterial) materials.push(object.material);
      return addObject.apply(this, objects);
    };
    const scene = createStageScene(canvas, { haze: 0, lightRGB, room: { width: 6, depth: 4, trussHeight: 3 } });
    scene.resize();
    window.meshRoom = model => { materials = []; scene.setRoom(model); scene.render(); return { image: canvas.toDataURL(), disposedLights }; };
    window.meshRig = objectLights => { scene.setRig({ lamps: [], cells: [], trusses: [], objectLights }, 2); };
    window.meshFrame = frame => { scene.setLights(frame); scene.setHaze(0); scene.render(); return { image: canvas.toDataURL(), materials: materials.map(material => ({ color: material.color.toArray(), emissive: material.emissive.toArray(), emissiveIntensity: material.emissiveIntensity })), info: scene.info() }; };
    window.disposeMeshRoom = () => { scene.dispose(); return disposedLights; };
  ` }, bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

test('replacing and clearing a mesh room releases its lights and preserves the rendered shape', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [{
    id: 'sculpture', kind: 'mesh', role: 'furniture', position: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, color: '#aabbdd',
    mesh: { vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0, 0.5, -0.5], [0, 0, 0.5]], triangles: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] },
  }] };
  const first = await page.evaluate(model => window.meshRoom(model), model);
  const repeated = await page.evaluate(model => window.meshRoom(model), model);
  expect(repeated.disposedLights).toBe(2);
  expect(repeated.image).toBe(first.image);
  const cleared = await page.evaluate(() => window.meshRoom(null));
  expect(cleared.disposedLights).toBe(4);
  expect(cleared.image).not.toBe(first.image);
  await page.evaluate(model => window.meshRoom(model), model);
  expect(await page.evaluate(() => window.disposeMeshRoom())).toBe(6);
});


test('a mesh shell emits its effective binding RGB and restores its base when dark', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const shell = { id: 'shell', lightBindingId: 'lamp', kind: 'mesh', role: 'furniture',
    position: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, color: '#c4dbea',
    mesh: { vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0, 0.5, -0.5], [0, 0, 0.5]], triangles: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] } };
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [shell,
    { ...shell, id: 'base', lightBindingId: undefined, position: { x: 2, y: 0.5, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 } },
    { id: 'led', kind: 'cylinder', role: 'furniture', lightBindingId: 'lamp', color: '#eeeeee', position: { x: -2, y: 1, z: 0 }, size: { x: 0.1, y: 0.02, z: 0.1 } }] };
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }] }, { objectId: 'led', sources: [{ unit: 1, weight: 1 }] }]));
  await page.evaluate(model => window.meshRoom(model), model);
  const off = await page.evaluate(() => window.meshFrame([{}]));
  const red = await page.evaluate(() => window.meshFrame([{ r: 255 }, { g: 255 }]));
  expect(red.materials[0].emissive).toEqual([1, 0, 0]);
  expect(red.materials[0].color).toEqual([0.35, 0, 0]);
  expect(red.materials[0].emissiveIntensity).toBe(0.25);
  expect(red.materials[1]).toEqual(off.materials[1]);
  expect(red.materials[2].emissive).toEqual([0, 1, 0]);
  expect(red.info.bulbs).toBe(0);
  expect(red.image).not.toBe(off.image);
  const dim = await page.evaluate(() => window.meshFrame([{ r: 128 }]));
  expect(dim.materials[0].emissive[0]).toBeCloseTo(0.21586, 5);
  const blue = await page.evaluate(() => window.meshFrame([{ b: 255 }]));
  expect(blue.materials[0].emissive).toEqual([0, 0, 1]);
  expect(blue.materials[0].color).toEqual([0, 0, 0.35]);
  expect(blue.image).not.toBe(red.image);
  const missing = await page.evaluate(() => window.meshFrame([]));
  expect(missing.materials[0].emissive).toEqual([0, 0, 0]);
  expect(missing.materials[0].color).toEqual(off.materials[0].color);
  expect(missing.image).toBe(off.image);
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }, { unit: null, weight: 3 }] }]));
  const weighted = await page.evaluate(() => window.meshFrame([{ r: 255 }]));
  expect(weighted.materials[0].emissive).toEqual([0.25, 0, 0]);
  await page.evaluate(() => window.meshRig([]));
  expect((await page.evaluate(() => window.meshFrame([{ r: 255 }]))).materials[0].emissive).toEqual([0, 0, 0]);
  await page.evaluate(() => window.disposeMeshRoom());
});


test('a material tint filters live RGB in linear space without changing white defaults or its dark base', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const shell = { id: 'shell', lightBindingId: 'lamp', kind: 'box', role: 'furniture',
    position: { x: 0, y: 1, z: 0 }, size: { x: 1, y: 1, z: 1 }, color: '#c4dbea' };
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [shell] };
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }] }]));
  await page.evaluate(model => window.meshRoom(model), model);
  const original = await page.evaluate(() => window.meshFrame([{ r: 160, g: 200, b: 255 }]));
  shell.lightTint = '#ffffff';
  await page.evaluate(model => window.meshRoom(model), model);
  expect(await page.evaluate(() => window.meshFrame([{ r: 160, g: 200, b: 255 }]))).toEqual(original);
  shell.lightTint = '#8080ff';
  await page.evaluate(model => window.meshRoom(model), model);
  const off = await page.evaluate(() => window.meshFrame([{}]));
  const white = await page.evaluate(() => window.meshFrame([{ r: 255, g: 255, b: 255 }]));
  expect(white.materials[0].emissive[0]).toBeCloseTo(0.2158605, 6);
  expect(white.materials[0].emissive[1]).toBeCloseTo(0.2158605, 6);
  expect(white.materials[0].emissive[2]).toBe(1);
  const red = await page.evaluate(() => window.meshFrame([{ r: 255 }]));
  expect(red.materials[0].emissive.slice(1)).toEqual([0, 0]);
  const blue = await page.evaluate(() => window.meshFrame([{ b: 255 }]));
  expect(blue.materials[0].emissive).toEqual([0, 0, 1]);
  const dark = await page.evaluate(() => window.meshFrame([{}]));
  expect(dark.materials).toEqual(off.materials);
  expect(dark.image).toBe(off.image);
  await page.evaluate(() => window.disposeMeshRoom());
});
