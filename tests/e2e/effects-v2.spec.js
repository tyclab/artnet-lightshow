// The Spatial group: every v2 preset in the room and as its 2D twin, played on the Stage with
// outputs disarmed (Preview look draws what arming would send). Never arms.

import { test, expect } from '@playwright/test';
import { open, previewLook, reset, set, state, until } from './helpers.js';
import { stageImage, stageMotion } from './stage-image.js';

const NAMES = ['Scatter Strobe', 'Scatter Fade', 'Scatter Grow', 'Groove Wave', 'Big Room Wave', 'Ascent', 'Double Wave', 'Swagger',
  'Impact', 'Vortex', 'Speaker Shockwave', 'Rotation', 'Swirl', 'Beacon', 'Neural', 'Neural Distance',
  'Beat Accent Wash', 'Volume Gate Wash', 'Frequency Burst', 'Wash', 'Breathe', 'Chase', 'Path Runner', 'Surround',
  'Zones', 'Surround Answer', 'Near and Far', 'Drifting Clouds', 'Aurora', 'Fire', 'Rising Wall', 'Falling Wall',
  'Light Orbs', 'Orb Collision', 'Fireworks', 'Rain', 'Stems in Space', 'Visualizer Flow', 'Visualizer Drift'];

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
  expect(s.patterns.filter((p) => p.family === 'spatial' && !p.retired)).toHaveLength(NAMES.length * 2);
  await expect(group.getByText(/^Popcorn(?: 2D)?$/)).toHaveCount(0);
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
    await stageImage(page, { remember: id });
    // The crest lights each lamp only as it passes: thousands of pixels change for a moment, none
    // in between, and a still Stage (clock stopped) changes none at all.
    expect(await stageMotion(page, id), `${id} moves`).toBeGreaterThanOrEqual(200);
  }
  expect((await state(request)).armed).toBe(false);
});
