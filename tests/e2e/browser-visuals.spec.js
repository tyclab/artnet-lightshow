import { test, expect } from '@playwright/test';
import { pageAction, matchesTarget } from '../../tools/browser-visuals/browser.js';

test('WebGL captures share bounded canvases, follow replacement and clear on cleanup', async ({ page }) => {
  const expected = 'http://music.invalid/#/now-playing?player=test&frameless=1';
  await page.route('http://music.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="now-playing-view"><canvas class="visualizer-layer__canvas" width="128" height="72"></canvas></div>' }));
  await page.goto(expected);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const raf = globalThis.requestAnimationFrame;
    globalThis.captureRafs = 0;
    globalThis.requestAnimationFrame = callback => raf(time => { globalThis.captureRafs++; callback(time); });
  });
  const capture = (width, height, visible = true) => page.evaluate(`(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'capture', width, height, fit: 'cover', visible })}, ${matchesTarget.toString()})`);
  for (let i = 0; i < 3; i++) {
    const [panel, room] = await Promise.all([capture(68, 42), capture(64, 36)]);
    for (const image of [panel, room]) {
      expect(image.ok).toBe(true);
      expect(image.data.length).toBe(image.width * image.height * 3);
      expect(image.data.slice(0, 3)).toEqual([255, 0, 0]);
    }
  }
  expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabCaptureCanvases.size)).toBe(2);
  await page.evaluate(() => {
    const replacement = document.createElement('canvas'); replacement.className = 'visualizer-layer__canvas';
    replacement.width = 80; replacement.height = 40;
    const ctx = replacement.getContext('2d'); ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 80, 40);
    document.querySelector('canvas').replaceWith(replacement);
  });
  expect((await capture(68, 42)).data.slice(0, 3)).toEqual([0, 0, 255]);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas'); canvas.width = 40; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 40, 80);
  });
  expect((await capture(68, 42)).data.slice(0, 3)).toEqual([0, 255, 0]);
  expect((await capture(68, 42, false)).data.every(value => value === 0)).toBe(true);
  const rafs = await page.evaluate(() => globalThis.captureRafs);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => globalThis.captureRafs)).toBe(rafs);
  await page.evaluate(`(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'cleanup' })}, ${matchesTarget.toString()})`);
  expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabCaptureCanvases)).toBeUndefined();
});
