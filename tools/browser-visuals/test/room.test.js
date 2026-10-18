import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleUnits, roomProtocol, roomTarget } from '../room.js';
import { LeasePump } from '../pump.js';

// A 4 x 2 capture: the left half red, the right half blue.
const image = () => ({ width: 4, height: 2, data: Buffer.from([...Array(2).fill([255, 0, 0]).flat(), ...Array(2).fill([0, 0, 255]).flat(),
  ...Array(2).fill([255, 0, 0]).flat(), ...Array(2).fill([0, 0, 255]).flat()]) });

test('a unit takes the box average at its plan position; matrix cells stay black', () => {
  const units = [{ fixture: 1, cell: 0, x: 0, y: 50, grid: false }, { fixture: 2, cell: 0, x: 100, y: 50, grid: false }, { fixture: 3, cell: 0, x: 50, y: 50, grid: true }];
  const out = sampleUnits(image(), units);
  assert.deepEqual([...out.slice(0, 3)], [255, 0, 0]);
  assert.deepEqual([...out.slice(3, 6)], [0, 0, 255]);
  assert.deepEqual([...out.slice(6, 9)], [0, 0, 0]);
  assert.equal(out.length, 9);
});

test('positions beyond the plot clamp to the edge instead of reading outside the capture', () => {
  const units = [{ fixture: 1, cell: 0, x: -20, y: 150, grid: false }];
  assert.deepEqual([...sampleUnits(image(), units)], [255, 0, 0]);
});

test('the room target needs the shared base checks and a unit list, keyed by the rig signature', () => {
  assert.deepEqual(roomTarget({ ok: false, reason: 'Outputs disarmed' }, null), { ok: false, reason: 'Outputs disarmed' });
  assert.equal(roomTarget({ ok: true, state: {} }, null).ok, false);
  assert.deepEqual(roomTarget({ ok: true, state: {} }, { signature: 'rig-a', list: [] }), { ok: true, key: 'rig-a', signature: 'rig-a' });
});

test('the room protocol claims by signature, accepts only a matching unit count and sends one colour per unit', async () => {
  const calls = [];
  const transport = { connected: true, id: 'c1', request: async (event, payload) => { calls.push({ event, payload });
    return event === 'picture:claim' ? { ok: true, leaseId: 'lease', units: 2, ttlMs: 2000, maxFps: 20, format: 'rgb24', order: 'units' } : { ok: true }; } };
  const units = [{ fixture: 1, cell: 0, x: 0, y: 50, grid: false }, { fixture: 2, cell: 0, x: 100, y: 50, grid: false }];
  const pump = new LeasePump({ transport, capture: async () => image(), target: () => ({ ok: true, key: 'rig-a', signature: 'rig-a' }),
    fixtureId: 0, width: 4, height: 2, now: () => 0, protocol: roomProtocol });
  pump.units = units;
  await pump.step();
  assert.deepEqual(calls.map((c) => c.event), ['picture:claim', 'picture:frame']);
  assert.deepEqual(calls[0].payload, { signature: 'rig-a' });
  assert.deepEqual(calls[1].payload.leaseId, 'lease');
  assert.deepEqual([...calls[1].payload.data], [255, 0, 0, 0, 0, 255]);
  assert.equal(roomProtocol.accepts(pump, { format: 'rgb24', order: 'units', ttlMs: 2000, maxFps: 20, units: 3 }), false);
  assert.equal(roomProtocol.accepts(pump, { format: 'rgb24', order: 'row-major', ttlMs: 2000, maxFps: 20, units: 2 }), false);
});
