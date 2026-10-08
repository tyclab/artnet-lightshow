// The Effects view: open a built-in in the inspector, change a setting, save
// it as a preset of your own, and find that preset in the list and the state.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { open, reset, state, until } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const NAME = 'E2E Domino';

async function removeOwn(request) {
  const s = await state(request);
  for (const e of s.effects || []) {
    if (e.name === NAME) await request.delete(`/api/effects/${encodeURIComponent(e.id)}`);
  }
}

test.beforeEach(async ({ request }) => {
  await reset(request);
  await removeOwn(request);
});

test.afterEach(async ({ request }) => {
  await removeOwn(request);
});

test('a built-in, changed and saved as a copy, lists as a preset of your own', async ({ page, request }) => {
  await open(page, 'effects');
  const search = page.getByLabel('Search effects');
  await search.fill('Neon Domino');
  // The inspector stays closed until Edit is chosen.
  await expect(page.getByRole('dialog', { name: 'Edit effect' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Neon Domino' }).first().click();

  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await expect(sheet.locator('.effect-inspector-head strong')).toHaveText('Neon Domino');
  await expect(sheet.locator('.effect-inspector-head')).toContainText('Built-in');
  await sheet.getByLabel('Stagger', { exact: true }).fill('0.25');
  await expect(sheet.locator('.insp-dirty')).toHaveText('Changed');

  await sheet.getByRole('button', { name: 'Save as…' }).click();
  await sheet.getByLabel('Preset name').fill(NAME);
  await sheet.getByRole('button', { name: 'Save copy' }).click();

  // The copy is in the state's effects key, and its spec carries the change.
  const s = await until(request, (st) => (st.effects || []).some((e) => e.name === NAME));
  const saved = s.effects.find((e) => e.name === NAME);
  const lib = await (await request.get('/api/effects')).json();
  const spec = lib.user.find((p) => p.id === saved.id).spec;
  expect(spec.params.stagger).toBe(0.25);
  expect(spec.kind).toBe('hd.positionChase');

  // The inspector moves to the copy, which saves in place from now on.
  await expect(sheet.locator('.effect-inspector-head strong')).toHaveText(NAME);
  await expect(sheet.locator('.effect-inspector-head')).toContainText('Yours');
  await sheet.getByRole('button', { name: 'Close the inspector' }).click();
  await expect(sheet).toHaveCount(0);

  // On the deck and in the catalogue, under the fork's own.
  await search.fill(NAME);
  await expect(page.locator('.effects-deck .effect-pad-name', { hasText: NAME })).toBeVisible();
  const own = page.locator('.effects-group', { has: page.locator('summary', { hasText: 'Own' }) });
  await expect(own.locator(`.pattern-btn[data-id="${saved.id}"]`)).toBeVisible();

  // A plain tap puts it on stage.
  await page.locator('.effects-deck .effect-pad-tap', { hasText: NAME }).click();
  await until(request, (st) => st.pattern === saved.id);
  await expect(page.locator('.effects-now .now-playing')).toContainText(NAME);
  await expect(page.locator('.effects-deck .effect-pad.active')).toHaveAttribute('data-layer', 'base');

  // The deck with a pad on stage, and the inspector over it, pass axe.
  await page.getByRole('button', { name: `Edit ${NAME}` }).first().click();
  await expect(sheet).toBeVisible();
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  expect(violations).toEqual([]);
});

async function editedDomino(page) {
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Neon Domino');
  await page.getByRole('button', { name: 'Edit Neon Domino' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await sheet.getByLabel('Stagger', { exact: true }).fill('0.25');
  return sheet;
}

test('audition holds the edited draft without saving or replacing the base', async ({ page, request }) => {
  const library = await (await request.get('/api/effects')).json();
  const sheet = await editedDomino(page);
  await expect(sheet.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  const audition = sheet.getByRole('button', { name: 'Hold to audition' });
  await audition.focus();
  await page.keyboard.down('Enter');
  try {
    const live = await until(request, (s) => s.voices.some((v) => v.spec.params.stagger === 0.25));
    expect(live.voices.find((v) => v.spec.params.stagger === 0.25).mode).toBe('hold');
    expect(live.pattern).toBe('chase');
    expect(await (await request.get('/api/effects')).json()).toEqual(library);
  } finally {
    await page.keyboard.up('Enter');
  }
  await until(request, (s) => s.voices.length === 0);
});

test('closing an audition releases its own voice and keeps another voice', async ({ page, request }) => {
  const sheet = await editedDomino(page);
  const launch = await request.post('/api/voices', { data: { preset: 'hd.neonDomino', mode: 'latched' } });
  expect(launch.ok()).toBe(true);
  const other = (await launch.json()).id;
  try {
    await sheet.getByRole('button', { name: 'Hold to audition' }).focus();
    await page.keyboard.down('Enter');
    await until(request, (s) => s.voices.length === 2);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    const live = await until(request, (s) => s.voices.length === 1);
    expect(live.voices[0].id).toBe(other);
  } finally {
    await page.keyboard.up('Enter');
    await request.delete(`/api/voices/${other}`);
  }
});

test('rapid draft audition requires acknowledgement and a fresh hold', async ({ page, request }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  const library = await (await request.get('/api/effects')).json();
  const preset = library.builtin.find((p) => p.spec?.kind === 'hd.frequencyBurst');
  const ack = (value) => request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: value } } });
  expect((await ack(false)).ok()).toBe(true);
  try {
    await open(page, 'effects');
    await page.getByLabel('Search effects').fill(preset.name);
    await page.getByRole('button', { name: `Edit ${preset.name}`, exact: true }).first().click();
    const audition = page.getByRole('button', { name: 'Hold to audition' });
    await audition.click();
    await expect(page.getByRole('alertdialog', { name: 'Rapid flashing' })).toBeVisible();
    expect((await state(request)).voices).toHaveLength(0);
    await page.getByRole('button', { name: 'I understand — play it' }).click();
    await expect(audition).not.toHaveAttribute('data-safety', 'ask');
    expect((await state(request)).voices).toHaveLength(0);
    await audition.focus();
    await page.keyboard.down('Enter');
    await until(request, (s) => s.voices.some((v) => v.kind === 'hd.frequencyBurst'));
  } finally {
    await page.keyboard.up('Enter');
    await until(request, (s) => s.voices.length === 0);
    expect((await ack(settings.safety.photosensitivityAcknowledged)).ok()).toBe(true);
  }
});

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });

  // Everything tappable in `root`, with its height, where under 44 px.
  const small = (page, root) => page.evaluate((sel) => [...document.querySelector(sel)
    .querySelectorAll('button, select, input:not([type=range]):not([type=checkbox]), label:has(input[type=checkbox]), summary')]
    .filter((el) => el.getClientRects().length)
    .map((el) => ({ what: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h < 44), root);

  test('the deck, the chips, the catalogue and the inspector are all at least 44 px', async ({ page }) => {
    await open(page, 'effects');
    await page.locator('.effects-group summary').first().click();
    expect(await small(page, '.card.effects')).toEqual([]);
    await page.getByRole('button', { name: 'Edit Neon Domino' }).first().click();
    await page.locator('.effect-sheet').waitFor();
    expect(await small(page, '.effect-sheet')).toEqual([]);
  });
});
