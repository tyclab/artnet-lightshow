// The Spatial group: every v2 preset in the room and as its 2D twin, played on the Stage with
// outputs disarmed (Preview look draws what arming would send). Never arms.

import { test, expect } from '@playwright/test';
import { open, previewLook, reset, set, state, until } from './helpers.js';
import { stageImage } from './stage-image.js';

const NAMES = ['Scatter Strobe', 'Scatter Fade', 'Scatter Grow', 'Popcorn', 'Groove Wave', 'Big Room Wave', 'Ascent', 'Double Wave', 'Swagger',
  'Impact', 'Vortex', 'Speaker Shockwave', 'Rotation', 'Swirl', 'Beacon', 'Neural', 'Neural Distance',
  'Beat Accent Wash', 'Volume Gate Wash', 'Frequency Burst'];

test.beforeEach(async ({ request }) => {
  await request.post('/api/outputs/disarm');
  await reset(request);
});

test.afterEach(async ({ request }) => {
  await reset(request);
});

test('the Spatial group lists every effect in the room and in 2D', async ({ page, request }) => {
  await open(page, 'effects');
  const group = page.locator('details.effects-group').filter({ has: page.locator('summary', { hasText: /^Spatial$/ }) });
  await group.locator('summary').click();
  const s = await state(request);
  for (const name of NAMES) {
    for (const shown of [name, `${name} 2D`]) {
      const row = s.patterns.find((p) => p.name === shown && p.family === 'spatial');
      expect(row, shown).toBeTruthy();
      await expect(group.locator(`[data-id="${row.id}"]`)).toContainText(shown);
    }
  }
  // A plain tap plays the room form; the strobes ask first, the waves do not.
  await group.locator('[data-id="v2.grooveWave"]').click();
  await until(request, (st) => st.pattern === 'v2.grooveWave');
  expect((await state(request)).armed).toBe(false);
});

test('a Spatial preset and its 2D twin move on the Stage while disarmed', async ({ page, request }) => {
  await set(request, { pattern: 'v2.grooveWave', basePalette: { colours: ['#FF0000000000', '#0000FF000000'] }, overridePalette: null });
  await open(page, 'stage');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /lights drawn off/);
  await previewLook(page);
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /previewing with outputs disarmed/);
  for (const id of ['v2.grooveWave', 'v2.grooveWave.2d']) {
    await set(request, { pattern: id });
    await until(request, (st) => st.pattern === id);
    const frames = [];
    for (let k = 0; k < 8; k++) {
      frames.push(await stageImage(page));
      await page.waitForTimeout(150);
    }
    expect(Math.max(...frames.map((f) => f.lum)), `${id} lights the stage`).toBeGreaterThan(2);
    const spread = Math.max(...frames.map((f) => f.r)) - Math.min(...frames.map((f) => f.r))
      + Math.max(...frames.map((f) => f.b)) - Math.min(...frames.map((f) => f.b));
    expect(spread, `${id} moves`).toBeGreaterThan(0.3);
  }
  expect((await state(request)).armed).toBe(false);
});
