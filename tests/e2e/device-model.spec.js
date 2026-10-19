import { test, expect } from '@playwright/test';
import { open } from './helpers.js';

const lamp = { id: 'strip', name: 'Gradient strip', product: 'Hue gradient lightstrip', channels: [3, 4, 5], devices: [], kind: 'color',
  capabilities: { gamut: 'C', whites: { warm: 2000, cool: 6536 }, fixedWhite: null } };
const profile = { id: 'hue-b1-strip', name: lamp.product, modeName: '3 sections, colour (gamut C)', channelCount: 12,
  channelMap: {}, hue: { gamut: 'C', whites: null },
  cells: [0, 1, 2].map((i) => ({ name: `Section ${i + 1}`, channelMap: { dimmer: 4 * i, red: 4 * i + 1, green: 4 * i + 2, blue: 4 * i + 3 } })) };
const pixel = { id: 'e2e-device-rgb', name: 'Device RGB', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };

async function withDevices(request, fn) {
  const before = await (await request.get('/api/show')).json();
  const fixtures = [
    { id: 10000, label: 'Gradient strip', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: [3, 4, 5] } },
    { id: 10001, label: 'WLED strip', profileId: pixel.id, output: { protocol: 'ddp', host: '127.0.0.1' } },
    { id: 10002, label: 'Keyboard', profileId: pixel.id, output: { protocol: 'openrgb', host: '127.0.0.1', device: 0, leds: 1 } },
  ];
  const result = await request.post('/api/show', { data: { ...before, profiles: [...before.profiles, profile, pixel], fixtures: [...before.fixtures, ...fixtures] } });
  expect(result.ok()).toBeTruthy();
  try { await fn(); } finally {
    expect((await request.post('/api/show', { data: before })).ok()).toBeTruthy();
  }
}

test('Hue sections stay one fixture and network devices have no DMX address controls', async ({ page, request }) => {
  await withDevices(request, async () => {
    await open(page, 'rig');
    for (const label of ['Gradient strip', 'WLED strip', 'Keyboard']) {
      const row = page.locator('.patch-table tbody tr').filter({ has: page.getByRole('button', { name: `Identify ${label}`, exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('spinbutton')).toHaveCount(0);
      await expect(row.getByRole('combobox')).toHaveCount(0);
    }
    await expect(page.locator('.patch-hue').filter({ hasText: 'channels #3–#5' })).toBeVisible();
    await page.locator('.plan-surface [data-fixture="10000"]').click();
    await expect(page.locator('.inspector')).toContainText('3 cells');
    await expect(page.locator('#insp-universe')).toHaveCount(0);
    await expect(page.locator('#insp-address')).toHaveCount(0);
  });
});

test('Hue discovery lists one gradient lamp and refreshes existing profiles', async ({ page, request }) => {
  await withDevices(request, async () => {
    const area = { id: 'area', name: 'Room', channels: lamp.channels.map((id) => ({ id })), lamps: [lamp] };
    const fulfil = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...body }) });
    await page.route('**/api/hue/status', (route) => fulfil(route, { bridges: [{ id: 'b1', label: 'Room bridge', host: 'bridge.local', paired: true, enabled: true, area: 'area', stream: 'idle' }] }));
    await page.route('**/api/hue/b1/areas', (route) => fulfil(route, { areas: [area] }));
    await page.route('**/api/hue/b1/lamps', (route) => fulfil(route, { area, lamps: [{ ...lamp, shows: profile.modeName }] }));
    await page.route('**/api/hue/b1/refresh', (route) => fulfil(route, { refreshed: [10000], skipped: [] }));
    await open(page, 'rig/outputs');
    const bridge = page.locator('.hue-bridge[data-bridge="b1"]');
    await expect(bridge.getByText('In the patch as "Gradient strip"')).toBeVisible();
    await expect(bridge.getByText('#3 #4 #5', { exact: true })).toBeVisible();
    await expect(bridge.getByRole('button', { name: 'Add Gradient strip', exact: false })).toHaveCount(0);
    await bridge.getByRole('button', { name: 'Refresh lamp profiles' }).click();
    await expect(page.getByText('Refreshed 1 fixtures.')).toBeVisible();
  });
});
