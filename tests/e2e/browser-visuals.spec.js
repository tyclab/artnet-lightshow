import { test, expect } from '@playwright/test';
import { pageAction, matchesTarget } from '../../tools/browser-visuals/browser.js';

test('display preserves artwork until a usable visualizer appears, and restores it when unavailable', async ({ page }) => {
  const expected = 'http://music.invalid/#/now-playing?player=test&frameless=1';
  await page.route('http://music.invalid/**', route => route.fulfill({ contentType: 'text/html', body:
    '<div class="now-playing-view"><div class="now-playing-artwork">Artwork</div><div class="now-playing-info">Track</div><div class="now-playing-timeline">Position</div></div>' }));
  await page.goto(expected);
  const display = () => page.evaluate(`(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'display', visible: true })}, ${matchesTarget.toString()})`);
  const absent = await display();
  await expect(page.getByText('Artwork')).toBeVisible();
  await expect(page.getByText('Track')).toBeVisible();
  expect(absent).toMatchObject({ ok: true, live: false, reason: 'visualizer-unavailable' });
  await page.evaluate(() => document.querySelector('.now-playing-view').insertAdjacentHTML('beforeend',
    '<div class="visualizer-layer" style="opacity:1"><canvas class="visualizer-layer__canvas" width="64" height="64"></canvas></div>'));
  expect(await display()).toMatchObject({ ok: true, live: true, reason: null });
  await expect(page.getByText('Artwork')).toBeHidden();
  await page.evaluate(() => document.querySelector('.visualizer-layer').style.opacity = '0');
  expect(await display()).toMatchObject({ live: false, reason: 'visualizer-idle' });
  await expect(page.getByText('Artwork')).toBeVisible();
  await page.evaluate(() => document.querySelector('.visualizer-layer').remove());
  expect(await display()).toMatchObject({ live: false, reason: 'visualizer-unavailable' });
  await expect(page.getByText('Track')).toBeVisible();
});

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
    globalThis.displayMutations = 0;
    new globalThis.MutationObserver(records => { globalThis.displayMutations += records.length; }).observe(document.querySelector('.now-playing-view'), { attributes: true, attributeFilter: ['data-party-display'] });
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
  expect(await page.evaluate(() => globalThis.displayMutations)).toBe(1);
  expect((await capture(68, 42, false)).data.every(value => value === 0)).toBe(true);
  expect(await page.evaluate(() => globalThis.displayMutations)).toBe(2);
  const rafs = await page.evaluate(() => globalThis.captureRafs);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => globalThis.captureRafs)).toBe(rafs);
  await page.evaluate(`(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'cleanup' })}, ${matchesTarget.toString()})`);
  expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabCaptureCanvases)).toBeUndefined();
});

test('asynchronous GPU capture preserves pixels and bounds pending work across replacement and blackout', async ({ page }) => {
  const { gpuCapture } = await import('../../tools/browser-visuals/gpu-capture.js');
  const expected = 'http://music.invalid/#/now-playing?player=test&frameless=1';
  await page.route('http://music.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="now-playing-view"><canvas class="visualizer-layer__canvas" width="64" height="64"></canvas></div>' }));
  await page.goto(expected);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), context = canvas.getContext('2d');
    for (const [color, x, y] of [['red', 0, 0], ['lime', 32, 0], ['blue', 0, 32], ['white', 32, 32]]) {
      context.fillStyle = color; context.fillRect(x, y, 32, 32);
    }
  });
  const capture = (width = 4, height = 4, visible = true, fit = 'cover') => page.evaluate(`(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'capture', width, height, fit, visible, fps: 44 })}, ${matchesTarget.toString()}, ${gpuCapture.toString()})`);
  const first = await capture();
  expect(first.ok).toBe(true);
  for (const [pixel, colour] of [[0, [255, 0, 0]], [3, [0, 255, 0]], [12, [0, 0, 255]], [15, [255, 255, 255]]]) expect(first.data.slice(pixel * 3, pixel * 3 + 3)).toEqual(colour);
  const together = await Promise.all([capture(), capture()]);
  expect(together[0]).toEqual(together[1]);
  expect(await page.evaluate(() => [...document.querySelector('.now-playing-view').__tyclabGpuCaptures.values()].every(slot => slot.pending.length + slot.buffers.length === 3))).toBe(true);
  expect((await capture(4, 4, false)).data.every(value => value === 0)).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabGpuCaptures)).toBeUndefined();
  await page.evaluate(() => {
    const old = document.querySelector('canvas'), canvas = old.cloneNode();
    canvas.width = 64; canvas.height = 32;
    const context = canvas.getContext('2d'); context.fillStyle = '#ff00ff'; context.fillRect(0, 0, 64, 32);
    old.replaceWith(canvas);
  });
  const letterbox = await capture(4, 4, true, 'contain');
  expect(letterbox.data.slice(0, 12)).toEqual(Array(12).fill(0));
  expect(letterbox.data.slice(12, 15)).toEqual([255, 0, 255]);
  const covered = await capture();
  expect(covered.data.slice(0, 3)).toEqual([255, 0, 255]);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas'); canvas.width = 32; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#00ffff'; context.fillRect(0, 0, 32, 64);
  });
  expect((await capture()).data.slice(0, 3)).toEqual([0, 255, 255]);
  for (let width = 5; width <= 9; width++) expect((await capture(width)).ok).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabGpuCaptures.size)).toBeLessThanOrEqual(4);
  await page.evaluate(() => {
    globalThis.captureSlots = [...document.querySelector('.now-playing-view').__tyclabGpuCaptures.values()];
    globalThis.captureReadPixels = 0;
    const original = globalThis.WebGL2RenderingContext.prototype.readPixels;
    globalThis.WebGL2RenderingContext.prototype.readPixels = function (...args) { globalThis.captureReadPixels++; return original.apply(this, args); };
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => globalThis.captureReadPixels)).toBe(0);
  await page.evaluate(`(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'cleanup' })}, ${matchesTarget.toString()}, ${gpuCapture.toString()})`);
  expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabGpuCaptures)).toBeUndefined();
  expect(await page.evaluate(() => globalThis.captureSlots.every(slot => slot.disposed && slot.pending.length === 0))).toBe(true);
});

test('GPU fences time out without synchronous readback and navigation invalidates pending pictures', async ({ page }) => {
  const { gpuCapture } = await import('../../tools/browser-visuals/gpu-capture.js');
  const expected = 'http://music.invalid/#/now-playing?player=test&frameless=1';
  await page.route('http://music.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="now-playing-view"><canvas class="visualizer-layer__canvas" width="64" height="64"></canvas></div>' }));
  await page.goto(expected);
  await page.evaluate(() => {
    globalThis.originalFence = globalThis.WebGL2RenderingContext.prototype.clientWaitSync;
    globalThis.WebGL2RenderingContext.prototype.clientWaitSync = function () { return this.TIMEOUT_EXPIRED; };
    globalThis.WebGL2RenderingContext.prototype.getBufferSubData = () => { throw new Error('Must not read an unsignalled buffer'); };
  });
  const expression = `(${pageAction.toString()})(${JSON.stringify({ expected, mode: 'capture', width: 4, height: 4, fit: 'cover', visible: true })}, ${matchesTarget.toString()}, ${gpuCapture.toString()})`;
  expect((await page.evaluate(expression)).ok).toBe(false);
  expect(await page.evaluate(() => [...document.querySelector('.now-playing-view').__tyclabGpuCaptures.values()][0].pending.length)).toBe(3);
  const pending = page.evaluate(expression);
  await page.evaluate(() => { globalThis.location.hash = '/now-playing?player=other&frameless=1'; });
  expect((await pending).ok).toBe(false);
});

test('dedicated CDP attachment captures and releases its page implementation', async ({ browser }) => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { connectPage, captureCanvas } = await import('../../tools/browser-visuals/browser.js');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-cdp-'));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true, args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
  const expected = 'http://music.invalid/#/now-playing?player=test&frameless=1';
  let helper;
  try {
    await context.route('http://music.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="now-playing-view"><canvas class="visualizer-layer__canvas" width="64" height="64"></canvas></div>' }));
    const page = context.pages()[0]; await page.goto(expected);
    await page.evaluate(() => { const c = document.querySelector('canvas').getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0, 0, 64, 64); });
    helper = await connectPage(profile, expected);
    const image = await captureCanvas(helper, { width: 4, height: 4, fit: 'cover', fps: 44 });
    expect([...image.data.slice(0, 3)]).toEqual([255, 0, 0]);
    await helper.close(); helper = null;
    expect(await page.evaluate(() => document.querySelector('.now-playing-view').__tyclabGpuCaptures)).toBeUndefined();
  } finally { await helper?.close(); await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
});
