import { test, expect } from '@playwright/test';
import { open, state, until } from './helpers.js';

test('hardware disclosure controls are at least 44 pixels high', async ({ page }) => {
  await open(page, 'settings');
  const summaries = page.locator('.hardware-limits summary');
  expect(await summaries.count()).toBeGreaterThan(0);
  for (const summary of await summaries.all()) expect((await summary.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test('product and device limits save and return to inherited values', async ({ page, request }) => {
  const previous = (await (await request.get('/api/settings')).json()).settings.hardware;
  const fixture = (await state(request)).fixtures[0];
  await open(page, 'settings');
  const hardware = page.locator('section', { has: page.locator('#hardware-title') });
  await hardware.getByLabel('New product name').fill('Browser product');
  await hardware.getByLabel('Output technology').selectOption('dmx');
  await hardware.getByRole('button', { name: 'Add product limits' }).click();
  await expect(hardware.locator('summary', { hasText: 'Browser product' })).toBeVisible();
  try {
    await open(page, 'rig');
    await page.locator(`.plan-surface [data-fixture="${fixture.id}"]`).click();
    const panel = page.locator('.inspector');
    await panel.locator('summary', { hasText: 'Hardware capability' }).click();
    await panel.getByLabel('Product', { exact: true }).selectOption('browser-product');
    await panel.getByLabel('When unsupported', { exact: true }).selectOption('hold');
    await panel.getByLabel('Maximum flashes / second', { exact: true }).fill('2');
    await panel.getByLabel('Maximum flashes / second', { exact: true }).press('Enter');
    await until(request, (s) => s.fixtures[0].hardware?.maxFlashHz === 2 && s.fixtures[0].admission === 'hold');
    await page.reload();
    await page.locator(`.plan-surface [data-fixture="${fixture.id}"]`).click();
    await panel.locator('summary', { hasText: 'Hardware capability' }).click();
    await expect(panel.getByLabel('Maximum flashes / second', { exact: true })).toHaveValue('2');
    await panel.getByRole('button', { name: 'Use inherited limits' }).click();
    await panel.getByLabel('Product', { exact: true }).selectOption('');
    await panel.getByLabel('When unsupported', { exact: true }).selectOption('max');
    await until(request, (s) => !s.fixtures[0].hardware && !s.fixtures[0].productId && s.fixtures[0].admission === 'max');
  } finally {
    await request.put('/api/settings', { data: { hardware: previous } });
  }
});

test('physical light shape, beam aim and strip length survive show export and reload', async ({ page, request }) => {
  const original = await (await request.get('/api/show')).json();
  const fixture = (await state(request)).fixtures[0];
  const selectFixture = async () => {
    await open(page, 'rig');
    await page.locator(`.plan-surface [data-fixture="${fixture.id}"]`).click();
  };
  try {
    await selectFixture();
    const panel = page.locator('.inspector');
    await panel.getByLabel('Light shape', { exact: true }).selectOption('beam');
    await panel.getByLabel('Beam pan', { exact: true }).fill('75');
    await panel.getByLabel('Beam pan', { exact: true }).press('Enter');
    await panel.getByLabel('Beam tilt', { exact: true }).fill('-25');
    await panel.getByLabel('Beam tilt', { exact: true }).press('Enter');
    await panel.getByLabel('Beam spread', { exact: true }).fill('38');
    await panel.getByLabel('Beam spread', { exact: true }).press('Enter');
    await until(request, (s) => s.fixtures.find((f) => f.id === fixture.id)?.emission?.beamAngle === 38);
    const show = await (await request.get('/api/show')).json();
    expect(show.fixtures.find((f) => f.id === fixture.id).emission).toEqual({ kind: 'beam', pan: 75, tilt: -25, beamAngle: 38 });
    await page.reload();
    await selectFixture();
    await expect(panel.getByLabel('Beam pan', { exact: true })).toHaveValue('75');
    await panel.getByLabel('Light shape', { exact: true }).selectOption('strip');
    await panel.getByLabel('Length', { exact: true }).fill('35');
    await panel.getByLabel('Length', { exact: true }).press('Enter');
    await until(request, (s) => s.fixtures.find((f) => f.id === fixture.id)?.geometry?.length === 35);
    await expect(panel.getByLabel('Beam pan', { exact: true })).toHaveCount(0);
  } finally {
    await request.post('/api/show', { data: original });
  }
});
