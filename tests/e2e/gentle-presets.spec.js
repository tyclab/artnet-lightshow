import { test, expect } from '@playwright/test';
import { open, reset, state, until } from './helpers.js';

for (const [id, name] of [['party.fire', 'Fire'], ['party.ice', 'Ice']]) {
  test(`${name} opens as an editable built-in effect`, async ({ page }) => {
    await open(page, 'effects');
    await page.getByLabel('Search effects').fill(name);
    await page.locator(`.effect-pad[data-id="${id}"]`).getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Edit effect' });
    await expect(sheet.getByRole('button', { name: 'Save as…', exact: true })).toBeEnabled();
    await expect(sheet.getByLabel('Attack', { exact: true })).toBeEditable();
  });

  test(`${name} can be assigned and played from a normal pad`, async ({ page, request }) => {
    const before = (await state(request)).pads.layout.find((pad) => pad.bank === 0 && pad.slot === 0);
    await reset(request);
    try {
      await open(page, 'perform');
      await page.getByRole('tab', { name: 'A', exact: true }).click();
      await page.getByRole('button', { name: 'Edit pads', exact: true }).click();
      const pad = page.locator('.pad-cell[data-bank="0"][data-slot="0"]');
      await pad.click();
      const editor = page.getByRole('dialog', { name: 'Edit pad A1', exact: true });
      await editor.getByRole('combobox', { name: 'Plays', exact: true }).selectOption(`preset:${id}`);
      await editor.getByLabel('Label', { exact: true }).fill(name);
      await editor.getByRole('radio', { name: /Loop/ }).check();
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await page.getByRole('button', { name: 'Edit pads', exact: true }).click();
      await pad.click();
      await until(request, (current) => current.voices.some((voice) => voice.source === 'pad' && voice.label === name));
      await pad.click();
      await until(request, (current) => !current.voices.some((voice) => voice.source === 'pad' && voice.label === name));
    } finally {
      await request.post('/api/pads/0/0/release', { data: {} });
      const { bank: _bank, slot: _slot, ...original } = before;
      await request.put('/api/pads/0/0', { data: original });
      await reset(request);
    }
  });
}
