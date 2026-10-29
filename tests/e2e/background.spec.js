import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

test('background modes and six-channel colour persist without changing transport gates', async ({ page, request }) => {
  await reset(request);
  const initial = await state(request);
  await open(page, 'effects');
  const panel = page.getByRole('region', { name: 'Background lighting' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Fixed colour', exact: true }).click();
  const level = panel.getByRole('slider', { name: 'Background level' });
  await level.fill('34');
  await panel.getByRole('slider', { name: 'White', exact: true }).fill('83');
  await panel.getByRole('slider', { name: 'Amber', exact: true }).fill('61');
  await panel.getByRole('slider', { name: 'UV', exact: true }).fill('47');
  const fixed = await until(request, s => s.background?.level === .34 && s.background.colour.uv === 47);
  expect(fixed.running).toBe(initial.running);
  expect(fixed.armed).toBe(initial.armed);
  expect(fixed.masterBlackout).toBe(initial.masterBlackout);
  await page.reload();
  await expect(panel.getByRole('button', { name: 'Fixed colour', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('slider', { name: 'White', exact: true })).toHaveValue('83');
  await request.post('/api/set', { data: { pattern: 'solid' } });
  expect((await state(request)).background).toEqual(fixed.background);
  await panel.getByRole('button', { name: 'Off', exact: true }).click();
  await until(request, s => s.background?.mode === 'off');
  await expect(level).toBeDisabled();
  await panel.getByRole('button', { name: 'Follow effect', exact: true }).click();
  await until(request, s => s.background?.mode === 'follow');
  await expect(level).toHaveValue('34');
});

test('background fixtures: wash fixtures and a picked set persist, and the pick is kept while another scope is chosen', async ({ page, request }) => {
  await reset(request);
  await request.post('/api/set', { data: { background: { version: 1, mode: 'fixed', level: .4, colour: { r: 255, g: 120, b: 0, w: 0, a: 0, uv: 0 } } } });
  const { fixtures } = await state(request);
  expect(fixtures.length).toBeGreaterThan(1);
  await open(page, 'effects');
  const panel = page.getByRole('region', { name: 'Background lighting' });
  const scope = panel.getByRole('combobox', { name: 'Background fixtures' });
  await expect(scope).toHaveValue('rig');
  await scope.selectOption('wash');
  await until(request, (s) => s.background?.fixtures === 'wash');
  await expect(panel).toContainText(`of ${fixtures.length} fixtures: the single-light ones`);

  await scope.selectOption('selected');
  const picker = panel.getByRole('group', { name: 'Fixtures the background reaches' });
  await expect(picker.getByRole('checkbox')).toHaveCount(fixtures.length);
  await picker.getByRole('checkbox', { name: fixtures[1].label }).check();
  await picker.getByRole('checkbox', { name: fixtures[0].label }).check();
  const picked = await until(request, (s) => s.background?.fixtures === 'selected' && s.background.selected?.length === 2);
  expect(picked.background.selected).toEqual([fixtures[0].id, fixtures[1].id]);
  expect(picked.background.mode).toBe('fixed');
  await expect(panel).toContainText(`2 of ${fixtures.length} fixtures picked`);

  await page.reload();
  await expect(scope).toHaveValue('selected');
  await expect(picker.getByRole('checkbox', { name: fixtures[0].label })).toBeChecked();
  await scope.selectOption('rig');
  const whole = await until(request, (s) => s.background?.fixtures === 'rig');
  expect(whole.background.selected).toEqual([fixtures[0].id, fixtures[1].id]);
  await expect(picker).toHaveCount(0);
  await scope.selectOption('selected');
  await expect(picker.getByRole('checkbox', { name: fixtures[1].label })).toBeChecked();
  await request.post('/api/set', { data: { background: { version: 1, mode: 'follow', level: 1, colour: { r: 255, g: 160, b: 70, w: 0, a: 0, uv: 0 } } } });
});
