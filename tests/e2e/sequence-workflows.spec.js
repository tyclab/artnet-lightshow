import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

const ID = 'e2e-workflow';
const PATTERN = 'e2e-mapped';
const clip = (id, startBeat = 0) => ({ id, laneId: 'base', startBeat, lengthBeats: 16, loopBeats: 4,
  presetId: 'hd.neonDomino', targets: 'lane', mute: false });
const sequence = () => ({ id: ID, name: 'Workflow', mode: 'arrangement',
  lanes: [{ id: 'base', kind: 'shared', name: 'Base', mute: false, solo: false }],
  clips: [clip('first'), clip('second', 16), clip('third', 32)], commands: [] });
const current = async (request) => (await (await request.get('/api/sequence')).json()).sequence;
const position = async (request) => (await (await request.get('/api/sequence/status')).json()).status.beat;

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.delete('/api/sequence');
  expect((await request.put('/api/sequence', { data: sequence() })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.delete('/api/sequence');
  await request.delete(`/api/sequences/${ID}`);
  await request.delete(`/api/sequence/patterns/${PATTERN}`);
});

test('show settings survive Save and a fresh load', async ({ page, request }) => {
  await open(page, 'sequence');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('switch', { name: 'Playlist mode' }).click();
  await page.getByText('Show settings', { exact: true }).click();
  await page.getByLabel('Start tempo, BPM').fill('148');
  await page.getByLabel('Start tempo, BPM').press('Enter');
  await page.getByLabel('Music mode on start').selectOption('reactive');
  await page.getByLabel('Beats per bar', { exact: true }).fill('3');
  await page.getByLabel('Beats per bar', { exact: true }).press('Enter');
  await page.getByLabel('Beat note value').selectOption('8');
  await page.getByLabel('Snap grid').selectOption('0.5');
  await page.getByLabel('Advance to the next row automatically').uncheck();
  await page.getByLabel('Choose the next row at random').check();
  await page.getByLabel('Choose another palette on each loop').check();
  const library = await (await request.get('/api/effects')).json();
  const palette = library.palettes.builtin[0];
  await page.getByLabel('Initial palette').selectOption(palette.id);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.seq-unsaved')).toHaveCount(0);
  await page.getByRole('button', { name: 'Unload', exact: true }).click();
  await page.getByRole('button', { name: 'Load Workflow', exact: true }).click();
  await expect(page.getByLabel('Start tempo, BPM')).toHaveValue('148');
  const saved = await current(request);
  expect(saved).toMatchObject({ bpm: 148, musicMode: 'reactive', timeSignature: { beats: 3, unit: 8 }, snap: 0.5,
    options: { autoplay: false, shuffle: true, randomPaletteOnLoop: true, initialPalette: palette.id } });
});

test('seek and previous move the playhead without starting playback', async ({ page, request }) => {
  await open(page, 'sequence');
  await page.getByText('Move playhead', { exact: true }).click();
  await page.getByLabel('Seek to beat (from 0)').fill('33.5');
  await page.getByRole('button', { name: 'Seek', exact: true }).click();
  await expect.poll(() => position(request)).toBe(33.5);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect.poll(() => position(request)).toBe(16);
  expect((await state(request)).sequence.playing).toBe(false);
});

test('jump and resync use the selected clip and musical boundaries', async ({ page, request }) => {
  await open(page, 'sequence');
  await page.getByText('Move playhead', { exact: true }).click();
  await page.getByLabel('Jump to clip').selectOption('second');
  await expect.poll(() => position(request)).toBe(16);
  await page.getByLabel('Seek to beat (from 0)').fill('18.6');
  await page.getByRole('button', { name: 'Seek', exact: true }).click();
  await page.getByRole('button', { name: 'Resync to beat', exact: true }).click();
  await expect.poll(() => position(request)).toBe(19);
  await page.getByRole('button', { name: 'Resync to bar', exact: true }).click();
  await expect.poll(() => position(request)).toBe(16);
});

test('six-eight transport and loop inputs count eighth-note beats', async ({ page, request }) => {
  expect((await request.put('/api/sequence', { data: { ...sequence(), timeSignature: { beats: 6, unit: 8 },
    loop: { on: true, startBeat: 1.5, endBeat: 4.5 } } })).ok()).toBe(true);
  expect((await request.post('/api/sequence/seek/4.5')).ok()).toBe(true);
  await open(page, 'sequence');
  await expect(page.getByLabel('Position, bars and beats')).toHaveText('2.4');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Loop start, bars.beats')).toHaveValue('1.4');
  await expect(page.getByLabel('Loop end, bars.beats')).toHaveValue('2.4');
  await page.getByLabel('Loop start, bars.beats').fill('2.4');
  await page.getByLabel('Loop end, bars.beats').fill('3.4');
  await page.getByRole('button', { name: 'Set loop', exact: true }).click();
  await expect.poll(async () => (await current(request)).loop).toEqual({ on: true, startBeat: 4.5, endBeat: 7.5 });
});

test('playlist rows start, jump and stop through pointer or keyboard', async ({ page, request }) => {
  expect((await request.put('/api/sequence', { data: { ...sequence(), mode: 'playlist' } })).ok()).toBe(true);
  await open(page, 'sequence');
  await page.locator('.seq-block').nth(1).click();
  await until(request, (s) => s.sequence.playing && s.sequence.lanes[0].clip === 'second');
  await page.locator('.seq-block').nth(2).focus();
  await page.keyboard.press('Enter');
  await until(request, (s) => s.sequence.playing && s.sequence.lanes[0].clip === 'third');
  await page.locator('.seq-block').nth(2).click();
  await until(request, (s) => s.sequence.stopped === 'hold');
});

test('pattern rename and mapping change the fixture used by later inserts', async ({ page, request }) => {
  const fixtures = (await state(request)).fixtures;
  const { id: _id, laneId: _lane, ...content } = clip('pattern');
  expect((await request.post('/api/sequence/patterns', { data: { id: PATTERN, name: 'Mapped pattern', lengthBeats: 16,
    lanes: [{ kind: 'track', slot: 0, clips: [content] }] } })).ok()).toBe(true);
  await open(page, 'sequence');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Edit pattern Mapped pattern' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit pattern', exact: true });
  await editor.getByLabel('Pattern name', { exact: true }).fill('Renamed pattern');
  await editor.getByLabel('Track lane 1 target').selectOption('1');
  await editor.getByRole('button', { name: 'Save pattern' }).click();
  await page.getByRole('button', { name: 'Insert Renamed pattern at beat 0' }).click();
  await expect.poll(async () => (await current(request)).lanes.find((lane) => lane.kind === 'track')?.fixtureId).toBe(fixtures[1].id);
  await page.getByRole('button', { name: 'Edit pattern Renamed pattern' }).click();
  await editor.getByRole('button', { name: 'Delete pattern' }).click();
  await editor.getByRole('button', { name: 'Delete it', exact: true }).click();
  await expect(page.getByRole('button', { name: /Insert Renamed pattern/ })).toHaveCount(0);
  expect((await current(request)).clips).toHaveLength(4);
});

async function openClipEditor(page) {
  await open(page, 'sequence');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.seq-block').first().click();
  await page.getByRole('button', { name: 'Edit clip effect', exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit clip effect', exact: true });
}

test('clip audition and Apply preserve the preset and fixture target', async ({ page, request }) => {
  const fixtures = (await state(request)).fixtures;
  const target = fixtures[1].id;
  const draft = { ...sequence(), lanes: [{ id: 'base', kind: 'track', fixtureId: target, name: 'Track', mute: false, solo: false }] };
  expect((await request.put('/api/sequence', { data: draft })).ok()).toBe(true);
  const before = await (await request.get('/api/effects')).json();
  const editor = await openClipEditor(page);
  await editor.getByLabel('Stagger', { exact: true }).fill('0.75');
  await editor.getByRole('button', { name: 'Hold to audition' }).focus();
  await page.keyboard.down('Enter');
  try {
    const live = await until(request, (s) => s.voices.some((v) => v.spec.params.stagger === 0.75));
    expect(live.voices.find((v) => v.spec.params.stagger === 0.75).targets).toEqual([target]);
    expect((await current(request)).clips[0].presetId).toBe('hd.neonDomino');
  } finally { await page.keyboard.up('Enter'); }
  await editor.getByRole('button', { name: 'Apply to clip' }).click();
  await expect(editor).toHaveCount(0);
  const changed = (await current(request)).clips[0];
  expect(changed.effect.params.stagger).toBe(0.75);
  expect(changed.presetId).toBeUndefined();
  expect(changed.targets).toBe('lane');
  expect(await (await request.get('/api/effects')).json()).toEqual(before);
});

test('a refused clip Apply keeps the edited draft for a successful retry', async ({ page, request }) => {
  const editor = await openClipEditor(page);
  await editor.getByLabel('Stagger', { exact: true }).fill('0.75');
  await page.route('**/api/sequence', (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Rejected test edit' }) })
    : route.continue());
  await editor.getByRole('button', { name: 'Apply to clip' }).click();
  await expect(editor.getByRole('alert')).toBeVisible();
  await expect(editor.getByLabel('Stagger', { exact: true })).toHaveValue('0.75');
  expect((await current(request)).clips[0].presetId).toBe('hd.neonDomino');
  await page.unroute('**/api/sequence');
  await editor.getByRole('button', { name: 'Apply to clip' }).click();
  await expect(editor).toHaveCount(0);
  expect((await current(request)).clips[0].effect.params.stagger).toBe(0.75);
});
