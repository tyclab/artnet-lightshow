import { test, expect } from '@playwright/test';
import { open, state } from './helpers.js';
import { stageImage } from './stage-image.js';

const look = (s) => Object.fromEntries(['armed', 'running', 'masterDimmer', 'masterBlackout', 'pattern', 'basePalette',
  'paletteOverride', 'colorA', 'colorB', 'colorC', 'colorD', 'voices', 'safety'].map((key) => [key, s[key]]));

test('demo audition animates room and plot while every live control keeps its state', async ({ page, request }) => {
  const before = look(await state(request));
  expect(before.armed).toBe(false);
  await open(page, 'stage');
  const mutations = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') mutations.push(`${r.method()} ${r.url()}`); });
  await page.getByRole('button', { name: 'Audition effects', exact: true }).click();
  const picker = page.getByLabel('Audition effect', { exact: true });
  await picker.selectOption('v2.neural');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /auditioning.*browser only/);
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
  await page.getByLabel('Audition position', { exact: true }).fill('7800');
  await expect(page.locator('[data-audition-section]')).toHaveAttribute('data-audition-section', 'drop');
  const room = await stageImage(page);
  expect(room.lum).toBeGreaterThan(0);
  await page.getByRole('button', { name: '2D plot', exact: true }).click();
  const surface = page.getByRole('group', { name: 'Stage layout, viewed from the audience' });
  await expect(surface).toBeVisible();
  const lights = await surface.locator('.stage-fixture').evaluateAll((nodes) => nodes.map((node) => node.style.getPropertyValue('--light')));
  expect(lights.some((colour) => /^rgb\(/.test(colour) && (colour.match(/\d+/g) || []).some((channel) => Number(channel) > 40))).toBe(true);
  await picker.selectOption('v2.scatterStrobe');
  const allow = page.getByRole('button', { name: 'Allow flashing in this browser preview' });
  if (await allow.isVisible()) await allow.click();
  await picker.selectOption('v2.neural.2d');
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
  await page.getByLabel('Audition position', { exact: true }).fill('16000');
  await expect(page.locator('[data-audition-section]')).toHaveAttribute('data-audition-section', 'breakdown');
  expect(look(await state(request))).toEqual(before);
  expect(mutations).toEqual([]);
  await page.getByRole('button', { name: 'Close audition', exact: true }).click();
  await expect(page.getByLabel('Audition effect', { exact: true })).toHaveCount(0);
});

test('palette sliders preserve auxiliary emitters and hue pair is a draft until applied', async ({ page, request }) => {
  await open(page, 'perform');
  const before = look(await state(request));
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
  expect(look(await state(request))).toEqual(before);
});

test('a diagonal draft auditions with explicit floor-to-height endpoints without saving it', async ({ page, request }) => {
  const before = look(await state(request));
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Groove Wave');
  await page.getByRole('button', { name: 'Edit Groove Wave', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await sheet.getByLabel('Use explicit from point', { exact: true }).check();
  await sheet.getByLabel('Use explicit to point', { exact: true }).check();
  await sheet.getByLabel('Start height (metres)', { exact: true }).fill('0.1');
  await sheet.getByLabel('End X (metres)', { exact: true }).fill('2');
  await sheet.getByLabel('End height (metres)', { exact: true }).fill('2.4');
  await sheet.getByLabel('End Z (metres)', { exact: true }).fill('3');
  await expect(sheet).toContainText('Y height above the floor');
  const writes = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') writes.push(r.url()); });
  await sheet.getByRole('button', { name: 'Audition on Stage', exact: true }).click();
  await expect(page.getByLabel('Audition effect', { exact: true })).toHaveValue('draft:v2.grooveWave');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /auditioning Groove Wave/);
  expect(look(await state(request))).toEqual(before);
  expect(writes).toEqual([]);
});
