import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { open, state } from './helpers.js';

const room = {
  version: 1, name: 'Test room', bounds: { width: 6, depth: 4, height: 2.5 },
  rooms: [{ id: 'floor', label: 'Floor', polygon: [[-3, -2], [3, -2], [3, 2], [-3, 2]] }],
  objects: [{ id: 'wall', kind: 'box', role: 'wall', position: { x: -2.9, y: 1.25, z: 0 }, size: { x: 0.2, y: 2.5, z: 4 } }],
  bindings: [],
};
const current = async (request) => (await request.get('/api/stage/room')).json();
async function replace(request, next) {
  const before = await current(request);
  const result = next ? await request.put('/api/stage/room', { headers: { 'If-Match': before.revision }, data: next })
    : await request.delete('/api/stage/room', { headers: { 'If-Match': before.revision } });
  expect(result.ok()).toBe(true);
}
async function showPanel(page) {
  await open(page, 'stage');
  await page.locator('.stage-room-panel > summary').click();
}
async function seeded(request) {
  const fixture = (await state(request)).fixtures[0];
  await replace(request, { ...room, bindings: [{ id: 'lamp', fixtureId: fixture.id, position: { x: 0, y: 1.2, z: 0 }, confidence: 'estimated' }] });
  return fixture;
}
test.beforeEach(async ({ request }) => { await replace(request, null); });
test.afterEach(async ({ request }) => { await replace(request, null); });

test('room import preserves the engine patch and output arm state', async ({ page, request }) => {
  const before = await state(request);
  await showPanel(page);
  await page.getByLabel('Choose room JSON').setInputFiles({ name: 'room.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(room)) });
  await page.getByRole('button', { name: 'Use Test room', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cutaway walls', exact: true })).toBeVisible();
  await expect.poll(async () => (await current(request)).room?.objects.length).toBe(1);
  const after = await state(request);
  expect(after.fixtures).toEqual(before.fixtures);
  expect(after.armed).toBe(before.armed);
});

test('an unplaced fixture gains a preview position through the editor', async ({ page, request }) => {
  await replace(request, room);
  const fixture = (await state(request)).fixtures[0];
  await showPanel(page);
  await page.getByRole('button', { name: 'Place', exact: true }).first().click();
  await page.getByLabel('Floor X (m)', { exact: true }).fill('1.25');
  await page.getByLabel('Height Y (m)', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Save position', exact: true }).click();
  await expect.poll(async () => (await current(request)).room.bindings[0]?.position).toEqual({ x: 1.25, y: 1.5, z: 0 });
  expect((await current(request)).room.bindings[0].fixtureId).toBe(fixture.id);
});

test('existing room positions can be edited without changing patch positions', async ({ page, request }) => {
  const fixture = await seeded(request);
  await showPanel(page);
  await page.locator('.stage-room-bindings > summary').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Floor Z (m)', { exact: true }).fill('-1.5');
  await page.getByRole('button', { name: 'Save position', exact: true }).click();
  await expect.poll(async () => (await current(request)).room.bindings[0].position.z).toBe(-1.5);
  expect((await state(request)).fixtures.find((entry) => entry.id === fixture.id).position).toEqual(fixture.position);
});

test('removing a room position returns the fixture to the placement list', async ({ page, request }) => {
  await seeded(request);
  await showPanel(page);
  await page.locator('.stage-room-bindings > summary').click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(async () => (await current(request)).room.bindings.length).toBe(0);
  await expect(page.getByRole('button', { name: 'Place', exact: true })).toHaveCount((await state(request)).fixtures.length);
});

test('editing an imported position preserves sub-centimetre coordinates', async ({ page, request }) => {
  const fixture = (await state(request)).fixtures[0];
  const position = { x: -1.23456789, y: 0.0123, z: 0.34567 };
  await replace(request, { ...room, bindings: [{ id: 'lamp', fixtureId: fixture.id, position, confidence: 'estimated' }] });
  await showPanel(page);
  await page.locator('.stage-room-bindings > summary').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Save position', exact: true }).click();
  await expect(page.locator('.stage-room-editor')).toHaveCount(0);
  expect((await current(request)).room.bindings[0].position).toEqual(position);
});

test('reloading a changed room discards its stale placement draft', async ({ page, request }) => {
  await seeded(request);
  await showPanel(page);
  await page.locator('.stage-room-bindings > summary').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await replace(request, room);
  await page.getByRole('button', { name: 'Reload room', exact: true }).click();
  await expect(page.locator('.stage-room-editor')).toHaveCount(0);
});

test('clearing a room asks before discarding an unsaved position', async ({ page, request }) => {
  await seeded(request);
  await showPanel(page);
  await page.locator('.stage-room-bindings > summary').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Floor X (m)', { exact: true }).fill('1.5');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Use generic venue', exact: true }).click();
  await expect(page.getByLabel('Floor X (m)', { exact: true })).toHaveValue('1.5');
  expect((await current(request)).room.bindings).toHaveLength(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Use generic venue', exact: true }).click();
  await expect.poll(async () => (await current(request)).room).toBeNull();
  await expect(page.locator('.stage-room-editor')).toHaveCount(0);
});

test('room download preserves geometry and saved light positions', async ({ page, request }) => {
  await seeded(request);
  await showPanel(page);
  const saved = (await current(request)).room;
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download room JSON', exact: true }).click();
  const download = await downloading;
  expect(JSON.parse(await fs.readFile(await download.path(), 'utf8'))).toEqual(saved);
});

test('placement fields cannot change during an in-flight save', async ({ page, request }) => {
  await replace(request, room);
  await showPanel(page);
  await page.getByRole('button', { name: 'Place', exact: true }).first().click();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/stage/room', async (route) => {
    if (route.request().method() === 'PUT') await gate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Save position', exact: true }).click();
    await expect(page.getByLabel('Floor X (m)', { exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('.stage-room-editor')).toHaveCount(0);
});

test('a stale import cannot overwrite another room edit', async ({ page, request }) => {
  await replace(request, room);
  await showPanel(page);
  await expect(page.getByRole('button', { name: 'Use generic venue', exact: true })).toBeVisible();
  await replace(request, { ...room, name: 'Newer room' });
  await page.getByLabel('Choose room JSON').setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(room)) });
  const refused = page.waitForResponse((response) => response.url().endsWith('/api/stage/room') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Use Test room', exact: true }).click();
  expect((await refused).status()).toBe(412);
  expect((await current(request)).room.name).toBe('Newer room');
});
