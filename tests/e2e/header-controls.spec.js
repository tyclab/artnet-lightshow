import { test, expect } from '@playwright/test';
import { open, previewLook, reset, state, until } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await request.post('/api/auto/stop');
  await request.delete('/api/sequence');
  await request.post('/api/outputs/disarm');
  await reset(request);
});

for (const width of [1280, 390]) {
  test(`Show controls remain usable after scrolling at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, 'show');
    await page.evaluate(() => { document.body.scrollTop = document.body.scrollHeight; });
    const header = page.locator('.app-header');
    const look = header.getByRole('button', { name: 'Look playback' });
    const blackout = header.getByRole('button', { name: 'Master blackout' });
    await expect(look).toBeInViewport();
    await expect(blackout).toBeInViewport();
    await look.click();
    await until(request, s => s.running === false);
    await look.click();
    await until(request, s => s.running === true);
    await blackout.click();
    await until(request, s => s.masterBlackout === true);
    await blackout.click();
    await until(request, s => s.masterBlackout === false);
  });
}

test('header controls work in setup, and preview playback never rearms a disarmed rig', async ({ page, request }) => {
  await open(page, 'settings');
  const header = page.locator('.app-header');
  await header.getByRole('button', { name: 'Arm outputs', exact: true }).click();
  await until(request, s => s.armed === true);
  await header.getByRole('button', { name: 'Disarm outputs', exact: true }).click();
  await until(request, s => s.armed === false && s.running === false);
  await header.getByRole('button', { name: 'Look playback' }).click();
  await until(request, s => s.running === true);
  expect((await state(request)).armed).toBe(false);
  const blackout = header.getByRole('button', { name: 'Master blackout' });
  await blackout.click();
  await until(request, s => s.masterBlackout === true);
  await blackout.click();
  await until(request, s => s.masterBlackout === false);
});

test('the disarmed preview choice survives reloads and can be switched off', async ({ page, request }) => {
  await open(page, 'show');
  await previewLook(page);
  await page.reload();
  const preview = page.getByRole('button', { name: 'Preview look' }).first();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  expect((await state(request)).armed).toBe(false);
  await preview.click();
  await page.reload();
  await expect(preview).toHaveAttribute('aria-pressed', 'false');
  expect((await state(request)).armed).toBe(false);
});
