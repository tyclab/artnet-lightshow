import test from 'node:test';
import assert from 'node:assert/strict';
import { LeasePump } from '../pump.js';

const image = () => ({ width: 2, height: 1, data: Buffer.from([1, 2, 3, 4, 5, 6]) });
const claim = () => ({ ok: true, leaseId: 'lease', ttlMs: 2000, maxFps: 20, format: 'rgb24', order: 'row-major' });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(overrides = {}) {
  let now = 0, state = { ok: true, key: 'target' };
  const calls = [], transport = { connected: true, id: 'connection1', request: async (event, payload) => { calls.push({ event, payload }); return event.endsWith('claim') ? claim() : { ok: true }; } };
  const pump = new LeasePump({ transport, capture: async () => image(), target: () => state, fixtureId: 53, width: 2, height: 1, now: () => now, ...overrides });
  return { pump, transport, calls, setTime: value => { now = value; }, setState: value => { state = value; } };
}
test('one outstanding capture and frame acknowledgement; no caller backlog', async () => {
  const captured = deferred(), h = setup({ capture: () => captured.promise });
  const first = h.pump.step(); await Promise.resolve();
  await Promise.all([h.pump.step(), h.pump.step(), h.pump.step()]);
  assert.deepEqual(h.calls.map(x => x.event), ['pixel-input:claim']);
  captured.resolve(image()); await first;
  assert.equal(h.calls.filter(x => x.event.endsWith('frame')).length, 1);
  assert.ok(h.calls[1].payload.data instanceof Uint8Array);
  h.setTime(100);
  const ack = deferred(); h.transport.request = async () => ack.promise;
  const next = h.pump.step(); await Promise.resolve(); await h.pump.step();
  assert.equal(h.pump.frames, 1); ack.resolve({ ok: true }); await next; assert.equal(h.pump.frames, 2);
});
test('capture completed after disconnect/reconnect never sends an old frame', async () => {
  const captured = deferred(), h = setup({ capture: () => captured.promise });
  const pending = h.pump.step(); await Promise.resolve();
  h.transport.connected = false; await h.pump.invalidate(); h.transport.id = 'connection2'; h.transport.connected = true;
  captured.resolve(image()); await pending;
  assert.equal(h.calls.some(x => x.event.endsWith('frame')), false);
  assert.equal(h.pump.lease, null);
});
test('late claim after stop is released and never captures', async () => {
  let captures = 0; const claimed = deferred(), h = setup({ capture: async () => { captures++; return image(); } });
  h.transport.request = async (event, payload) => { h.calls.push({ event, payload }); return event.endsWith('claim') ? claimed.promise : { ok: true }; };
  const pending = h.pump.step(); await h.pump.stop(); claimed.resolve(claim()); await pending;
  assert.equal(captures, 0); assert.deepEqual(h.calls.map(x => x.event), ['pixel-input:claim', 'pixel-input:release']);
});
test('disarm, changed target and stale captured frame cannot renew the lease', async () => {
  for (const mutate of [h => h.setState({ ok: false, reason: 'Disarmed' }), h => h.setState({ ok: true, key: 'newtarget' }), h => h.setTime(501)]) {
    const captured = deferred(), h = setup({ capture: () => captured.promise });
    const pending = h.pump.step(); await Promise.resolve(); mutate(h); captured.resolve(image()); await pending;
    assert.equal(h.calls.some(x => x.event.endsWith('frame')), false);
    assert.equal(h.calls.at(-1).event, 'pixel-input:release');
  }
});
test('target conflicts back off and never capture; success resets retries', async () => {
  let captures = 0; const h = setup({ capture: async () => { captures++; return image(); } });
  h.transport.request = async event => { h.calls.push({ event }); return { ok: false, code: 'BUSY', error: 'not logged' }; };
  await h.pump.step(); assert.equal(h.pump.retryAt, 1000);
  h.setTime(999); await h.pump.step(); assert.equal(h.calls.length, 1);
  h.setTime(1000); await h.pump.step(); assert.equal(h.pump.retryAt, 3000); assert.equal(captures, 0);
  h.setTime(3000); h.transport.request = async event => event.endsWith('claim') ? claim() : { ok: true };
  await h.pump.step(); assert.equal(h.pump.frames, 1); assert.equal(h.pump.failures, 0);
});
test('browser capture failure and server lease loss release once without replaying a cached image', async () => {
  const h = setup(); await h.pump.step();
  h.setTime(100);
  h.pump.capture = async () => { throw new Error('Browser gone'); }; await h.pump.step();
  assert.equal(h.pump.lease, null); assert.equal(h.calls.filter(x => x.event.endsWith('frame')).length, 1);
  const lost = setup(); lost.transport.request = async event => event.endsWith('claim') ? claim() : { ok: false, code: 'NO_LEASE' };
  await lost.pump.step(); assert.equal(lost.pump.lease, null); assert.equal(lost.pump.frames, 0);
});
test('an incompatible successful claim is explicitly released without sending pixels', async () => {
  const h = setup();
  h.transport.request = async (event, payload) => {
    h.calls.push({ event, payload }); return event.endsWith('claim') ? { ...claim(), maxFps: undefined } : { ok: true };
  };
  await h.pump.step();
  assert.deepEqual(h.calls.map(x => x.event), ['pixel-input:claim', 'pixel-input:release']);
  assert.equal(h.pump.lease, null);
});
test('slow captures cannot cause catch-up bursts after a frame acknowledgement', async () => {
  let now = 0;
  const sentAt = [];
  const transport = { connected: true, id: 'connection', request: async event => {
    if (event.endsWith('claim')) return claim();
    if (event.endsWith('frame')) { sentAt.push(now); now += 10; }
    return { ok: true };
  } };
  const pump = new LeasePump({ transport, target: () => ({ ok: true, key: 'target' }), fixtureId: 53, width: 2, height: 1, now: () => now,
    capture: async () => { now += sentAt.length ? 1 : 150; return image(); },
  });
  await pump.step(); assert.deepEqual(sentAt, [150]); assert.equal(pump.nextCaptureAt, 260);
  now = 200; await pump.step(); assert.equal(sentAt.length, 1);
  now = 260; await pump.step(); assert.deepEqual(sentAt, [150, 261]);
});
