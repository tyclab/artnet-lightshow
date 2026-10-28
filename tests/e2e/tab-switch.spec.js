import { test, expect } from '@playwright/test';
import { open, previewLook, set, state } from './helpers.js';

// Every WebGL context the page makes, and whether it is still alive, in the document or out of it.
function countContexts() {
  const made = [];
  const getContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    if (context && /webgl/.test(type) && !made.some((entry) => entry.context === context)) made.push({ canvas: this, context });
    return context;
  };
  window.webglContexts = () => ({
    made: made.length,
    live: made.filter(({ canvas, context }) => canvas.isConnected && !context.isContextLost()).length,
    detached: made.filter(({ canvas, context }) => !canvas.isConnected && !context.isContextLost()).length,
  });
}

/** Red and green pixels on the stage plot's cell layer. */
const cellPixels = (page) => page.locator('canvas.stage-cells-canvas').evaluate((canvas) => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let red = 0, green = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 150 && data[i + 1] < 80) red++;
    if (data[i + 1] > 150 && data[i] < 80) green++;
  }
  return { red, green };
});

/** A 128-cell bar profile patched four times, lit solid red and previewed while disarmed. */
async function redBars(request) {
  const profileId = 'e2e-tab-switch';
  expect((await request.post('/api/profiles/bar', { data: { id: profileId, name: 'Switch strip', cells: 128, firstChannel: 1, order: 'RGB' } })).ok()).toBe(true);
  const response = await request.post('/api/fixtures', { data: { profileId, count: 4, universe: 7 } });
  expect(response.ok()).toBe(true);
  const added = (await response.json()).fixtures;
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] }, overridePalette: null, masterBlackout: false, running: true });
  return async () => {
    for (const id of added) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${profileId}`);
  };
}

const restore = (request, before) => set(request, { pattern: before.pattern, basePalette: before.basePalette,
  overridePalette: before.overridePalette, masterBlackout: before.masterBlackout, running: before.running });

test('switching between Show and Effects keeps one WebGL context for the room', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.addInitScript(countContexts);
  const before = await state(request);
  const remove = await redBars(request);
  try {
    await open(page, 'show');
    await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
    for (let round = 0; round < 4; round++) {
      await page.locator('#tab-effects').click();
      await expect(page.getByRole('group', { name: 'Stage layout, viewed from the audience' })).toBeVisible();
      await page.locator('#tab-show').click();
      await expect(page.getByRole('img', { name: /The rig in 3D/ })).toBeVisible();
    }
    expect(await page.evaluate(() => window.webglContexts())).toEqual({ made: 1, live: 1, detached: 0 });
  } finally {
    await remove();
    await restore(request, before);
  }
});

test('the Effects stage plot paints bar cells on one canvas, and the swatches follow, from the live feed', async ({ page, request }) => {
  const before = await state(request);
  const remove = await redBars(request);
  try {
    await open(page, 'effects');
    await previewLook(page);
    const plot = page.getByRole('group', { name: 'Stage layout, viewed from the audience' });
    await expect(plot.locator('canvas.stage-cells-canvas')).toHaveCount(1);
    await expect(plot.locator('.stage-cell')).toHaveCount(0);
    await expect.poll(async () => (await cellPixels(page)).red).toBeGreaterThan(500);
    await set(request, { basePalette: { colours: ['#00FF00'] } });
    await expect.poll(async () => cellPixels(page)).toMatchObject({ red: 0 });
    expect((await cellPixels(page)).green).toBeGreaterThan(500);
    const lamps = plot.locator('.stage-fixture.bar');
    await expect(lamps).toHaveCount(4);
    expect(await lamps.evaluateAll((nodes) => nodes.map((node) => node.style.getPropertyValue('--light')))).toEqual(Array(4).fill('rgb(0,255,0)'));
    const swatches = page.locator('.fixture-preview[title="128 cells"]');
    await expect(swatches).toHaveCount(4);
    for (const background of await swatches.evaluateAll((nodes) => nodes.map((node) => node.style.background))) {
      expect(background).toMatch(/^linear-gradient\(90deg, rgb\(0, 255, 0\)/);
      expect(background).not.toMatch(/rgb\(255, 0, 0\)/);
    }
  } finally {
    await remove();
    await restore(request, before);
  }
});

test('the bars above each view are measured again for the sticky offsets after a view switch', async ({ page }) => {
  await open(page, 'show');
  const bars = { header: '.app-header', commands: '.command-bar', views: '.mode-nav', effects: '.effects-tools' };
  const offsets = () => page.evaluate((bars) => {
    const css = getComputedStyle(document.documentElement);
    return Object.entries(bars).map(([name, selector]) => {
      const element = document.querySelector(selector);
      return { name, variable: parseFloat(css.getPropertyValue(`--${name}-height`)), height: element ? element.getBoundingClientRect().height : 0 };
    }).filter(({ variable, height }) => !(Math.abs(variable - height) < 0.5));
  }, bars);
  for (const view of ['effects', 'show', 'stage', 'effects', 'sequence']) {
    await page.locator(`#tab-${view}`).click();
    await page.locator(`#panel-${view}`).waitFor();
    await expect.poll(offsets).toEqual([]);
  }
});
