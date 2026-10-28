import test from 'node:test';
import assert from 'node:assert';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { dtls } from 'node-dtls-client';

import * as hue from '../../src/server/hue.ts';

// Some bridges answer the cookie exchange but stall until the area is reopened;
// changing only the socket leaves every retry in the same broken session.

const AREA = '0123abcd-1234-5678-9abc-def012345678';
const PAIRED = {
  id: 'b1', label: 'PartyLounge', enabled: true, host: '10.0.0.2', username: 'user',
  clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA,
};
const RED = [{ id: 0, r: 255, g: 0, b: 0 }];
const OURS = { data: [{ id: AREA, status: 'active', active_streamer: { rid: 'app-id', rtype: 'auth_v1' } }] };

function fakeBridge(t, { put = () => ({ status: 200, body: { data: [{ rid: AREA }], errors: [] } }), area = () => ({ status: 200, body: OURS }) } = {}) {
  const calls = [];
  t.mock.method(https, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (chunk) => { payload += chunk; };
    req.destroy = (err) => { if (err) setImmediate(() => req.emit('error', err)); };
    req.end = () => {
      const call = { method: options.method, host: options.host, path: options.path, body: payload ? JSON.parse(payload) : undefined };
      calls.push(call);
      const reply = options.method === 'PUT' ? put(call) : area(call);
      const respond = () => {
        const res = new EventEmitter();
        res.statusCode = reply.status;
        res.headers = {};
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify(reply.body)));
        res.emit('end');
      };
      if (reply.defer) reply.defer(respond); else setImmediate(respond);
    };
    return req;
  });
  return calls;
}

// plan[i] is when the i-th handshake completes; a missing entry is one whose
// datagram was lost, which the library reports only when its timer runs out.
function fakeDtls(t, plan = []) {
  const sockets = [];
  t.mock.method(dtls, 'createSocket', (options) => {
    const socket = new EventEmitter();
    socket.options = options;
    socket.closed = false;
    socket.close = () => { socket.closed = true; };
    socket.send = () => {};
    const after = plan[sockets.length];
    sockets.push(socket);
    if (after == null || after >= options.timeout) {
      setTimeout(() => { if (!socket.closed) socket.emit('error', new Error('The DTLS handshake timed out')); }, options.timeout);
    } else {
      setTimeout(() => { if (!socket.closed) socket.emit('connected'); }, after);
    }
    return socket;
  });
  return sockets;
}

function quiet(t) {
  const lines = [];
  for (const method of ['log', 'warn']) t.mock.method(console, method, (...args) => { lines.push(args.join(' ')); });
  return lines;
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

async function until(t, done, limit) {
  let elapsed = 0;
  await settle();
  while (!done() && elapsed < limit) {
    t.mock.timers.tick(10);
    elapsed += 10;
    await settle();
  }
  return elapsed;
}

const actions = (calls) => calls.filter((c) => c.method === 'PUT').map((c) => c.body.action);

test('a stalled handshake reopens its owned Entertainment session before retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const lines = quiet(t);
  const calls = fakeBridge(t);
  const sockets = fakeDtls(t, [undefined, 80]);
  const session = new hue.HueSession(PAIRED);

  assert.strictEqual(session.sendFrame(RED), false, 'the handshake is in flight');
  const took = await until(t, () => session.getStatus().status === 'streaming', 3000);

  assert.strictEqual(session.getStatus().status, 'streaming');
  assert.ok(took <= 1200, `streaming after ${took} ms`);
  assert.strictEqual(sockets.length, 2);
  assert.ok(sockets[0].closed, 'the stalled handshake is closed');
  assert.deepStrictEqual(actions(calls), ['start', 'stop', 'start'], 'release the stalled session before the next handshake');
  assert.ok(lines.some((l) => /timed out.*try 2 of 5/.test(l)), 'the lost try is logged');
  assert.strictEqual(session.sendFrame(RED), true, 'frames flow');
  await session.stop();
});

test('a bridge that answers no handshake falls back to the backoff after five tries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const calls = fakeBridge(t);
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);

  session.sendFrame(RED);
  const took = await until(t, () => session.getStatus().status === 'failed', 10000);

  assert.strictEqual(session.getStatus().status, 'failed');
  assert.match(session.getStatus().error, /timed out/);
  assert.ok(took >= 5000 && took <= 5200, `failed after ${took} ms`);
  assert.strictEqual(sockets.length, 5);
  assert.deepStrictEqual(actions(calls), Array.from({ length: 5 }, () => ['start', 'stop']).flat());
  assert.strictEqual(session.sendFrame(RED), false);
  await settle();
  assert.strictEqual(sockets.length, 5, 'backing off: the next frame starts nothing');
});

test('a timeout never stops an area taken by another controller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let reads = 0;
  const calls = fakeBridge(t, { area: () => ({ status: 200, body: ++reads <= 2 ? OURS
    : { data: [{ id: AREA, metadata: { name: 'Other stream' }, status: 'active', active_streamer: { rid: 'other-app' } }] } }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 2000);
  assert.match(session.getStatus().error, /Other stream.*already in use/);
  assert.deepStrictEqual(actions(calls), ['start']);
  assert.strictEqual(sockets.length, 1);
  await session.stop();
  assert.deepStrictEqual(actions(calls), ['start']);
});

test('a retry leaves the bridge alone when ownership cannot be verified', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let reads = 0;
  const calls = fakeBridge(t, { area: () => ++reads <= 2 ? { status: 200, body: OURS }
    : { status: 500, body: { errors: [{ description: 'unavailable' }] } } });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 2000);
  assert.match(session.getStatus().error, /could not verify.*ownership/);
  assert.deepStrictEqual(actions(calls), ['start']);
  assert.strictEqual(sockets.length, 1);
  await assert.rejects(session.stop(), /could not verify.*ownership/);
  assert.deepStrictEqual(actions(calls), ['start']);
});

test('a controller taking the area after retry release is not displaced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let released = false;
  const calls = fakeBridge(t, {
    put: ({ body }) => { if (body.action === 'stop') released = true; return { status: 200, body: { data: [] } }; },
    area: () => ({ status: 200, body: released ? { data: [OTHER_AREA] } : OURS }),
  });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 2000);
  assert.match(session.getStatus().error, /TV Couch.*already in use/);
  assert.deepStrictEqual(actions(calls), ['start', 'stop']);
  assert.strictEqual(sockets.length, 1);
  await session.stop();
});

for (const pendingAction of ['stop', 'start']) {
  test(`disarming during a retry's ${pendingAction} cannot reconnect later`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    quiet(t);
    let respond, starts = 0, stops = 0;
    const calls = fakeBridge(t, { put: ({ body }) => {
      if (body.action === 'start') starts++; else stops++;
      const defer = body.action === pendingAction && (pendingAction === 'start' ? starts === 2 : stops === 1);
      return { status: 200, body: { data: [] }, ...(defer ? { defer: send => { respond = send; } } : {}) };
    } });
    const sockets = fakeDtls(t);
    const session = new hue.HueSession(PAIRED);
    session.sendFrame(RED);
    await until(t, () => !!respond, 2000);
    assert.ok(respond);
    const stopping = session.stop();
    session.sendFrame(RED);
    assert.strictEqual(starts, pendingAction === 'start' ? 2 : 1, 'a pending retry must settle first');
    respond();
    await stopping;
    await settle();
    assert.strictEqual(session.getStatus().status, 'idle');
    assert.strictEqual(sockets.length, 1);
    assert.strictEqual(actions(calls).at(-1), 'stop');
  });
}

// A disarm during backoff used to carry the doubled delay into the next arm,
// up to a minute dark on a bridge that had long recovered.
test('stop() resets the backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const calls = fakeBridge(t, { put: ({ body }) => body.action === 'start'
    ? { status: 503, body: { errors: [{ description: 'bridge busy' }] } } : { status: 200, body: { data: [] } } });
  fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  const starts = () => actions(calls).filter((a) => a === 'start').length;

  for (const wait of [2000, 4000]) {
    session.sendFrame(RED);
    await until(t, () => false, wait);
  }
  session.sendFrame(RED);
  await settle();
  assert.strictEqual(starts(), 3);
  assert.strictEqual(session.getStatus().status, 'failed');

  await session.stop();
  session.sendFrame(RED);
  await until(t, () => false, 2000);
  session.sendFrame(RED);
  await settle();
  assert.strictEqual(starts(), 5, 'the first retry after a stop comes at the base delay');
});

// The bridge accepts a start on an area another app is streaming (a Sync Box,
// the Hue app); the handshake then times out and was reported as such.
test('an area another app is streaming is reported as held, and left to it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const held = { data: [{ id: AREA, metadata: { name: 'TV Lounge' }, status: 'active', active_streamer: { rid: 'sync-box-app', rtype: 'auth_v1' } }] };
  const calls = fakeBridge(t, { area: () => ({ status: 200, body: held }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);

  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 3000);

  assert.strictEqual(session.getStatus().status, 'failed');
  assert.match(session.getStatus().error, /TV Lounge.*already in use/);
  assert.strictEqual(sockets.length, 0, 'no handshake against an area that is not ours');
  assert.deepStrictEqual(actions(calls), [], 'no start or stop for a stream that is not ours');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path.endsWith('/entertainment_configuration')));
});

test('an area that cannot be read blocks the handshake', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  fakeBridge(t, { area: () => ({ status: 500, body: { errors: [{ description: 'internal error' }] } }) });
  fakeDtls(t, [50]);
  const session = new hue.HueSession(PAIRED);

  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 1000);
  assert.strictEqual(session.getStatus().status, 'failed');
  await session.stop();
});

const OTHER_AREA = { id: 'other-area', metadata: { name: 'TV Couch' }, status: 'active', active_streamer: { rid: 'other-app' } };

test('another active area blocks only its bridge, then reconnects after release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let occupied = true;
  const calls = fakeBridge(t, { area: ({ host }) => ({ status: 200, body: host === PAIRED.host && occupied
    ? { data: [{ id: AREA, status: 'inactive' }, OTHER_AREA] } : OURS }) });
  const sockets = fakeDtls(t, [10, 10]);
  const first = new hue.HueSession(PAIRED);
  const second = new hue.HueSession({ ...PAIRED, id: 'b2', host: '10.0.0.3' });
  first.sendFrame(RED);
  second.sendFrame(RED);
  await until(t, () => first.getStatus().status === 'failed' && second.getStatus().status === 'streaming', 1000);
  assert.match(first.getStatus().error, /TV Couch.*already in use/);
  assert.strictEqual(second.getStatus().status, 'streaming');
  assert.deepStrictEqual(actions(calls.filter((c) => c.host === PAIRED.host)), []);
  assert.strictEqual(sockets.length, 1);
  occupied = false;
  t.mock.timers.tick(2000);
  first.sendFrame(RED);
  await until(t, () => first.getStatus().status === 'streaming', 1000);
  assert.strictEqual(first.getStatus().status, 'streaming');
  assert.strictEqual(first.getStatus().error, null);
  assert.strictEqual(second.getStatus().status, 'streaming');
  await first.stop();
  await second.stop();
});

test('ownership changed during start is reported without stopping the new owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let reads = 0;
  const calls = fakeBridge(t, { area: () => ({ status: 200, body: ++reads === 1 ? { data: [{ id: AREA, status: 'inactive' }] } : { data: [OTHER_AREA] } }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 1000);
  assert.match(session.getStatus().error, /TV Couch/);
  assert.deepStrictEqual(actions(calls), ['start']);
  assert.strictEqual(sockets.length, 0);
  await session.stop();
  assert.deepStrictEqual(actions(calls), ['start']);
});

test('an unknown application identity never takes an already active area', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const calls = fakeBridge(t);
  const sockets = fakeDtls(t);
  const session = new hue.HueSession({ ...PAIRED, applicationId: '' });
  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 1000);
  assert.match(session.getStatus().error, /application identity/);
  assert.deepStrictEqual(actions(calls), []);
  assert.strictEqual(sockets.length, 0);
});

test('disarming during the ownership check cannot start a session later', async (t) => {
  quiet(t);
  let respond;
  const calls = fakeBridge(t, { area: () => ({ status: 200, body: { data: [] }, defer: (send) => { respond = send; } }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await settle();
  assert.ok(respond);
  const stopping = session.stop();
  respond();
  await stopping;
  await settle();
  assert.strictEqual(session.getStatus().status, 'idle');
  assert.deepStrictEqual(actions(calls), []);
  assert.strictEqual(sockets.length, 0);
});

test('reconfiguration during start releases the old area on the old bridge', async (t) => {
  quiet(t);
  let respond;
  const calls = fakeBridge(t, { put: ({ body }) => ({ status: 200, body: { data: [] },
    ...(body.action === 'start' ? { defer: (send) => { respond = send; } } : {}) }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await settle();
  assert.ok(respond);
  session.configure({ host: '10.0.0.9', entertainmentId: 'replacement-area' });
  session.sendFrame(RED);
  assert.deepStrictEqual(actions(calls), ['start'], 'the old pending start must settle first');
  respond();
  await settle();
  const stops = calls.filter((c) => c.body?.action === 'stop');
  assert.strictEqual(stops.length, 1);
  assert.strictEqual(stops[0].host, PAIRED.host);
  assert.ok(stops[0].path.endsWith(AREA));
  assert.strictEqual(sockets.length, 0);
  assert.strictEqual(session.getStatus().status, 'idle');
});

test('reliability: unreadable ownership after release prevents a second start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  let released = false;
  const calls = fakeBridge(t, {
    put: ({ body }) => { released ||= body.action === 'stop'; return { status: 200, body: { data: [] } }; },
    area: () => released ? { status: 503, body: { errors: [{ description: 'unavailable' }] } } : { status: 200, body: OURS },
  });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await until(t, () => released, 1200);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start', 'stop']);
  assert.strictEqual(sockets.length, 1);
  assert.strictEqual(session.getStatus().status, 'failed');
});

test('reliability: HTTP200 CLIP errors are not ownership evidence', async (t) => {
  quiet(t);
  const calls = fakeBridge(t, { area: () => ({ status: 200, body: { data: [], errors: [{ description: 'denied' }] } }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await settle();
  assert.deepStrictEqual(actions(calls), []);
  assert.strictEqual(sockets.length, 0);
  assert.strictEqual(session.getStatus().status, 'failed');
});

test('reliability: stop waits for release and re-addition cannot overtake it', async (t) => {
  quiet(t);
  let release;
  const calls = fakeBridge(t, { put: ({ body }) => ({ status: 200, body: { data: [] },
    ...(body.action === 'stop' ? { defer: respond => { release = respond; } } : {}) }) });
  const sockets = fakeDtls(t);
  hue.configureBridges([PAIRED]);
  const session = hue.getSession(PAIRED.id);
  session.sendFrame(RED);
  await settle();
  sockets[0].emit('connected');
  let stopped = false;
  const stopping = session.stop().then(() => { stopped = true; });
  t.after(async () => { if (release) release(); await stopping; hue._reset(); });
  await settle();
  hue.configureBridges([]);
  hue.configureBridges([PAIRED]);
  hue.getSession(PAIRED.id).sendFrame(RED);
  await settle();
  assert.strictEqual(stopped, false);
  assert.deepStrictEqual(actions(calls), ['start', 'stop']);
  assert.strictEqual(sockets.length, 1);
  release();
  await stopping;
});

test('reliability: renamed bridge waits for the same physical host release', async (t) => {
  quiet(t);
  let release;
  let deferStop = true;
  const calls = fakeBridge(t, { put: ({ body }) => ({ status: 200, body: { data: [] },
    ...(body.action === 'stop' && deferStop ? { defer: respond => { release = respond; } } : {}) }) });
  const sockets = fakeDtls(t);
  t.after(() => hue._reset());
  hue.configureBridges([{ ...PAIRED, host: 'Bridge.Invalid.' }]);
  hue.getSession(PAIRED.id).sendFrame(RED);
  await settle();
  sockets[0].emit('connected');
  hue.configureBridges([{ ...PAIRED, id: 'renamed', host: 'bridge.invalid' }]);
  hue.getSession('renamed').sendFrame(RED);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start', 'stop']);
  assert.strictEqual(sockets.length, 1);
  deferStop = false;
  release();
  await settle();
  assert.deepStrictEqual(actions(calls), ['start', 'stop', 'start']);
  assert.strictEqual(sockets.length, 2);
  await hue.stopAll();
});

test('reliability: a renamed bridge retries failed retirement after ownership recovers', async (t) => {
  quiet(t);
  let unreadable = false;
  const calls = fakeBridge(t, { area: () => unreadable
    ? { status: 503, body: { errors: [{ description: 'unavailable' }] } }
    : { status: 200, body: OURS } });
  const sockets = fakeDtls(t);
  t.after(() => hue._reset());
  hue.configureBridges([PAIRED]);
  hue.getSession(PAIRED.id).sendFrame(RED);
  await settle();
  sockets[0].emit('connected');
  unreadable = true;
  hue.configureBridges([{ ...PAIRED, id: 'renamed' }]);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start']);
  unreadable = false;
  hue.getSession('renamed').sendFrame(RED);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start', 'stop', 'start']);
  assert.strictEqual(sockets.length, 2);
  await hue.stopAll();
});

test('reliability: duplicate physical hosts cannot acquire two sessions', async (t) => {
  quiet(t);
  const calls = fakeBridge(t);
  const sockets = fakeDtls(t);
  t.after(() => hue._reset());
  hue.configureBridges([PAIRED, { ...PAIRED, id: 'duplicate' }]);
  hue.sendFrames(new Map([[PAIRED.id, RED], ['duplicate', RED]]));
  await settle();
  assert.deepStrictEqual(actions(calls), ['start']);
  assert.strictEqual(sockets.length, 1);
  assert.match(hue.getSession('duplicate').getStatus().error, /already managed/);
  await hue.stopAll();
});

for (const operation of ['stopAll', 'closeAll']) test(`reliability: ${operation} waits for retired sessions`, async (t) => {
  quiet(t);
  let release;
  fakeBridge(t, { put: ({ body }) => ({ status: 200, body: { data: [] },
    ...(body.action === 'stop' ? { defer: respond => { release = respond; } } : {}) }) });
  fakeDtls(t);
  t.after(() => hue._reset());
  hue.configureBridges([PAIRED]);
  hue.getSession(PAIRED.id).sendFrame(RED);
  await settle();
  hue.configureBridges([]);
  let complete = false;
  const stopping = hue[operation]().then(() => { complete = true; });
  await settle();
  assert.strictEqual(complete, false);
  release();
  await stopping;
});

test('reliability: an old send callback cannot fail a replacement socket', async (t) => {
  quiet(t);
  fakeBridge(t);
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await settle();
  sockets[0].emit('connected');
  let finish;
  sockets[0].send = (_frame, callback) => { finish = callback; };
  session.sendFrame(RED);
  await session.stop();
  await settle();
  session.sendFrame(RED);
  await settle();
  sockets[1].emit('connected');
  finish(new Error('old socket failure'));
  assert.strictEqual(session.getStatus().status, 'streaming');
  assert.strictEqual(sockets[1].closed, false);
  await session.stop();
});

test('reliability: delayed application identity never persists into a replacement config', async (t) => {
  quiet(t);
  let respond;
  const writes = [];
  fakeBridge(t, { area: () => ({ status: 200, body: {}, defer: reply => { respond = reply; } }) });
  const original = https.request;
  t.mock.method(https, 'request', (options, callback) => original(options, res => {
    res.headers = { 'hue-application-id': 'old-app' };
    callback(res);
  }));
  const session = new hue.HueSession({ ...PAIRED, applicationId: '' }, () => (...args) => { writes.push(args); });
  session.sendFrame(RED);
  await settle();
  session.configure({ host: 'replacement.invalid', username: 'new-key', applicationId: 'new-app' });
  respond();
  await settle();
  assert.deepStrictEqual(writes, []);
  assert.strictEqual(session.getConfig().applicationId, 'new-app');
  await session.stop();
});

test('reliability: an aborted REST response settles without an unhandled stream error', async (t) => {
  let response;
  t.mock.method(https, 'request', (_options, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = error => { if (error) req.emit('error', error); };
    req.end = () => {
      response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      onResponse(response);
      response.emit('data', Buffer.from('{'));
    };
    return req;
  });
  let settled = false;
  const lookup = hue.fetchApplicationId('bridge.invalid', 'dummy').then(value => { settled = true; return value; });
  response.emit('aborted');
  assert.doesNotThrow(() => response.emit('error', new Error('aborted')));
  await settle();
  assert.strictEqual(settled, true);
  assert.strictEqual(await lookup, null);
});

test('reliability: a stalled release times out and keeps replacement output blocked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const calls = fakeBridge(t, { put: ({ body }) => ({ status: 200, body: { data: [] },
    ...(body.action === 'stop' ? { defer: () => {} } : {}) }) });
  const sockets = fakeDtls(t, [10]);
  const session = new hue.HueSession(PAIRED);
  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'streaming', 100);
  const stopped = assert.rejects(session.stop(), /within 5000ms/);
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  await stopped;
  assert.strictEqual(session.getStatus().status, 'failed');
  session.sendFrame(RED);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start', 'stop']);
  assert.strictEqual(sockets.length, 1);
});
