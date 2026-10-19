import { test, expect } from '@playwright/test';
import { open, set, state } from './helpers.js';
import { stageImage } from './stage-image.js';

for (const frameInterval of [0, 100]) test(`Stage idles between visible changes and redraws lights and camera input${frameInterval ? ' at 10 Hz' : ''}`, async ({ page, request }) => {
  await page.addInitScript((frameInterval) => {
    const raf = window.requestAnimationFrame.bind(window);
    window.stageTicks = 0;
    window.requestAnimationFrame = callback => {
      const tick = now => { window.stageTicks++; callback(now); };
      return frameInterval ? window.setTimeout(() => tick(performance.now()), frameInterval) : raf(tick);
    };
    if (frameInterval) window.cancelAnimationFrame = handle => window.clearTimeout(handle);
    window.stageWork = { draws: 0, uploads: 0 };
    for (const [name, key] of [['drawElements', 'draws'], ['drawElementsInstanced', 'draws'], ['drawArrays', 'draws'],
      ['drawArraysInstanced', 'draws'], ['bufferSubData', 'uploads']]) {
      const original = window.WebGL2RenderingContext.prototype[name];
      window.WebGL2RenderingContext.prototype[name] = function (...args) { window.stageWork[key]++; return original.apply(this, args); };
    }
  }, frameInterval);
  const before = await state(request);
  const profileId = 'e2e-stage-performance';
  let added = [];
  const counters = () => page.evaluate(() => ({ ...window.stageWork }));
  const idle = async () => {
    await expect.poll(async () => {
      const start = await page.evaluate(() => ({ draws: window.stageWork.draws, ticks: window.stageTicks }));
      await page.waitForTimeout(150);
      return page.evaluate(start => ({ draws: window.stageWork.draws - start.draws, advancing: window.stageTicks > start.ticks }), start);
    }).toEqual({ draws: 0, advancing: true });
  };
  try {
    const profile = await request.post('/api/profiles/bar', { data: { id: profileId, name: 'Performance strip', cells: 1024, firstChannel: 1, order: 'RGB' } });
    expect(profile.ok()).toBe(true);
    const fixtures = await request.post('/api/fixtures', { data: { profileId, count: 1, universe: 7 } });
    expect(fixtures.ok()).toBe(true);
    added = (await fixtures.json()).fixtures;
    await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] }, overridePalette: null, masterBlackout: false });
    await open(page, 'stage');
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(0);
    await idle();
    const still = await counters();
    await page.locator('.stage3d-canvas').click();
    await page.waitForTimeout(300);
    expect(await counters()).toEqual(still);

    await page.locator('.stage3d-canvas').press('ArrowRight');
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(still.draws);
    await idle();
    const moved = await counters();
    expect(moved.uploads).toBe(still.uploads);
    const box = await page.locator('.stage3d-canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(moved.draws);
    await idle();
    expect((await counters()).uploads).toBe(moved.uploads);
    await set(request, { basePalette: { colours: ['#00FF00'] } });
    await expect.poll(async () => (await counters()).uploads).toBeGreaterThan(moved.uploads);
    await expect.poll(async () => { const image = await stageImage(page); return image.g - image.r; }).toBeGreaterThan(1);
    await idle();
    const green = await counters();
    await page.setViewportSize({ width: 1180, height: 800 });
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(green.draws);
    await idle();
  } finally {
    for (const id of added) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${profileId}`);
    await set(request, { pattern: before.pattern, basePalette: before.basePalette, overridePalette: before.overridePalette,
      masterBlackout: before.masterBlackout });
  }
});
