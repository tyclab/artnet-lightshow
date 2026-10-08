import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { PixelInputs, PixelInputError, PIXEL_INPUT_TTL_MS, PIXEL_INPUT_MAX_FPS } from '../../src/server/pixel-input.ts';
import { pixelInputs } from '../../src/server/pixel-input-live.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { createAuth } from '../../src/server/auth.ts';
import { createPublisher } from '../../src/server/protocol.ts';
import { state, getClientState } from '../../src/server/state.ts';
import { settings } from '../../src/server/settings.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { snapshotShow } from '../../src/server/show-store.ts';
import { setArmed } from '../../src/server/output.ts';

const grid = () => ({
  id: 'test-pixel-input', name: 'Pixel input test', channelCount: 12, channelMap: {}, grid: { columns: 2, rows: 2 },
  cells: Array.from({ length: 4 }, (_, i) => ({ channelMap: { red: 3 * i, green: 3 * i + 1, blue: 3 * i + 2 } })),
});
const CLAIM = { fixtureId: 53, width: 2, height: 2 };
const bytes = () => Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 19, 37, 61]);
function harness() {
  const context = { now: 100, armed: true, acknowledged: true, target: { profile: grid(), outputKey: 'ddp:127.0.0.1:4048' } };
  const manager = new PixelInputs({ now: () => context.now, armed: () => context.armed,
    acknowledged: () => context.acknowledged, target: (id) => id === CLAIM.fixtureId ? context.target : null });
  const claim = (owner = 'owner') => manager.claim(owner, CLAIM);
  const frame = (lease, data = bytes(), owner = 'owner') => manager.frame(owner, { fixtureId: CLAIM.fixtureId, leaseId: lease.leaseId, data });
  return { context, manager, claim, frame };
}
const refuses = (code, fn) => assert.throws(fn, (error) => error instanceof PixelInputError && error.code === code);

test('pixel input requires an armed and acknowledged rig without changing those controls', () => {
  const h = harness();
  h.context.armed = false;
  refuses('DISARMED', () => h.claim());
  assert.equal(h.context.armed, false);
  h.context.armed = true;
  h.context.acknowledged = false;
  refuses('ACKNOWLEDGEMENT_REQUIRED', () => h.claim());
  assert.equal(h.context.acknowledged, false);
  assert.deepEqual(h.manager.frames(), []);
});

test('a claim accepts a complete RGB grid, including explicit reordered coordinates', () => {
  const h = harness();
  h.context.target.profile.cells.forEach((cell, i) => { cell.at = { x: (3 - i) % 2, y: Math.floor((3 - i) / 2) }; });
  const claim = h.claim();
  assert.equal(claim.ok, true);
  assert.equal(claim.format, 'rgb24');
  assert.equal(claim.order, 'row-major');
  assert.equal(claim.ttlMs, PIXEL_INPUT_TTL_MS);
  assert.equal(claim.maxFps, PIXEL_INPUT_MAX_FPS);
  assert.deepEqual(h.manager.frames(), [], 'claiming without a frame preserves the existing picture');
  assert.equal(h.manager.status()[0].receiving, false);
});

test('claims reject malformed messages and dimensions without reserving the fixture', () => {
  for (const value of [null, [], 'panel', {}, { ...CLAIM, fixtureId: -1 }, { ...CLAIM, fixtureId: '53' },
    { ...CLAIM, fixtureId: 54 }, { ...CLAIM, width: 0 }, { ...CLAIM, width: 2.5 },
    { ...CLAIM, height: Infinity }, { ...CLAIM, width: 4, height: 1 }, { ...CLAIM, owner: 'forged' }]) {
    const h = harness();
    refuses('INVALID', () => h.manager.claim('owner', value));
    assert.deepEqual(h.manager.status(), []);
  }
});

test('only complete, unique, in-range RGB cell layouts accept screen input', () => {
  const changes = [
    (p) => { delete p.grid; }, (p) => { p.zoned = true; }, (p) => { p.cells.pop(); },
    (p) => { delete p.cells[0].channelMap.blue; },
    (p) => { p.cells[0].at = { x: 1, y: 0 }; },
    (p) => { p.cells[0].at = { x: 2, y: 0 }; },
    (p) => { p.cells[0].at = { x: 0, y: -1 }; },
    (p) => { p.cells[0].at = { x: 0.5, y: 0 }; },
  ];
  for (const change of changes) {
    const h = harness(); change(h.context.target.profile);
    refuses('INVALID', () => h.claim());
    assert.deepEqual(h.manager.frames(), []);
  }
});

test('a socket and lease id jointly own frames and release', () => {
  const h = harness(), lease = h.claim();
  h.frame(lease);
  refuses('BUSY', () => h.claim('other'));
  refuses('NO_LEASE', () => h.frame(lease, bytes(), 'other'));
  refuses('NO_LEASE', () => h.frame({ leaseId: 'forged' }));
  refuses('NO_LEASE', () => h.manager.release('other', { fixtureId: 53, leaseId: lease.leaseId }));
  assert.equal(h.manager.frames().length, 1);
  h.manager.release('owner', { fixtureId: 53, leaseId: lease.leaseId });
  assert.deepEqual(h.manager.frames(), []);
  const next = h.claim('other');
  assert.notEqual(next.leaseId, lease.leaseId);
  refuses('NO_LEASE', () => h.frame(lease));
});

test('accepted frames copy only the supplied byte view and replace older pictures', () => {
  const h = harness(), lease = h.claim();
  const packet = Buffer.alloc(20, 99), data = packet.subarray(3, 15);
  data.set(bytes());
  h.frame(lease, data);
  packet.fill(0);
  assert.deepEqual(h.manager.frames()[0].data, bytes(), 'caller buffer reuse cannot alter the accepted frame');
  h.context.now += 1000 / PIXEL_INPUT_MAX_FPS;
  const next = new Uint8Array(12).fill(37);
  h.frame(lease, next);
  assert.equal(h.manager.frames().length, 1, 'pictures are replaced, not queued');
  assert.deepEqual(h.manager.frames()[0].data, next);
});

test('only exact binary RGB24 frames renew ownership', () => {
  for (const data of [Array.from(bytes()), bytes().buffer, new DataView(bytes().buffer), 'rgb',
    new Uint8Array(11), new Uint8Array(13), new Uint16Array(6), null]) {
    const h = harness(), lease = h.claim();
    h.frame(lease);
    h.context.now += PIXEL_INPUT_TTL_MS - 1;
    refuses('INVALID', () => h.frame(lease, data));
    h.context.now++;
    assert.deepEqual(h.manager.frames(), [], 'an invalid frame cannot keep the last valid picture alive');
  }
});

test('claim retries and frame-rate refusals do not extend the last accepted frame', () => {
  const h = harness(), lease = h.claim();
  h.frame(lease);
  h.context.now += 1;
  refuses('RATE_LIMIT', () => h.frame(lease));
  h.context.now += PIXEL_INPUT_TTL_MS - 2;
  assert.equal(h.claim().leaseId, lease.leaseId);
  h.context.now++;
  refuses('NO_LEASE', () => h.frame(lease));
  assert.deepEqual(h.manager.status(), []);
  assert.notEqual(h.claim().leaseId, lease.leaseId);
});

test('frames carry absolute expiry in the requested renderer clock', () => {
  const h = harness(), lease = h.claim();
  h.frame(lease);
  const shift = 987654321;
  assert.equal(h.manager.frames(shift)[0].expiresAt, h.context.now + PIXEL_INPUT_TTL_MS + shift);
  h.context.now += PIXEL_INPUT_TTL_MS - 1;
  assert.equal(h.manager.frames(shift)[0].expiresAt, 100 + PIXEL_INPUT_TTL_MS + shift, 'reads cannot renew expiry');
  h.context.now++;
  assert.deepEqual(h.manager.frames(shift), []);
});

test('patch removal, profile replacement and changed destination revoke the old lease', () => {
  for (const change of [
    (c) => { c.target = null; },
    (c) => { c.target = { ...c.target, profile: grid() }; },
    (c) => { c.target = { ...c.target, outputKey: 'ddp:127.0.0.2:4048' }; },
  ]) {
    const h = harness(), lease = h.claim(); h.frame(lease);
    change(h.context);
    assert.deepEqual(h.manager.frames(), []);
    refuses('NO_LEASE', () => h.frame(lease));
  }
});

test('disarm and acknowledgement revocation clear pictures without resurrecting old leases', () => {
  for (const key of ['armed', 'acknowledged']) {
    const h = harness(), lease = h.claim(); h.frame(lease);
    h.context[key] = false;
    assert.deepEqual(h.manager.frames(), []);
    h.context[key] = true;
    refuses('NO_LEASE', () => h.frame(lease));
    assert.notEqual(h.claim().leaseId, lease.leaseId);
  }
});

test('disconnect clears only that owner, and status omits lease tokens and pixel bytes', () => {
  const h = harness(), lease = h.claim(); h.frame(lease);
  h.manager.disconnect('other');
  assert.deepEqual(h.manager.status(), [{ fixtureId: 53, width: 2, height: 2, remainingMs: PIXEL_INPUT_TTL_MS, receiving: true }]);
  h.manager.disconnect('owner');
  assert.deepEqual(h.manager.frames(), []);
});

async function serve(t) {
  const saved = { fixtures: state.fixtures, settings: settings._values };
  const profile = grid(); registerProfile(profile);
  state.fixtures = [{ id: 53, label: 'Test panel', universe: 1, address: 1, profileId: profile.id,
    maxBrightness: 255, override: null, output: { protocol: 'ddp', host: '127.0.0.1' } }];
  settings._values = { ...saved.settings, safety: { ...saved.settings.safety, photosensitivityAcknowledged: true } };
  setArmed(false);
  const auth = createAuth({ token: 'local-pixel-test-token' });
  const server = http.createServer(), io = new Server(server, { allowRequest: auth.allowSocketRequest });
  io.use(auth.socketMiddleware);
  const publisher = createPublisher(io);
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations: { broadcast() {}, publisher } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => io.close(resolve));
    setArmed(false); pixelInputs.clear(); state.fixtures = saved.fixtures;
    settings._values = saved.settings; unregisterProfile(profile.id);
  });
  function client(token = 'local-pixel-test-token') {
    const socket = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'],
      auth: { token, protocol: 2 }, forceNew: true, reconnection: false });
    clients.push(socket); return socket;
  }
  return { client, io };
}
const emit = (socket, op, payload) => socket.timeout(3000).emitWithAck(`pixel-input:${op}`, payload);

test('authenticated sockets enforce ownership, binary frames, disconnect and disarm lifecycle', { timeout: 10000 }, async (t) => {
  const s = await serve(t);
  const refused = s.client('wrong-test-token');
  const [error] = await once(refused, 'connect_error');
  assert.equal(error.data.code, 'unauthorized');
  assert.deepEqual(pixelInputs.status(), []);
  const first = s.client(), second = s.client();
  await Promise.all([once(first, 'snapshot'), once(second, 'snapshot')]);
  assert.equal((await emit(first, 'claim', CLAIM)).code, 'DISARMED');
  setArmed(true);
  const lease = await emit(first, 'claim', CLAIM);
  assert.equal(lease.ok, true);
  assert.equal((await emit(second, 'claim', CLAIM)).code, 'BUSY');
  const frame = { fixtureId: 53, leaseId: lease.leaseId, data: Buffer.from(bytes()) };
  assert.deepEqual(await emit(first, 'frame', frame), { ok: true });
  assert.deepEqual(pixelInputs.frames()[0].data, bytes(), 'Socket.IO binary reconstruction reaches the real runtime');
  assert.equal((await emit(second, 'frame', frame)).code, 'NO_LEASE');
  assert.equal((await emit(second, 'release', { fixtureId: 53, leaseId: lease.leaseId })).code, 'NO_LEASE');
  for (const saved of [getClientState(), snapshotShow()]) {
    assert.equal(Object.hasOwn(saved, 'pixelInputs'), false);
    assert.equal(JSON.stringify(saved).includes(lease.leaseId), false);
  }
  const gone = once(s.io.sockets.sockets.get(first.id), 'disconnect');
  first.disconnect(); await gone;
  assert.deepEqual(pixelInputs.frames(), []);
  const next = await emit(second, 'claim', CLAIM);
  assert.equal(next.ok, true);
  setArmed(false); setArmed(true);
  assert.equal((await emit(second, 'frame', { ...frame, leaseId: next.leaseId })).code, 'NO_LEASE', 'even immediate rearm invalidates the previous lease');
  const fresh = await emit(second, 'claim', CLAIM);
  assert.notEqual(fresh.leaseId, next.leaseId);
  assert.deepEqual(await emit(second, 'release', { fixtureId: 53, leaseId: fresh.leaseId }), { ok: true });
  assert.deepEqual(pixelInputs.status(), []);
});

test('socket message flooding disconnects its source and relinquishes ownership', { timeout: 10000 }, async (t) => {
  const s = await serve(t), socket = s.client();
  await once(socket, 'snapshot'); setArmed(true);
  assert.equal((await emit(socket, 'claim', CLAIM)).ok, true);
  const disconnected = once(socket, 'disconnect');
  for (let i = 0; i < 61; i++) socket.emit('pixel-input:frame', {});
  await disconnected;
  assert.deepEqual(pixelInputs.status(), []);
});
