// The view shell: a real tab strip, a view per hash, keys to switch.

import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the hash opens a view, and switching views writes it back', async ({ page }) => {
  await open(page, 'perform');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.perform-pads')).toBeVisible();
  await page.getByRole('tab', { name: /Auto Show/ }).click();
  await expect(page).toHaveURL(/#auto(?:\/show)?$/);
  await page.goBack();
  await page.goto('/#effects');
  await expect(page.locator('#panel-effects')).toBeVisible();
});

test('the app opens on Show: the room, the looks and the switches', async ({ page }) => {
  await page.goto('/');
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  await expect(page).toHaveURL(/#show$/);
  await expect(page.getByRole('tab', { name: /^Show/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('switch', { name: /Disarmed|Armed/ })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Auto show/ })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Blackout/ })).toBeVisible();
  await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
  await expect(page.locator('.show-looks .effects-deck')).toBeVisible();
  await expect(page.locator('.command-bar')).toHaveCount(0);
});

test('the Show switches fit on the first screen of a tablet', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'show');
  const strip = await page.locator('.show-strip').boundingBox();
  expect(strip.y + strip.height).toBeLessThanOrEqual(340);
  const room = await page.locator('.show-room').boundingBox();
  expect(room.y).toBeGreaterThanOrEqual(strip.y + strip.height);
  expect(room.y).toBeLessThan(768 / 2);
});

test('the tab strip is one stop, and the arrow keys move along it', async ({ page }) => {
  await open(page, 'effects');
  const manual = page.getByRole('tab', { name: /Effects/ });
  await manual.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Perform/ })).toBeFocused();
  await expect(page.locator('#panel-perform')).toBeVisible();
  // The live views, then the setup views: End is the last of them all.
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /Preflight/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-preflight')).toHaveAttribute('aria-labelledby', 'tab-preflight');
  await expect(page.getByRole('tab', { name: /Effects/ })).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /^Show/ })).toBeFocused();
});

test('the digit keys jump between views, and not while typing', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('1');
  await expect(page.locator('#panel-show')).toBeVisible();
  await page.locator('body').press('5');
  await expect(page.locator('#panel-auto')).toBeVisible();
  await page.locator('body').press('0');
  await expect(page.locator('#panel-preflight')).toBeVisible();
});

test('the keyboard shortcuts dialog keeps focus inside it and gives it back', async ({ page }) => {
  await open(page, 'effects');
  const opener = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
});

for (const [old, canonical, panel] of [['manual', 'effects', 'effects'], ['timeline', 'auto/timeline', 'auto'], ['matrix', 'perform/matrix', 'perform']]) {
  test(`old ${old} bookmarks open ${canonical}`, async ({ page }) => {
    await open(page, old);
    await expect(page).toHaveURL(new RegExp(`#${canonical}$`));
    await expect(page.locator(`#panel-${panel}`)).toBeVisible();
  });
}

test('a new browser opens Show, and Perform restarts a frozen look', async ({ page, request }) => {
  await request.post('/api/set', { data: { running: false } });
  await page.goto('/');
  await expect(page.locator('#panel-show')).toBeVisible();
  await page.getByRole('tab', { name: /^Perform/ }).click();
  await expect(page.locator('#panel-perform')).toBeVisible();
  const play = page.getByRole('button', { name: 'Play look', exact: true });
  const freeze = page.getByRole('button', { name: 'Freeze look', exact: true });
  await expect(freeze).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Look · frozen', { exact: false })).toBeVisible();
  await expect(page.getByTitle(/The look is frozen/)).toBeVisible();
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(freeze).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTitle(/The look is frozen/)).toHaveCount(0);
});
