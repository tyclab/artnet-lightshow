import test from 'node:test';
import assert from 'node:assert';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { dtls } from 'node-dtls-client';

import * as hue from '../../src/server/hue.ts';

// node-dtls-client sends each handshake flight once and never retransmits, so a
// single lost datagram stalls the handshake until its timer. Measured on the
// bridges, half the starts lost one and sat dark for 7 to 30 s of stop/start
// rounds while a good handshake takes under 200 ms.

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
      const call = { method: options.method, path: options.path, body: payload ? JSON.parse(payload) : undefined };
      calls.push(call);
      const reply = options.method === 'PUT' ? put(call) : area(call);
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = reply.status;
        res.headers = {};
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify(reply.body)));
        res.emit('end');
      });
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

test('a handshake lost on the first try is retried inside the open session', async (t) => {
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
  assert.deepStrictEqual(actions(calls), ['start'], 'one session for both tries, no stop/start between them');
  assert.ok(lines.some((l) => /timed out.*try 2 of 5/.test(l)), 'the lost try is logged');
  assert.strictEqual(session.sendFrame(RED), true, 'frames flow');
  await session.stop();
});

// Five tries of a second each cost what the one five-second try did before, so
// a bridge that answers nothing is no darker than it was.
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
  assert.deepStrictEqual(actions(calls), ['start', 'stop'], 'the session is closed once, after the last try');
  assert.strictEqual(session.sendFrame(RED), false);
  await settle();
  assert.strictEqual(sockets.length, 5, 'backing off: the next frame starts nothing');
});

// A disarm during backoff used to carry the doubled delay into the next arm,
// up to a minute dark on a bridge that had long recovered.
test('stop() resets the backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  const calls = fakeBridge(t, { put: () => ({ status: 503, body: { errors: [{ description: 'bridge busy' }] } }) });
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
  const held = { data: [{ id: AREA, status: 'active', active_streamer: { rid: 'sync-box-app', rtype: 'auth_v1' } }] };
  const calls = fakeBridge(t, { area: () => ({ status: 200, body: held }) });
  const sockets = fakeDtls(t);
  const session = new hue.HueSession(PAIRED);

  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'failed', 3000);

  assert.strictEqual(session.getStatus().status, 'failed');
  assert.match(session.getStatus().error, /held by sync-box-app/);
  assert.strictEqual(sockets.length, 0, 'no handshake against an area that is not ours');
  assert.deepStrictEqual(actions(calls), ['start'], 'no stop for a stream that is not ours');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path.endsWith(`/entertainment_configuration/${AREA}`)));
});

// An unreadable area must not cost the stream: the check is advisory.
test('an area that cannot be read does not block the handshake', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  quiet(t);
  fakeBridge(t, { area: () => ({ status: 500, body: { errors: [{ description: 'internal error' }] } }) });
  fakeDtls(t, [50]);
  const session = new hue.HueSession(PAIRED);

  session.sendFrame(RED);
  await until(t, () => session.getStatus().status === 'streaming', 1000);
  assert.strictEqual(session.getStatus().status, 'streaming');
  await session.stop();
});
