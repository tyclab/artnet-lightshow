import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('MIDI show-control layout is explicit and Undo restores custom bindings', async ({ page, request }) => {
  const read = async () => (await (await request.get('/api/midi/map')).json()).map;
  const original = await read();
  const custom = { cc: { 70: { action: 'adjustMasterDimmer', type: 'absolute' } }, notes: { 80: { action: 'tap' } } };
  await request.put('/api/midi/map', { data: custom });
  try {
    await open(page, 'settings');
    const panel = page.getByRole('region', { name: 'MIDI mapping' });
    await expect(panel).toContainText('CC 70 (encoder)');
    await panel.getByRole('combobox', { name: 'MIDI layout' }).selectOption('performance');
    expect(await read()).toEqual(custom);
    const invalid = await request.post('/api/midi/map/preset/unknown');
    expect(invalid.status()).toBe(404);
    expect(await read()).toEqual(custom);
    await panel.getByRole('button', { name: 'Apply layout' }).click();
    await expect.poll(async () => (await read()).cc[1]?.action).toBe('setFixtureMax');
    expect((await read()).notes[16].action).toBe('togglePaletteOverride');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(read).toEqual(custom);
  } finally {
    await request.put('/api/midi/map', { data: original });
  }
});
