// The Timeline view and the 3D Stage view: a track's show read, scrubbed and
// rehearsed, and the rig drawn in 3D — live from the DMX feed, or rehearsing.

import { test, expect } from '@playwright/test';
import { open, reset, set, loadTrack, unloadTrack } from './helpers.js';
import { stageImage } from './stage-image.js';

test.beforeEach(async ({ request }) => {
  await request.post('/api/outputs/disarm');
  await reset(request);
  await loadTrack(request);
});

test.afterEach(async ({ request }) => {
  await set(request, { masterBlackout: false });
  await unloadTrack(request);
});

async function litShare(page) {
  return (await stageImage(page)).litShare;
}

test('the Stage view previews the rendered output, and goes dark with the blackout', async ({ page, request }) => {
  await set(request, { pattern: 'solid' });
  await open(page, 'stage');
  const stage = page.getByRole('img', { name: /The rig in 3D/ });
  await expect(stage).toHaveAttribute('aria-label', /4 fixtures, 4 lights, previewing with outputs disarmed/);
  await expect(page.locator('.stage3d-tools .panel-tag')).toHaveText('Preview (disarmed)');
  await expect.poll(() => litShare(page), { message: 'the pars light the haze' }).toBeGreaterThan(0.01);

  await set(request, { masterBlackout: true });
  await expect.poll(() => litShare(page), { message: 'nothing lit under the blackout' }).toBeLessThan(0.001);
});

test('the viewpoints, and the keys on the stage', async ({ page }) => {
  await open(page, 'stage');
  const stage = page.getByRole('img', { name: /The rig in 3D/ });
  await page.getByRole('button', { name: 'Above' }).click();
  await expect(page.getByRole('button', { name: 'Above' })).toHaveAttribute('aria-pressed', 'true');
  await expect(stage).toHaveAttribute('aria-label', /from above/);
  await page.getByRole('button', { name: 'Side' }).click();
  await expect(stage).toHaveAttribute('aria-label', /from the side/);
  await stage.focus();
  for (const key of ['ArrowLeft', 'ArrowUp', '+', '-']) await page.keyboard.press(key);
  await expect(stage).toBeFocused();
});

test('rehearsing on the Stage view: the planned show at any moment, whatever the rig is doing', async ({ page, request }) => {
  await set(request, { masterBlackout: true });
  await open(page, 'stage');
  await page.getByRole('button', { name: 'Rehearse track' }).click();
  await expect(page.locator('.stage3d-tools .panel-tag')).toHaveText('Rehearsal');
  await page.getByRole('slider', { name: 'Rehearsal position' }).fill('60000');
  await expect(page.locator('.stage3d-time')).toHaveText('1:00 / 4:07');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /rehearsing the track at 1:00/);
  await expect.poll(() => litShare(page), { message: 'the show is planned to be lit here' }).toBeGreaterThan(0.01);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.stage3d-time')).not.toHaveText('1:00 / 4:07');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Back to live' }).click();
  await expect(page.locator('.stage3d-tools .panel-tag')).toHaveText('Preview (disarmed)');
  await expect.poll(() => litShare(page), { message: 'live, the blackout holds' }).toBeLessThan(0.001);
});

test('without WebGL the Stage view says so', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(type) ? null : getContext.call(this, type, ...rest);
    };
  });
  await open(page, 'stage');
  await expect(page.getByRole('alert')).toContainText('needs WebGL');
});

test('the Timeline view scrubs: press, keys, sections, zoom, and on to the 3D stage', async ({ page }) => {
  await open(page, 'timeline');
  await expect(page.locator('.timeline-track')).toContainText('track.wav');
  const scrubber = page.getByRole('slider', { name: /Rehearsal position on the track/ });
  await expect(scrubber).toHaveAttribute('aria-valuemax', '248');

  const box = await scrubber.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('button', { name: 'Back to live' })).toBeVisible();
  await expect(scrubber).toHaveAttribute('aria-valuetext', '2:03');
  await expect(page.locator('.timeline-time')).toContainText('Rehearsal 2:03 / 4:07 · drop');
  await expect(page.locator('.timeline-mark')).toBeVisible();

  await scrubber.press('ArrowRight');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '2:04');
  await scrubber.press('Shift+ArrowLeft');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '1:54');
  await scrubber.press('Home');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '0:00');

  await page.getByRole('button', { name: 'verse', exact: true }).first().click();
  await expect(scrubber).toHaveAttribute('aria-valuetext', '1:16');
  await expect(page.locator('.timeline-section.current')).toHaveText('verse');

  // Zoomed in, the timeline scrolls, and keeps the rehearsal mark in view.
  await page.getByRole('button', { name: '4×' }).click();
  const scroll = await page.locator('.timeline-scroll').boundingBox();
  const wide = await page.locator('.timeline-canvas-wrap').boundingBox();
  expect(wide.width).toBeGreaterThan(scroll.width * 3.5);
  await page.getByRole('button', { name: 'outro', exact: true }).click();
  const mark = await page.locator('.timeline-mark').boundingBox();
  expect(mark.x).toBeGreaterThanOrEqual(scroll.x);
  expect(mark.x).toBeLessThanOrEqual(scroll.x + scroll.width);

  // The rehearsal is one position, wherever it is shown.
  const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Stage preview' }) });
  await expect(preview.locator('.panel-tag')).toHaveText('Rehearsal');
  await page.getByRole('link', { name: 'Watch in 3D' }).click();
  await expect(page.locator('#panel-stage')).toBeVisible();
  await expect(page.locator('.stage3d-time')).toHaveText('3:52 / 4:07');
});

test('an accent added on the Timeline view goes in at the rehearsal mark', async ({ page, request }) => {
  await open(page, 'timeline');
  await page.getByRole('button', { name: 'drop', exact: true }).first().click();
  await expect(page.getByRole('slider', { name: /Rehearsal position on the track/ })).toHaveAttribute('aria-valuetext', '0:13');
  await page.getByRole('button', { name: 'Add at rehearsal mark' }).click();
  await expect.poll(async () => {
    const overlay = (await (await request.get('/api/auto/overlay')).json()).overlay || {};
    return ((overlay.accents && overlay.accents.add) || []).map((a) => Math.round(a.atMs / 1000));
  }).toEqual([14]);
  await request.put('/api/auto/overlay', { data: {} });
});

test('with nothing analysed, the Timeline view says how to get a track', async ({ page, request }) => {
  await unloadTrack(request);
  await open(page, 'timeline');
  await expect(page.getByText('No track is analysed yet')).toBeVisible();
});

test('5 opens Auto Show with Timeline and 4 opens Stage', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('5');
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  await expect(page.locator('.timeline-view')).toBeVisible();
  await page.locator('body').press('4');
  await expect(page.locator('#panel-stage')).toBeVisible();
});


test('Stage and the fixture plot distinguish disarmed preview from armed output', async ({ page, request }) => {
  await request.post('/api/outputs/disarm');
  try {
    await open(page, 'stage');
    const label = page.locator('.stage3d-tools .panel-tag');
    const stage = page.getByRole('img', { name: /The rig in 3D/ });
    await expect(label).toHaveText('Preview (disarmed)');
    await expect(stage).toHaveAttribute('aria-label', /nothing is transmitted/);
    await expect(page.locator('.look-note')).toContainText('nothing is transmitted to the rig');
    await request.post('/api/outputs/arm');
    await expect(label).toHaveText('Live output');
    await expect(stage).toHaveAttribute('aria-label', /showing the live output/);
    await expect(page.locator('.look-note')).toContainText('what is going out to the rig now');
    await open(page, 'effects');
    const plot = page.locator('.stage-panel .panel-tag');
    await expect(plot).toHaveText('Live output');
    await request.post('/api/outputs/disarm');
    await expect(plot).toHaveText('Preview (disarmed)');
  } finally {
    await request.post('/api/outputs/disarm');
  }
});
