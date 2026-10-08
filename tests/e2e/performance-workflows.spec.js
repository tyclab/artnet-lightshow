import { test, expect } from '@playwright/test';
import { open, reset, set, state, until } from './helpers.js';

test.beforeEach(async ({ request }) => { await request.delete('/api/sequence'); await request.delete('/api/performance/automation'); await reset(request); });
test.afterEach(async ({ request }) => { await request.delete('/api/performance/automation'); await request.delete('/api/sequence'); await reset(request); });

test('playlist preview is inert and Create loads editable stopped rows', async ({ page, request }) => {
  await open(page, 'sequence');
  await page.locator('.playlist-generator summary').click();
  await page.getByLabel('Playlist template').selectOption('universal');
  await page.getByLabel('Beats per row').fill('64');
  await page.getByRole('button', { name: 'Preview playlist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create playlist', exact: true })).toBeVisible();
  expect((await (await request.get('/api/sequence')).json()).sequence).toBeNull();
  await page.getByRole('button', { name: 'Create playlist', exact: true }).click();
  await until(request, (s) => s.sequence.loaded?.name === 'Universal Effects');
  const created = await (await request.get('/api/sequence')).json();
  expect(created.sequence.mode).toBe('playlist');
  expect(created.sequence.clips.length).toBeGreaterThan(5);
  expect(created.sequence.clips.every((c, i) => c.startBeat === i * 64 && c.lengthBeats === 64)).toBe(true);
  expect(created.status.playing).toBe(false);
});

test('live tempo automation applies from Perform and a manual edit ends the selected axis', async ({ page, request }) => {
  await open(page, 'perform');
  await page.locator('.live-automation summary').click();
  const tempo = page.locator('.live-automation > fieldset').first();
  await tempo.getByLabel('period in seconds', { exact: true }).fill('1');
  await tempo.getByLabel('period in seconds', { exact: true }).press('Enter');
  await tempo.getByLabel('target', { exact: true }).fill('150');
  await tempo.getByLabel('target', { exact: true }).press('Enter');
  await tempo.getByRole('button', { name: 'Start tempo automation', exact: true }).click();
  await until(request, (s) => s.bpm === 150 && !s.liveAutomation.tempo, { timeout: 5000 });
  const settings = { mode: 'sine', period: 8, min: 90, max: 140, growing: true };
  expect((await request.put('/api/performance/automation', { data: { axis: 'tempo', settings } })).ok()).toBe(true);
  await page.getByRole('button', { name: 'Half tempo', exact: true }).click();
  await until(request, (s) => !s.liveAutomation.tempo);
  expect((await state(request)).bpm).toBeLessThan(90);
  expect((await request.put('/api/performance/automation', { data: { axis: 'tempo', settings: { ...settings, max: 500 } } })).status()).toBe(400);
});

test('visualizer colour wells apply immediately and retain white, amber and UV', async ({ page, request }) => {
  const before = await state(request);
  const { settings } = await (await request.get('/api/settings')).json();
  const acknowledge = (value) => request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: value } } });
  try {
    // Every Visualizer preset flashes on hits, so it needs the acknowledgement.
    expect((await acknowledge(true)).ok()).toBe(true);
    await set(request, { pattern: 'ldj.visualizer.solid', overridePalette: { colours: ['#010203040506', '#AABBCC112233'] } });
    await open(page, 'perform');
    const wells = page.getByRole('region', { name: 'Lighting visualizer colours' });
    await wells.getByLabel('Hit colour', { exact: true }).fill('#ff0000');
    await until(request, (s) => s.paletteOverride?.[1] === '#FF0000112233');
    await wells.getByRole('button', { name: 'Shuffle visualizer colours' }).click();
    const colours = (await state(request)).paletteOverride;
    expect([...colours].sort()).toEqual(['#010203040506', '#FF0000112233'].sort());
  } finally {
    await set(request, { pattern: before.pattern, overridePalette: before.overridePalette ?? null });
    await acknowledge(!!settings.safety.photosensitivityAcknowledged);
  }
});

test('guided audio capture reports progress, applies only on request and cancels cleanly', async ({ page, request }) => {
  let tick = 0;
  await page.route('**/api/performance/input', (route) => route.fulfill({ json: { ok: true, listening: true, source: 'input', reading: { t: tick++ / 4, bpm: 128, locked: true } } }));
  await open(page, 'perform');
  await page.locator('.bpm-capture summary').click();
  await page.getByRole('button', { name: 'Start tempo capture', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Tempo capture progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use captured tempo' })).toBeVisible({ timeout: 16000 });
  expect((await state(request)).bpm).toBe(120);
  await page.getByRole('button', { name: 'Use captured tempo' }).click();
  await until(request, (s) => s.bpm === 128);
  await page.getByRole('button', { name: 'Start tempo capture', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel capture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use captured tempo' })).toHaveCount(0);
});
