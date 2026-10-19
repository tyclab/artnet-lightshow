import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { placeRig, lightRGB, STAGE_W, STAGE_D, TRUSS_H } from './public-src/stage3d/world.js';
    import { buildRig } from './src/shared/rig.ts';
    document.body.innerHTML = '<div style="width:960px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    const scene = createStageScene(canvas, { haze: 0, lightRGB,
      room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } });
    scene.resize();
    window.stageColour = ({ kind, count, protocol, red, colour, colours }) => {
      const channelMap = { red: 0, green: 1, blue: 2 };
      const profile = { channelMap, ...(count > 1 ? {
        cells: Array.from({ length: count }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) } : {}) };
      const fixture = { id: 1, profileId: 'test', output: { protocol },
        position: { x: 50, y: 50, height: 1.9 / TRUSS_H * 100 }, geometry: { length: 8, angle: 0 },
        emission: { kind, pan: 0, tilt: 0 } };
      const rig = buildRig([fixture], () => profile);
      scene.setRig(placeRig([fixture], { test: profile }, rig), rig.units.length);
      scene.setLights(rig.units.map((_, i) => colours?.[i] || colour || { r: red, g: 0, b: 0 }));
      scene.render();
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
      const peaks = [0, 0, 0], saturated = [0, 0, 0];
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const rgb = [...pixels.slice(i, i + 3)];
        if (Math.min(...rgb) > 200) white++;
        for (let c = 0; c < 3; c++) {
          peaks[c] = Math.max(peaks[c], rgb[c]);
          if (rgb[c] > 200 && rgb.every((v, k) => k === c || v < 8)) saturated[c]++;
        }
      }
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
      return { colour: at(copy.width / 2, copy.height / 2), halo: at(copy.width / 2 + 10, copy.height / 2),
        white, peaks, saturated, shape: scene.info() };
    };
  ` },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

for (const shape of [
  { name: 'Hue bulb', kind: 'bulb', count: 1, protocol: 'hue', bulbs: 1 },
  { name: 'directional Hue lamp', kind: 'beam', count: 1, protocol: 'hue', pars: 1 },
  { name: 'single-zone strip', kind: 'strip', count: 1, protocol: 'ddp', cells: 16 },
  { name: 'Hue gradient strip', kind: 'strip', count: 3, protocol: 'hue', cells: 3 },
]) {
  test(`Stage keeps saturated and dim red coloured on a ${shape.name}`, async ({ page }) => {
    await page.goto('about:blank');
    await page.addScriptTag({ content: script });
    for (const red of [255, 32]) {
      const result = await page.evaluate((input) => window.stageColour(input), { ...shape, red });
      const [r, g, b] = result.colour;
      expect(r).toBeGreaterThan(20);
      expect(Math.max(g, b), `red ${red}: ${result.colour}`).toBeLessThan(8);
      for (const key of ['bulbs', 'pars', 'cells']) expect(result.shape[key]).toBe(shape[key] || 0);
      if (red === 255 && shape.kind !== 'strip') expect(result.halo[0]).toBeGreaterThan(Math.max(...result.halo.slice(1)) + 15);
    }
    const off = await page.evaluate((input) => window.stageColour(input), { ...shape, red: 0 });
    expect(Math.min(...off.colour)).toBeGreaterThan(20);
    expect(Math.max(...off.colour) - Math.min(...off.colour)).toBeLessThan(3);
  });
}

test('dense strip sections retain orange without accumulating white glow', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  for (const count of [1, 3, 64, 256]) {
    const result = await page.evaluate((input) => window.stageColour(input),
      { kind: 'strip', protocol: 'ddp', count, colour: { r: 255, g: 128, b: 64 } });
    expect(result.white, `${count} sections`).toBe(0);
    expect(result.peaks[0]).toBeGreaterThan(200);
    expect(result.peaks[1]).toBeGreaterThan(100);
    expect(result.peaks[1]).toBeLessThan(140);
    expect(result.peaks[2]).toBeLessThan(80);
  }
  const dark = await page.evaluate(() => window.stageColour({ kind: 'strip', protocol: 'ddp', count: 256, red: 0 }));
  expect(Math.max(...dark.peaks)).toBeLessThan(60);
});

test('Hue gradient sections keep distinct red, green and blue colours', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(() => window.stageColour({ kind: 'strip', protocol: 'hue', count: 3,
    colours: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }] }));
  expect(result.saturated.every((pixels) => pixels > 5), JSON.stringify(result)).toBe(true);
  expect(result.white).toBe(0);
});
