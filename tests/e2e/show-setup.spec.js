import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

const sequenceId = 'e2e-show-setup';
let globalPads, globalAudio;
const ids = new Set();
const current = async (request) => (await (await request.get('/api/sequence')).json()).sequence;
const setup = async (request) => (await (await request.get('/api/show-setup')).json());
const show = (performance, extra = {}) => ({ id: sequenceId, name: 'Setup show', mode: 'arrangement', performance, ...extra });

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.delete('/api/voices');
  await request.delete('/api/sequence');
  globalPads = (await (await request.get('/api/pads')).json()).layout;
  globalAudio = await (await request.get('/api/audio')).json();
  const performance = (await setup(request)).performance;
  performance.pads[0].targets = [];
  expect((await request.put('/api/sequence', { data: show(performance) })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.delete('/api/sequence');
  for (const id of ids) await request.delete(`/api/pad-layouts/${id}`, { data: { expected: (await setup(request)).expected } });
  ids.clear();
  await request.delete(`/api/sequences/${sequenceId}`);
  await request.put('/api/pads', { data: { pads: globalPads } });
  await request.put('/api/audio', { data: { mode: globalAudio.mode, master: globalAudio.master, ldjTrigger: globalAudio.ldjTrigger } });
});

async function manager(page) {
  await open(page, 'perform');
  await page.getByRole('button', { name: 'Pad layouts', exact: true }).click();
  return page.getByRole('dialog', { name: 'Pad layouts', exact: true });
}
async function saveLayout(page, request) {
  const dialog = await manager(page);
  await dialog.getByLabel('Pad layout name').fill('Reusable setup');
  await dialog.getByRole('button', { name: 'Save current pads', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Current pads saved as a reusable layout.');
  const id = (await (await request.get('/api/pad-layouts')).json()).layouts.find((layout) => layout.name === 'Reusable setup').id;
  ids.add(id);
  return { dialog, id };
}

test('Show audio and pad edits survive Save without changing globals', async ({ page, request }) => {
  await open(page, 'perform');
  await page.locator('.audio-master summary').click();
  const audio = page.locator('.audio-master');
  await expect(audio).toContainText('Settings for show “Setup show”');
  await audio.getByLabel('Party brightness (%)').fill('23');
  await audio.getByRole('button', { name: 'Apply audio response' }).click();
  await expect(audio.getByRole('status')).toHaveText('Audio response saved.');
  await page.getByRole('button', { name: 'Edit pads', exact: true }).click();
  await page.locator('.pad-cell[data-bank="0"][data-slot="0"]').click();
  const editor = page.getByRole('dialog', { name: 'Edit pad A1' });
  await editor.getByLabel('Label', { exact: true }).fill('Show A pad');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await until(request, (s) => s.pads.layout[0].label === 'Show A pad');
  await open(page, 'sequence');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await request.get(`/api/sequences/${sequenceId}`)).status()).toBe(200);
  await request.delete('/api/sequence');
  expect((await (await request.get('/api/audio')).json()).master).toEqual(globalAudio.master);
  expect((await (await request.get('/api/pads')).json()).layout).toEqual(globalPads);
  expect((await request.put('/api/sequence', { data: { id: sequenceId } })).ok()).toBe(true);
  const restored = await current(request);
  expect(restored.performance.master.brightness).toBe(0.23);
  expect(restored.performance.pads[0].label).toBe('Show A pad');
  expect(restored.performance.pads[0].targets).toEqual([]);
  expect((await state(request)).armed).toBe(false);
  expect((await state(request)).voices).toEqual([]);
});

test('Reusable pad layouts preview and apply explicit fixture remapping', async ({ page, request }) => {
  const fixtures = (await state(request)).fixtures.slice(0, 2);
  expect(fixtures).toHaveLength(2);
  let seq = await current(request);
  seq.lanes = fixtures.map((fixture, i) => ({ id: `track${i}`, kind: 'track', fixtureId: fixture.id, name: fixture.label }));
  seq.performance.pads[0].targets = [fixtures[0].id];
  await request.put('/api/sequence', { data: seq });
  const { dialog, id } = await saveLayout(page, request);
  await dialog.getByRole('button', { name: 'Close layouts' }).click();
  seq = await current(request);
  seq.lanes.reverse();
  seq.performance.pads[0].targets = 'shared';
  await request.put('/api/sequence', { data: seq });
  await page.getByRole('button', { name: 'Pad layouts', exact: true }).click();
  await dialog.getByLabel('Saved pad layout').selectOption(id);
  await expect(dialog.getByLabel('Layout fixture slot 1')).toHaveValue(String(fixtures[1].id));
  await dialog.getByLabel('Layout fixture slot 1').selectOption(String(fixtures[0].id));
  await expect(dialog.getByLabel('Layout fixture slot 1')).toHaveValue(String(fixtures[0].id));
  await dialog.getByRole('button', { name: 'Apply pad layout' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Pad layout applied.');
  expect((await current(request)).performance.pads[0].targets).toEqual([fixtures[0].id]);
});

test('Renaming and deleting a layout retains current pad assignments', async ({ page, request }) => {
  const { dialog, id } = await saveLayout(page, request);
  const pads = (await current(request)).performance.pads;
  await dialog.getByLabel('Pad layout name').fill('Renamed setup');
  await dialog.getByRole('button', { name: 'Rename layout', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Layout renamed.');
  expect((await (await request.get(`/api/pad-layouts/${id}`)).json()).layout.name).toBe('Renamed setup');
  await dialog.getByRole('button', { name: 'Delete layout', exact: true }).click();
  expect((await request.get(`/api/pad-layouts/${id}`)).status()).toBe(200);
  await dialog.getByRole('button', { name: 'Confirm delete layout', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Layout deleted; current pad assignments are retained.');
  expect((await request.get(`/api/pad-layouts/${id}`)).status()).toBe(404);
  expect((await current(request)).performance.pads).toEqual(pads);
  expect((await current(request)).performance.activePadLayoutId).toBeNull();
  ids.delete(id);
});

test('Cancelling Escape keeps an unsaved layout name', async ({ page }) => {
  const dialog = await manager(page);
  await dialog.getByLabel('Pad layout name').fill('Unfinished name');
  page.once('dialog', (prompt) => prompt.dismiss());
  await dialog.getByLabel('Pad layout name').press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Pad layout name')).toHaveValue('Unfinished name');
});

test('Sequence Edit captures the current setup and returns the show to the global one', async ({ page, request }) => {
  await open(page, 'sequence');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.show-setup summary').click();
  await page.getByRole('button', { name: 'Use global setup', exact: true }).click();
  await expect.poll(async () => (await current(request)).performance).toBeUndefined();
  await expect(page.locator('.show-setup')).toContainText('uses the global Party audio response');
  await page.getByRole('button', { name: 'Capture current setup', exact: true }).click();
  await expect.poll(async () => (await current(request)).performance?.pads.length).toBe(16);
  await expect(page.locator('.show-setup')).toContainText('This show owns its Party audio response');
});
