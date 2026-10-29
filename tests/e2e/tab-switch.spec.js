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

// Every shader program the page links, by the material three.js names in its source, and every draw call.
function countPrograms() {
  window.programLinks = [];
  window.draws = 0;
  for (const Context of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!Context) continue;
    for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced']) {
      const draw = Context.prototype[name];
      if (draw) Context.prototype[name] = function (...args) { window.draws++; return draw.apply(this, args); };
    }
    const { shaderSource, attachShader, linkProgram } = Context.prototype;
    const named = new WeakMap();
    Context.prototype.shaderSource = function (shader, source) {
      named.set(shader, (/#define SHADER_(?:TYPE|NAME) (\S+)/.exec(source) || [])[1]);
      return shaderSource.call(this, shader, source);
    };
    Context.prototype.attachShader = function (program, shader) {
      named.set(program, named.get(shader));
      return attachShader.call(this, program, shader);
    };
    Context.prototype.linkProgram = function (program) {
      window.programLinks.push(named.get(program));
      return linkProgram.call(this, program);
    };
  }
}

/** A digest of the cell layer's pixels: two pictures that differ anywhere give different digests. */
const cellDigest = (page) => page.locator('canvas.stage-cells-canvas').evaluate((canvas) => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let digest = 0;
  for (let i = 0; i < data.length; i++) digest = (Math.imul(digest, 31) + data[i]) | 0;
  return digest;
});

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

test('the Rig plan paints bar cells on one canvas that follows the live feed, with no getBoundingClientRect per frame', async ({ page, request }) => {
  await page.addInitScript(() => {
    const read = window.Element.prototype.getBoundingClientRect;
    window.layoutReads = 0;
    window.Element.prototype.getBoundingClientRect = function () { window.layoutReads++; return read.call(this); };
  });
  let frames = 0;
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => { if (typeof payload !== 'string') frames++; }));
  const before = await state(request);
  const remove = await redBars(request);
  try {
    await open(page, 'rig');
    const plan = page.getByRole('group', { name: /^Plan of the rig from above/ });
    await expect(plan.locator('canvas.stage-cells-canvas')).toHaveCount(1);
    await expect(plan.locator('.stage-cell.first')).toHaveCount(4);
    await expect(plan.locator('.stage-cell:not(.first)')).toHaveCount(0);
    await expect.poll(async () => (await cellPixels(page)).red).toBeGreaterThan(500);
    await set(request, { basePalette: { colours: ['#00FF00'] } });
    await expect.poll(async () => cellPixels(page)).toMatchObject({ red: 0 });
    expect((await cellPixels(page)).green).toBeGreaterThan(500);
    const lamps = plan.locator('.stage-fixture.bar');
    await expect(lamps).toHaveCount(4);
    expect(await lamps.evaluateAll((nodes) => nodes.map((node) => node.style.getPropertyValue('--light')))).toEqual(Array(4).fill('rgb(0,255,0)'));
    // A picture that changes on every frame of the feed: the canvas follows it.
    await set(request, { pattern: 'plasma' });
    await page.waitForTimeout(500);
    const sample = await cellDigest(page);
    await expect.poll(() => cellDigest(page)).not.toBe(sample);
    const start = { frames, reads: await page.evaluate(() => window.layoutReads) };
    await page.waitForTimeout(2000);
    expect(frames - start.frames).toBeGreaterThan(20);
    expect(await page.evaluate(() => window.layoutReads) - start.reads).toBeLessThan(5);
  } finally {
    await remove();
    await restore(request, before);
  }
});

test('a return to Show draws the room the scene built, rebuilding and compiling nothing again', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.addInitScript(countPrograms);
  const fixture = (await state(request)).fixtures[0];
  const roomOf = async () => (await request.get('/api/stage/room')).json();
  const replace = async (next) => {
    const { revision } = await roomOf();
    const result = next ? await request.put('/api/stage/room', { headers: { 'If-Match': revision }, data: next })
      : await request.delete('/api/stage/room', { headers: { 'If-Match': revision } });
    expect(result.ok()).toBe(true);
  };
  // A wall, and a lamp shade lit by its binding: plain and lit materials, as a scanned room has.
  await replace({
    version: 1, name: 'Switch room', bounds: { width: 6, depth: 4, height: 2.5 },
    rooms: [{ id: 'floor', label: 'Floor', polygon: [[-3, -2], [3, -2], [3, 2], [-3, 2]] }],
    objects: [
      { id: 'wall', kind: 'box', role: 'wall', position: { x: -2.9, y: 1.25, z: 0 }, size: { x: 0.2, y: 2.5, z: 4 } },
      { id: 'shade', kind: 'box', role: 'furniture', position: { x: 0, y: 1, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 }, lightBindingId: 'lamp' },
    ],
    bindings: [{ id: 'lamp', fixtureId: fixture.id, position: { x: 0, y: 1.2, z: 0 }, confidence: 'estimated' }],
  });
  const rooms = [];
  page.on('response', (response) => { if (new URL(response.url()).pathname === '/api/stage/room') rooms.push(response.status()); });
  try {
    await open(page, 'show');
    await expect(page.getByRole('img', { name: /The rig in 3D/ })).toBeVisible();
    // Settled: the room and the rig are drawn, every material linked once.
    await expect.poll(() => page.evaluate(() => window.programLinks.filter((name) => name === 'MeshLambertMaterial').length)).toBe(1);
    await page.waitForTimeout(500);
    const linked = await page.evaluate(() => window.programLinks.length);
    for (let round = 0; round < 3; round++) {
      await page.locator('#tab-effects').click();
      await expect(page.getByRole('group', { name: 'Stage layout, viewed from the audience' })).toBeVisible();
      const drawn = await page.evaluate(() => window.draws);
      await page.locator('#tab-show').click();
      await expect(page.getByRole('img', { name: /The rig in 3D/ })).toBeVisible();
      // The kept scene draws the room again in its new place.
      await expect.poll(() => page.evaluate(() => window.draws)).toBeGreaterThan(drawn);
      await page.waitForTimeout(500);
    }
    expect(await page.evaluate((from) => window.programLinks.slice(from), linked)).toEqual([]);
    // Each view still asks whether the room changed; the server answers that it has not.
    expect(rooms.length).toBeGreaterThan(3);
    expect(rooms.slice(1).every((status) => status === 304)).toBe(true);
  } finally {
    await replace(null);
  }
});
