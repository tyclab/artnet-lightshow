import { test, expect } from '@playwright/test';
import { open } from './helpers.js';

test('picture levels save while grading is off and survive a reload', async ({ page, request }) => {
  const before = (await (await request.get('/api/settings')).json()).settings.picture;
  try {
    const response = await request.put('/api/settings', { data: {
      picture: { source: 'visualizer', decode: false, blackPoint: 0.12, grade: { ...before.grade, enabled: false } },
    } });
    expect(response.ok()).toBeTruthy();
    await open(page, 'perform');
    const card = page.getByRole('region', { name: 'Picture colour grade' });
    const level = card.getByRole('slider', { name: 'Black point' });
    await expect(level).toBeEnabled();
    await expect(level).toHaveValue('12');
    await level.fill('25');
    await card.getByRole('checkbox', { name: /sRGB decode/ }).check();
    await expect.poll(async () => (await (await request.get('/api/picture')).json()).blackPoint).toBe(0.25);
    await expect.poll(async () => (await (await request.get('/api/picture')).json()).decode).toBe(true);
    await page.reload();
    await expect(level).toHaveValue('25');
    await expect(card.getByRole('checkbox', { name: /sRGB decode/ })).toBeChecked();
    await expect(card.getByRole('slider', { name: 'White limit', exact: true })).toBeDisabled();
  } finally {
    await request.put('/api/settings', { data: { picture: before } });
  }
});
