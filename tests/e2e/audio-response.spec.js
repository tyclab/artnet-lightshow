import { test, expect } from '@playwright/test';
import { open, set, state, until } from './helpers.js';

test('audio response applies changed fields, preserves concurrent settings, and reports rejected saves', async ({ page, request }) => {
  const before = await (await request.get('/api/audio')).json();
  try {
    await open(page, 'perform');
    await page.locator('.audio-master summary').click();
    const editor = page.locator('.audio-master');
    const sensitivity = editor.getByLabel('Input sensitivity (%)');
    await sensitivity.fill('73');
    const attack = editor.getByLabel('Attack (ms)');
    await attack.fill('180');
    await request.put('/api/audio', { data: { master: { releaseMs: 777 } } });
    await expect(editor.getByLabel('Release (ms)')).toHaveValue('777');
    await expect(sensitivity).toHaveValue('73');
    await editor.getByRole('button', { name: 'Apply audio response' }).click();
    await expect(editor.getByRole('status')).toHaveText('Audio response saved.');
    let audio = await (await request.get('/api/audio')).json();
    expect(audio.master).toEqual({ ...before.master, sensitivity: 0.73, attackMs: 180, releaseMs: 777 });
    await editor.getByLabel('Light DJ trigger (%)').fill('42');
    await page.route('**/api/audio', async (route) => route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Save refused for test' }) })
      : route.continue());
    await editor.getByRole('button', { name: 'Apply audio response' }).click();
    await expect(editor.getByRole('status')).toHaveText('Save refused for test');
    await expect(editor.getByLabel('Light DJ trigger (%)')).toHaveValue('42');
    audio = await (await request.get('/api/audio')).json();
    expect(audio.ldjTrigger).toBe(before.ldjTrigger);
    await editor.getByRole('button', { name: 'Discard edits' }).click();
    await expect(editor.getByLabel('Light DJ trigger (%)')).toHaveValue(String(Math.round(before.ldjTrigger * 100)));
  } finally {
    await request.put('/api/audio', { data: { master: before.master, ldjTrigger: before.ldjTrigger, mode: before.mode } });
  }
});

test('half and double change global tempo without changing beat division and respect tempo bounds', async ({ page, request }) => {
  const before = await state(request);
  try {
    await set(request, { bpm: 123.5, beatDivision: 4 });
    await open(page, 'perform');
    await page.getByRole('button', { name: 'Half tempo', exact: true }).click();
    await until(request, (s) => s.bpm === 61.75 && s.beatDivision === 4);
    await page.getByRole('button', { name: 'Double tempo', exact: true }).click();
    await until(request, (s) => s.bpm === 123.5 && s.beatDivision === 4);
    await set(request, { bpm: 20 });
    await expect(page.getByRole('button', { name: 'Half tempo', exact: true })).toBeDisabled();
    await set(request, { bpm: 300 });
    await expect(page.getByRole('button', { name: 'Double tempo', exact: true })).toBeDisabled();
  } finally {
    await set(request, { bpm: before.bpm, beatDivision: before.beatDivision });
  }
});
