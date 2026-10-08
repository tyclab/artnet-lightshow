import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

let paletteId;
test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await request.delete('/api/voices');
  await request.put('/api/matrix', { data: { mode: 'solid' } });
  const result = await (await request.post('/api/palettes', { data: { name: 'Matrix six emitters', colours: ['#123456789ABC', '#FF0000'] } })).json();
  paletteId = result.palette.id;
  await page.addInitScript(() => localStorage.removeItem('lightshow.matrix.palette'));
  await open(page, 'perform/matrix');
  await page.getByLabel('Matrix palette', { exact: true }).selectOption(paletteId);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/outputs/disarm');
  await request.delete('/api/voices');
  if (paletteId) await request.delete(`/api/palettes/${paletteId}`);
});

test('Disarming an idle Matrix clears its lock', async ({ page, request }) => {
  await request.post('/api/set', { data: { running: false } });
  await request.post('/api/outputs/arm');
  await until(request, (s) => s.armed && !s.running && !s.matrix.voice);
  const lock = page.getByRole('button', { name: 'Lock colours', exact: true });
  await lock.click();
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await request.post('/api/outputs/disarm');
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
});

test('Matrix lock renews full-emitter colours until unlocked', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Lock colours', exact: true }).click();
  await page.getByRole('button', { name: 'Colour #123456789abc', exact: true }).click();
  await until(request, (s) => s.matrix.colours.includes('#123456789ABC'));
  await expect.poll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return (await state(request)).matrix.colours;
  }).toEqual(['#123456789ABC']);
  await page.getByRole('button', { name: 'Lock colours', exact: true }).click();
  await until(request, (s) => s.matrix.colours.length === 0);
});

test('Changing Matrix palette releases locked cells', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Lock colours', exact: true }).click();
  await page.getByRole('button', { name: 'Colour #ff0000', exact: true }).click();
  await until(request, (s) => s.matrix.colours.length === 1);
  await page.getByRole('button', { name: 'Shuffle palette' }).click();
  await expect(page.getByLabel('Matrix palette', { exact: true })).not.toHaveValue(paletteId);
  await until(request, (s) => s.matrix.colours.length === 0);
});

test('Matrix lock releases when its page loses focus', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Lock colours', exact: true }).click();
  await page.getByRole('button', { name: 'Colour #ff0000', exact: true }).click();
  await until(request, (s) => s.matrix.colours.length === 1);
  await page.evaluate(() => window.dispatchEvent(new window.Event('blur')));
  await until(request, (s) => s.matrix.colours.length === 0);
  await expect(page.getByRole('button', { name: 'Lock colours', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('Locked Matrix presses still require rapid-flash acknowledgement', async ({ page, request }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  try {
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
    await page.getByRole('radio', { name: 'Flashes', exact: true }).click();
    await page.getByRole('button', { name: 'Lock colours', exact: true }).click();
    await page.getByRole('button', { name: 'Colour #ff0000', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: 'Rapid flashing' })).toBeVisible();
    expect((await state(request)).matrix.colours).toEqual([]);
  } finally {
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: settings.safety.photosensitivityAcknowledged } } });
  }
});
