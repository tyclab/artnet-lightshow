// One card per look; both mappings remain playable with outputs disarmed.

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

test('the Spatial group lists each effect once and keeps old ids available', async ({ page, request }) => {
  await open(page, 'effects');
  const group = page.locator('details.effects-group').filter({ has: page.locator('summary', { hasText: /^Spatial$/ }) });
  await group.locator('summary').click();
  const s = await state(request);
  expect(s.patterns.filter((p) => p.family === 'spatial' && !p.retired)).toHaveLength(NAMES.length);
  await expect(group.locator('.pattern-btn')).toHaveCount(NAMES.length);
  await expect(group.getByText(/^Popcorn(?: 2D)?$/)).toHaveCount(0);
  for (const name of NAMES) {
    const row = s.patterns.find((p) => p.name === name && p.family === 'spatial');
    expect(row, name).toBeTruthy();
    await expect(group.locator(`[data-id="${row.id}"]`)).toContainText(name);
    expect(s.patterns.find((p) => p.id === `${row.id}.2d`)?.retired).toBe(true);
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
    // The crest lights each lamp only as it passes: thousands of pixels change at the pass, a faint
    // glow of hundreds around it, none in between, and a still Stage (clock stopped) changes none.
    expect(await stageMotion(page, id), `${id} moves`).toBeGreaterThanOrEqual(50);
  }
  expect((await state(request)).armed).toBe(false);
});

test('a built-in mapping can be played without saving and stays on its single card', async ({ page, request }) => {
  const library = await (await request.get('/api/effects')).json();
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Groove Wave');
  await page.getByRole('button', { name: 'Edit Groove Wave', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await expect(sheet.getByLabel('Mapping', { exact: true })).toHaveValue('room');
  await expect(sheet.getByLabel('Speed', { exact: true })).toBeVisible();
  await expect(sheet.getByLabel('Elevation (degrees)')).toBeHidden();
  await sheet.getByText('Advanced', { exact: true }).click();
  await expect(sheet.getByLabel('Elevation (degrees)')).toBeVisible();
  await sheet.getByLabel('Mapping', { exact: true }).selectOption('plan');
  await expect(sheet.locator('.effect-inspector-head strong')).toHaveText('Groove Wave');
  await expect(sheet.locator('.insp-dirty')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Play', exact: true }).click();
  await until(request, (s) => s.pattern === 'v2.grooveWave.2d');
  await sheet.getByRole('button', { name: 'Close the inspector' }).click();
  const cards = page.locator('.effects-catalogue .pattern-btn');
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute('data-id', 'v2.grooveWave.2d');
  await expect(cards).toContainText('Across layout');
  await expect(cards).toHaveAttribute('aria-pressed', 'true');
  expect(await (await request.get('/api/effects')).json()).toEqual(library);
  expect((await state(request)).armed).toBe(false);
});

test('a legacy favourite retains its layout mapping and can be unpinned without duplication', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('lightshow.effects.favourites', JSON.stringify(['ldj.GrooveWave', 'v2.grooveWave'])));
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Groove Wave');
  const pad = page.locator('.effects-deck .effect-pad');
  await expect(pad).toHaveCount(1);
  await expect(pad).toHaveAttribute('data-id', 'v2.grooveWave.2d');
  await pad.locator('.effect-pad-tap').click();
  await until(request, (s) => s.pattern === 'v2.grooveWave.2d');
  await pad.getByRole('button', { name: 'Favourite Groove Wave', exact: true }).click();
  await expect(pad).toHaveCount(0);
  await expect(page.locator('.effects-catalogue .pattern-btn')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lightshow.effects.favourites')))).toEqual([]);
});

test('mapping appears only when the edited effect uses positions', async ({ page }) => {
  await open(page, 'effects');
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  for (const name of ['Wash', 'Breathe', 'Path Runner', 'All Strobe']) {
    await page.getByLabel('Search effects').fill(name);
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).first().click();
    await expect(sheet.getByLabel('Mapping', { exact: true })).toHaveCount(0);
    if (name === 'Path Runner') {
      await sheet.getByText('Advanced', { exact: true }).click();
      await sheet.getByLabel('Order', { exact: true }).selectOption('axis');
      await expect(sheet.getByLabel('Mapping', { exact: true })).toHaveValue('room');
      await sheet.getByLabel('Order', { exact: true }).selectOption('random');
      await expect(sheet.getByLabel('Mapping', { exact: true })).toHaveCount(0);
    }
    await sheet.getByRole('button', { name: 'Close the inspector' }).click();
  }
});

test('changing mapping on an edited draft preserves edits and saves the chosen space', async ({ page, request }) => {
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Groove Wave');
  await page.getByRole('button', { name: 'Edit Groove Wave', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await sheet.getByLabel('Speed', { exact: true }).fill('0.3');
  await sheet.getByLabel('Mapping', { exact: true }).selectOption('plan');
  await expect(sheet.getByLabel('Speed', { exact: true })).toHaveValue('0.3');
  await expect(sheet.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Save as…' }).click();
  await sheet.getByLabel('Preset name').fill('E2E layout mapping draft');
  await sheet.getByRole('button', { name: 'Save copy' }).click();
  const s = await until(request, (s) => s.effects.some((e) => e.name === 'E2E layout mapping draft'));
  const id = s.effects.find((e) => e.name === 'E2E layout mapping draft').id;
  try {
    const lib = await (await request.get('/api/effects')).json();
    const spec = lib.user.find((p) => p.id === id).spec;
    expect(spec.params.space).toBe('plan');
    expect(spec.params.speed).toBe(0.3);
    await sheet.getByRole('button', { name: 'Play', exact: true }).click();
    await until(request, (s) => s.pattern === id);
  } finally {
    await reset(request);
    await request.delete(`/api/effects/${id}`);
  }
});

test('playing a hidden rapid mapping still requires acknowledgement', async ({ page, request }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
  try {
    await open(page, 'effects');
    await page.getByLabel('Search effects').fill('Scatter Strobe');
    await page.getByRole('button', { name: 'Edit Scatter Strobe', exact: true }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Edit effect' });
    await sheet.getByLabel('Mapping', { exact: true }).selectOption('plan');
    await sheet.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: 'Rapid flashing' })).toBeVisible();
    expect((await state(request)).pattern).toBe('chase');
    expect((await state(request)).armed).toBe(false);
  } finally {
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: settings.safety.photosensitivityAcknowledged } } });
  }
});
