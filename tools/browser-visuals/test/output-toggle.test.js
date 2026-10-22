import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMirror } from '../state.js';
import { LeasePump } from '../pump.js';
import { roomProtocol, roomTarget } from '../room.js';

function outputs() {
  let now = 0, captures = 0;
  const calls = [], mirror = new StateMirror(() => now);
  const cells = [0, 3].map(red => ({ channelMap: { red, green: red + 1, blue: red + 2 } }));
  mirror.snapshot({ protocol: 2, versions: { rig: 1 }, state: {
    armed: true, clock: { bpm: 120, beatPos: 0, at: 0 }, safety: { photosensitivityAcknowledged: true },
    picture: { source: 'visualizer' },
    fixtures: [53, 38, 39].map(id => ({ id, profileId: 'panel', output: { protocol: 'ddp', host: 'example.invalid' } })),
    profiles: { panel: { grid: { columns: 2, rows: 1 }, cells } },
  } });
  const units = { signature: 'rig', list: [{ fixture: 1, cell: 0, x: 50, y: 50 }] };
  const pumps = [53, 38, 39, 'room'].map(id => {
    const panel = { fixtureId: id, width: 2, height: 1 };
    const pump = new LeasePump({ ...panel, now: () => now,
      target: () => id === 'room' ? roomTarget(mirror.base(), units) : mirror.target(panel),
      capture: async () => { captures++; return { width: 2, height: 1, data: new Uint8Array(6).fill(128) }; },
      transport: { connected: true, id: `socket-${id}`, request: async (event) => {
        calls.push({ id, event });
        return event.endsWith('claim') ? { ok: true, leaseId: `lease-${id}`, ttlMs: 2000, maxFps: 60, format: 'rgb24',
          order: id === 'room' ? 'units' : 'row-major', units: 1 } : { ok: true };
      } },
      ...(id === 'room' ? { protocol: roomProtocol } : {}),
    });
    pump.units = units.list; return pump;
  });
  return { pumps, calls, captures: () => captures, step: () => Promise.all(pumps.map(pump => pump.step())),
    source: (source, version) => mirror.patch({ d: 'rig', v: version, set: { picture: { source } } }),
    time: value => { now = value; },
  };
}

test('Effects releases curtain, both GLORBs and room once, stops capture and claims, then Visualizer resumes', async () => {
  const h = outputs(); await h.step();
  assert.equal(h.captures(), 4);
  h.source('effects', 2); await h.step();
  assert.equal(h.calls.filter(({ event }) => event.endsWith('release')).length, 4);
  assert.ok(h.pumps.every(pump => pump.lease === null && pump.waiting === 'Visualizer not selected'));
  const paused = h.calls.length;
  for (const at of [100, 400, 800]) { h.time(at); await h.step(); }
  assert.equal(h.calls.length, paused); assert.equal(h.captures(), 4);
  h.source('visualizer', 3); h.time(1050); await h.step();
  assert.equal(h.calls.filter(({ event }) => event.endsWith('claim')).length, 8);
  assert.equal(h.calls.filter(({ event }) => event.endsWith('frame')).length, 8);
  assert.equal(h.captures(), 8); assert.ok(h.pumps.every(pump => pump.failures === 0));
});

test('selecting Effects during capture drops all pending visualizer frames and releases their leases', async () => {
  const h = outputs(), captured = [];
  for (const pump of h.pumps) pump.capture = () => new Promise(resolve => captured.push(resolve));
  const pending = h.step(); await Promise.resolve();
  assert.equal(captured.length, 4);
  h.source('effects', 2);
  for (const resolve of captured) resolve({ width: 2, height: 1, data: new Uint8Array(6) });
  await pending;
  assert.equal(h.calls.some(({ event }) => event.endsWith('frame')), false);
  assert.equal(h.calls.filter(({ event }) => event.endsWith('release')).length, 4);
  assert.ok(h.pumps.every(pump => pump.lease === null && pump.retryAt === 0));
});

test('Colour + motion keeps only the room capture and drops pending curtain and panel frames', async () => {
  const h = outputs(), captured = [];
  for (const pump of h.pumps) pump.capture = () => new Promise(resolve => captured.push(resolve));
  const pending = h.step(); await Promise.resolve();
  assert.equal(captured.length, 4);
  h.source('inspired', 2);
  for (const resolve of captured) resolve({ width: 2, height: 1, data: new Uint8Array(6).fill(128) });
  await pending;
  assert.deepEqual(h.calls.filter(({ event }) => event.endsWith('frame')).map(({ id }) => id), ['room']);
  assert.equal(h.calls.filter(({ event }) => event.endsWith('release')).length, 3);
  assert.ok(h.pumps.slice(0, 3).every(pump => pump.lease === null));
  assert.ok(h.pumps[3].lease);
  h.source('visualizer', 3); h.time(100);
  for (const pump of h.pumps) pump.capture = async () => ({ width: 2, height: 1, data: new Uint8Array(6) });
  await h.step();
  assert.equal(h.calls.filter(({ event }) => event.endsWith('claim')).length, 7, 'only the three paused feeds reclaim');
  assert.ok(h.pumps.every(pump => pump.lease));
});
