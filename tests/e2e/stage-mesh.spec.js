import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import * as THREE from 'three';
    import { createStageScene } from './public-src/stage3d/scene.js';
    document.body.innerHTML = '<div style="width:800px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    let disposedLights = 0;
    const disposeLight = THREE.Light.prototype.dispose;
    THREE.Light.prototype.dispose = function() { disposedLights++; disposeLight.call(this); };
    const scene = createStageScene(canvas, { haze: 0, lightRGB: () => [0, 0, 0], room: { width: 6, depth: 4, trussHeight: 3 } });
    scene.resize();
    window.meshRoom = model => { scene.setRoom(model); scene.render(); return { image: canvas.toDataURL(), disposedLights }; };
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
