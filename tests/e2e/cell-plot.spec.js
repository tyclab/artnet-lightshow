import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';
import { open, state } from './helpers.js';

test('explicit cell maps reach picture sampling and a mounted preview, and incompatible profile edits are rejected', async ({ page, request, baseURL }) => {
  const profileId = 'e2e-cell-plot';
  const profile = { id: profileId, name: 'Mapped cells', cells: 2, firstChannel: 1, order: 'RGB' };
  const geometry = { length: 12, angle: 90, points: [{ x: -4, y: -6, height: -10 }, { x: 4, y: 6, height: 10 }] };
  const socket = io(baseURL, { auth: { protocol: 2 }, transports: ['websocket'] });
  let id;
  const errors = [];
  socket.on('error-msg', error => errors.push(error));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const units = () => socket.timeout(5000).emitWithAck('picture:units');
  try {
    expect((await request.post('/api/profiles/bar', { data: profile })).ok()).toBe(true);
    const response = await request.post('/api/fixtures', { data: { profileId, count: 1, universe: 7, label: 'Mapped cells' } });
    expect(response.ok()).toBe(true);
    id = (await response.json()).fixtures[0];
    socket.emit('fixture', { id, position: { x: 50, y: 50, height: 40 }, geometry });
    await expect.poll(async () => (await state(request)).fixtures.find(f => f.id === id).geometry).toEqual(geometry);
    const mapped = await units();
    expect(mapped.list.filter(p => p.fixture === id).map(p => [p.x, p.y])).toEqual([[56, 46], [44, 54]]);
    await open(page, 'stage');
    const canvas = page.locator('.stage3d-canvas');
    const mounted = await canvas.elementHandle();
    await expect(page.locator('.stage3d-note')).toHaveCount(0);
    const next = structuredClone(geometry);
    next.points[0].height = -5;
    socket.emit('fixture', { id, geometry: next });
    await expect.poll(async () => (await units()).signature).not.toBe(mapped.signature);
    expect(await mounted.evaluate(canvas => canvas.isConnected)).toBe(true);
    const rejected = await request.post('/api/profiles/bar', { data: { ...profile, cells: 3 } });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error).toMatch(/2 points.*3/);
    const bad = { ...next, points: [next.points[0]] };
    socket.emit('fixture', { id, geometry: bad });
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0].message).toMatch(/1 points.*2/);
    expect((await state(request)).fixtures.find(f => f.id === id).geometry).toEqual(next);
    socket.emit('fixture', { id, geometry: null });
    await expect.poll(async () => (await state(request)).fixtures.find(f => f.id === id).geometry).toBe(null);
    expect((await request.post('/api/profiles/bar', { data: { ...profile, cells: 3 } })).ok()).toBe(true);
  } finally {
    socket.close();
    if (id !== undefined) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${profileId}`);
  }
});
