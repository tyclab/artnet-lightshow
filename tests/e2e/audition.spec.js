import { test, expect } from '@playwright/test';
import { open, state } from './helpers.js';
import { stageImage } from './stage-image.js';
import { protectedState, watchControlWrites } from './audition-isolation.js';

test('demo audition animates room and plot while every live control keeps its state', async ({ page, request }) => {
  const before = await protectedState(request), writes = watchControlWrites(page);
  expect(before.state.armed).toBe(false);
  expect(before.state.safety.photosensitivityAcknowledged).toBe(false);
  await open(page, 'stage');
  const unlit = await stageImage(page);
  await page.getByRole('button', { name: 'Audition effects', exact: true }).click();
  const picker = page.getByLabel('Audition effect', { exact: true });
  await picker.selectOption('v2.neural');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /auditioning.*browser only/);
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
  await page.getByLabel('Audition position', { exact: true }).fill('7800');
  await expect(page.locator('[data-audition-section]')).toHaveAttribute('data-audition-section', 'drop');
  const room = await stageImage(page);
  expect(room.lum - unlit.lum).toBeGreaterThan(0.5);
  expect(room.litShare - unlit.litShare).toBeGreaterThan(0.003);
  await page.getByRole('button', { name: '2D plot', exact: true }).click();
  const surface = page.getByRole('group', { name: 'Stage layout, viewed from the audience' });
  await expect(surface).toBeVisible();
  const lights = await surface.locator('.stage-fixture').evaluateAll((nodes) => nodes.map((node) => node.style.getPropertyValue('--light')));
  expect(lights.some((colour) => /^rgb\(/.test(colour) && (colour.match(/\d+/g) || []).some((channel) => Number(channel) > 40))).toBe(true);
  await picker.selectOption('v2.scatterStrobe');
  const allow = page.getByRole('button', { name: 'Allow flashing in this browser preview' });
  await expect(allow).toBeVisible();
  await allow.click();
  await picker.selectOption('v2.neural');
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
  await page.getByLabel('Audition position', { exact: true }).fill('16000');
  await expect(page.locator('[data-audition-section]')).toHaveAttribute('data-audition-section', 'breakdown');
  await page.getByRole('button', { name: 'Restart demo', exact: true }).click();
  await expect(page.getByLabel('Audition position', { exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Audition position', { exact: true }).inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close audition', exact: true }).click();
  await expect(page.getByLabel('Audition effect', { exact: true })).toHaveCount(0);
  expect(await protectedState(request)).toEqual(before);
  expect(writes).toEqual([]);
});

test('palette sliders preserve auxiliary emitters and hue pair is a draft until applied', async ({ page, request }) => {
  const before = await protectedState(request), writes = watchControlWrites(page);
  await open(page, 'perform');
  const strip = page.locator('.palette-strip');
  await strip.getByRole('button', { name: 'Edit palette', exact: true }).click();
  const editor = strip.locator('.palette-editor');
  const hex = editor.getByLabel('Colour 1', { exact: true });
  await hex.fill('#FF0000112233');
  await hex.press('Enter');
  await editor.getByLabel('Colour 1 hue', { exact: true }).fill('180');
  await expect(hex).toHaveValue('#00FFFF112233');
  await editor.getByLabel('Colour 1 saturation', { exact: true }).fill('0');
  await expect(hex).toHaveValue('#FFFFFF112233');
  await editor.getByLabel('Colour 1 saturation', { exact: true }).fill('100');
  await expect(hex).toHaveValue('#00FFFF112233');
  await editor.locator('.hue-pair > summary').click();
  await editor.getByLabel('Pair hue', { exact: true }).fill('0');
  await editor.getByLabel('Pair saturation', { exact: true }).fill('100');
  await editor.getByRole('button', { name: 'Use hue pair', exact: true }).click();
  await expect(hex).toHaveValue('#FF0000');
  await expect(editor.getByLabel('Colour 2', { exact: true })).toHaveValue('#00FFFF');
  expect(await protectedState(request)).toEqual(before);
  expect(writes).toEqual([]);
});

test('a diagonal draft auditions with explicit floor-to-height endpoints without saving it', async ({ page, request }) => {
  const before = await protectedState(request), writes = watchControlWrites(page);
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Groove Wave');
  await page.getByRole('button', { name: 'Edit Groove Wave', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await sheet.getByText('Advanced', { exact: true }).click();
  await sheet.getByLabel('Use explicit from point', { exact: true }).check();
  await sheet.getByLabel('Use explicit to point', { exact: true }).check();
  await sheet.getByLabel('Start height (metres)', { exact: true }).fill('0.1');
  await sheet.getByLabel('End X (metres)', { exact: true }).fill('2');
  await sheet.getByLabel('End height (metres)', { exact: true }).fill('2.4');
  await sheet.getByLabel('End Z (metres)', { exact: true }).fill('3');
  await expect(sheet).toContainText('Y height above the floor');
  await sheet.getByRole('button', { name: 'Audition on Stage', exact: true }).click();
  await expect(page.getByLabel('Audition effect', { exact: true })).toHaveValue('draft:v2.grooveWave');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /auditioning Groove Wave/);
  expect(await protectedState(request)).toEqual(before);
  expect(writes).toEqual([]);
});

test('saved effect and its edited palette audition without updating the library or live controls', async ({ page, request }) => {
  const created = await request.post('/api/effects', { data: { name: 'Audition saved wash', spec: {
    kind: 'v2.wash', params: {}, palette: ['#FF0000', '#00FFFF'], brightness: 1,
  } } });
  expect(created.ok()).toBe(true);
  const { preset } = await created.json();
  try {
    const before = await protectedState(request), writes = watchControlWrites(page);
    await open(page, 'stage');
    await page.getByRole('button', { name: 'Audition effects', exact: true }).click();
    await page.getByLabel('Audition effect', { exact: true }).selectOption(preset.id);
    await page.evaluate(() => { window.location.hash = 'effects'; });
    await page.getByLabel('Search effects').fill(preset.name);
    await page.getByRole('button', { name: `Edit ${preset.name}`, exact: true }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Edit effect' });
    await sheet.getByLabel('Colour 1 hue', { exact: true }).fill('120');
    await expect(sheet.getByLabel('Colour 1', { exact: true })).toHaveValue('#00FF00');
    await sheet.getByRole('button', { name: 'Audition on Stage', exact: true }).click();
    await expect(page.getByLabel('Audition effect', { exact: true })).toHaveValue(`draft:${preset.id}`);
    await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
    await page.getByLabel('Audition position', { exact: true }).fill('0');
    await page.getByRole('button', { name: '2D plot', exact: true }).click();
    const lights = await page.locator('.stage-fixture').evaluateAll((nodes) => nodes.map((node) => (node.style.getPropertyValue('--light').match(/\d+/g) || []).map(Number)));
    expect(lights).toContainEqual([0, 255, 0]);
    expect(await protectedState(request)).toEqual(before);
    expect(writes).toEqual([]);
  } finally { await request.delete(`/api/effects/${preset.id}`); }
});

test('arming ends Audition even after navigating away, and disarming never resumes it', async ({ page, request }) => {
  const original = await state(request);
  await request.post('/api/set', { data: { running: false } });
  try {
    const before = await protectedState(request), writes = watchControlWrites(page);
    await open(page, 'stage');
    for (const away of [false, true]) {
      await page.getByRole('button', { name: 'Audition effects', exact: true }).click();
      if (away) { await page.evaluate(() => { window.location.hash = 'effects'; }); await page.locator('#panel-effects').waitFor(); }
      expect((await request.post('/api/outputs/arm')).ok()).toBe(true);
      if (away) { await page.evaluate(() => { window.location.hash = 'stage'; }); }
      await expect(page.getByRole('button', { name: 'Audition effects', exact: true })).toBeDisabled();
      await expect(page.getByLabel('Audition effect', { exact: true })).toHaveCount(0);
      expect((await request.post('/api/outputs/disarm')).ok()).toBe(true);
      await expect(page.getByRole('button', { name: 'Audition effects', exact: true })).toBeEnabled();
      await expect(page.getByLabel('Audition effect', { exact: true })).toHaveCount(0);
    }
    expect(await protectedState(request)).toEqual(before);
    expect(writes).toEqual([]);
  } finally {
    await request.post('/api/outputs/disarm');
    await request.post('/api/set', { data: { running: original.running } });
  }
});
