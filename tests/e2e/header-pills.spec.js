import { test, expect } from '@playwright/test';
import { open, reset, set } from './helpers.js';

// Every status pill in the top bar stays visible, with its label, at every width and in every state:
// a pill that comes and goes moves the controls beside it and hides what the room is doing.
const PILLS = ['Outputs', 'Look', 'BPM', 'Master', 'Blackout', 'Energy', 'Strobes', 'Flash', 'Auto', 'Online'];
const LABELLED = PILLS.filter((p) => p !== 'Strobes' && p !== 'Online');
const sequence = { id: 'e2e-pills', name: 'Pills', mode: 'arrangement',
  lanes: [{ id: 'base', kind: 'shared', name: 'Base', mute: false, solo: false }],
  clips: [{ id: 'one', laneId: 'base', startBeat: 0, lengthBeats: 16, loopBeats: 4, presetId: 'hd.neonDomino', targets: 'lane', mute: false }],
  commands: [] };

test.beforeEach(async ({ request }) => {
  await request.post('/api/auto/stop');
  await request.delete('/api/sequence');
  await request.post('/api/outputs/disarm');
  await reset(request);
});
test.afterEach(async ({ request }) => {
  await request.delete('/api/sequence');
  await reset(request);
});

async function expectEveryPill(page, where) {
  const stats = page.locator('.app-header .header-stats');
  for (const name of PILLS) {
    const pill = stats.locator('.stat-pill', { hasText: name }).first();
    await expect(pill, `${where}: ${name}`).toBeVisible();
    await expect(pill, `${where}: ${name} on screen`).toBeInViewport();
  }
  for (const name of LABELLED) {
    await expect(stats.locator('.stat-pill .label', { hasText: new RegExp(`^${name}$`) }).first(), `${where}: ${name} label`).toBeVisible();
  }
}

for (const width of [390, 800, 1280, 1920]) {
  test(`every header pill stays visible at ${width}px, also under a blackout and a loaded sequence`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, 'show');
    await expectEveryPill(page, `${width}px`);
    await set(request, { masterBlackout: true });
    expect((await request.put('/api/sequence', { data: sequence })).ok()).toBe(true);
    await expect(page.locator('.app-header').getByRole('button', { name: 'Master blackout' })).toHaveAttribute('aria-pressed', 'true');
    await expectEveryPill(page, `${width}px, blackout and a sequence`);
    // Still the controls PR82 made of them.
    await expect(page.locator('.app-header').getByRole('button', { name: 'Look playback' })).toBeEnabled();
  });
}
