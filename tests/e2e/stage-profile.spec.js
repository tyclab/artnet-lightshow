import { test, expect } from '@playwright/test';
import { open, state } from './helpers.js';

test('the mounted Stage refreshes cells when a profile is replaced under the same ID', async ({ page, request }) => {
  const before = await state(request);
  const profile = { id: 'e2e-stage-bar', name: 'Stage bar', cells: 2, firstChannel: 1, order: 'RGB' };
  const save = async (cells) => {
    const response = await request.post('/api/profiles/bar', { data: { ...profile, cells } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  let added = [];
  try {
    await save(2);
    const response = await request.post('/api/fixtures', { data: { profileId: profile.id, count: 1, universe: 7 } });
    expect(response.ok(), await response.text()).toBe(true);
    added = (await response.json()).fixtures;
    await open(page, 'stage');
    const stage = page.getByRole('img', { name: /The rig in 3D/ });
    const mounted = await stage.elementHandle();
    await expect(stage).toHaveAttribute('aria-label', new RegExp(`${before.fixtures.length + 2} lights`));

    await save(6);
    await expect(stage).toHaveAttribute('aria-label', new RegExp(`${before.fixtures.length + 6} lights`));
    await save(3);
    await expect(stage).toHaveAttribute('aria-label', new RegExp(`${before.fixtures.length + 3} lights`));
    expect(await mounted.evaluate((canvas) => canvas.isConnected)).toBe(true);
  } finally {
    for (const id of added) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${profile.id}`);
  }
});
