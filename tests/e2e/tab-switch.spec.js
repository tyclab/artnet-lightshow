import { test, expect } from '@playwright/test';
import { open, previewLook, set, state } from './helpers.js';

/** Red and green pixels on the stage plot's cell layer. */
const cellPixels = (page) => page.locator('canvas.stage-cells-canvas').evaluate((canvas) => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let red = 0, green = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 150 && data[i + 1] < 80) red++;
    if (data[i + 1] > 150 && data[i] < 80) green++;
  }
  return { red, green };
});

/** A 128-cell bar profile patched four times, lit solid red and previewed while disarmed. */
async function redBars(request) {
  const profileId = 'e2e-tab-switch';
  expect((await request.post('/api/profiles/bar', { data: { id: profileId, name: 'Switch strip', cells: 128, firstChannel: 1, order: 'RGB' } })).ok()).toBe(true);
  const response = await request.post('/api/fixtures', { data: { profileId, count: 4, universe: 7 } });
  expect(response.ok()).toBe(true);
  const added = (await response.json()).fixtures;
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] }, overridePalette: null, masterBlackout: false, running: true });
  return async () => {
    for (const id of added) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${profileId}`);
  };
}

const restore = (request, before) => set(request, { pattern: before.pattern, basePalette: before.basePalette,
  overridePalette: before.overridePalette, masterBlackout: before.masterBlackout, running: before.running });

test('the Effects stage plot paints bar cells on one canvas from the live feed', async ({ page, request }) => {
  const before = await state(request);
  const remove = await redBars(request);
  try {
    await open(page, 'effects');
    await previewLook(page);
    const plot = page.getByRole('group', { name: 'Stage layout, viewed from the audience' });
    await expect(plot.locator('canvas.stage-cells-canvas')).toHaveCount(1);
    await expect(plot.locator('.stage-cell')).toHaveCount(0);
    await expect.poll(async () => (await cellPixels(page)).red).toBeGreaterThan(500);
    await set(request, { basePalette: { colours: ['#00FF00'] } });
    await expect.poll(async () => cellPixels(page)).toMatchObject({ red: 0 });
    expect((await cellPixels(page)).green).toBeGreaterThan(500);
    const lamps = plot.locator('.stage-fixture.bar');
    await expect(lamps).toHaveCount(4);
    expect(await lamps.evaluateAll((nodes) => nodes.map((node) => node.style.getPropertyValue('--light')))).toEqual(Array(4).fill('rgb(0,255,0)'));
  } finally {
    await remove();
    await restore(request, before);
  }
});
