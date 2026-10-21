// The remote worker pool against a real Socket.IO server and HTTP routes,
// with a socket.io-client standing in for the GPU worker.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { createAuth } from '../../src/server/auth.ts';
import { HTTP_BASE, NAMESPACE, RemoteAnalysisPool } from '../../src/remote-analysis.ts';
import { durationOf, storedTimeoutMs } from '../../src/analyzer-worker.ts';
import AnalysisRouter from '../../src/analysis-router.ts';
import { flacFile, mp3File } from '../helpers/audio-headers.js';

const MAIN_TOKEN = 'main-token-for-the-ui';
const WORKER_TOKEN = 'worker-token-for-analysis';
const VERSION = '2.2+0123456789abcdef';

async function harness(t, { token = WORKER_TOKEN, models = ['beat_this', 'htdemucs'], timeoutMs = 60_000, offerTimeoutMs = 2000 } = {}) {
  const app = express();
  const server = http.createServer(app);
  const auth = createAuth({ token: MAIN_TOKEN });
  const io = new Server(server, { allowRequest: auth.allowSocketRequest });
  io.use(auth.socketMiddleware);
  const state = { token, models };
  const pool = new RemoteAnalysisPool({
    token: () => state.token, version: VERSION, serverModels: async () => state.models,
    timeoutMs: () => timeoutMs, offerTimeoutMs,
    jobSettings: () => ({ separator: 'demucs', structureModel: 'auto' }),
  });
  pool.attach(io);
  app.use(HTTP_BASE, pool.httpRouter());
  app.use('/api', auth.httpMiddleware);
  pool.attachStatusRoute(app);
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-analysis-'));
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.close();
    pool.shutdown();
    await new Promise((resolve) => io.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const audio = (name, bytes = 4096) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(bytes, 7));
    return file;
  };
  const worker = (opts = {}) => new Promise((resolve, reject) => {
    const socket = connect(`${base}${NAMESPACE}`, {
      transports: ['websocket'], reconnection: false, forceNew: true, timeout: 2000,
      auth: { token: opts.token ?? WORKER_TOKEN },
    });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
  const hello = (socket, extra = {}) => socket.timeout(3000).emitWithAck('hello', {
    protocol: 1, name: 'gamertyc', version: VERSION, models: ['htdemucs', 'beat_this'],
    device: { kind: 'cuda', name: 'NVIDIA GeForce RTX 2080 SUPER', vramMiB: 8192 }, available: true, ...extra,
  });
  const once = (socket, event) => new Promise((resolve) => socket.once(event, (...args) => resolve(args)));
  return { pool, base, state, audio, worker, hello, once };
}

const workerHeaders = (key) => ({ 'X-Lightshow-Worker-Token': WORKER_TOKEN, ...(key ? { 'X-Lightshow-Job-Key': key } : {}) });

async function postResult(base, offer, body, { gzip = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  return fetch(`${base}${HTTP_BASE}/jobs/${offer.id}/result`, {
    method: 'POST', body: gzip ? zlib.gzipSync(raw) : raw,
    headers: { ...workerHeaders(offer.key), 'Content-Type': 'application/json', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) },
  });
}

test('a worker needs the worker token: the UI token, no token and a blank setting are refused', async (t) => {
  const h = await harness(t);
  await assert.rejects(h.worker({ token: MAIN_TOKEN }), /Worker token refused/);
  await assert.rejects(h.worker({ token: '' }), /requires a worker token/);
  h.state.token = '';
  await assert.rejects(h.worker(), /no worker token is set/);
  h.state.token = WORKER_TOKEN;
  assert.ok((await h.worker()).connected);
  const api = await fetch(`${h.base}/api/ping`, { headers: workerHeaders() });
  assert.equal(api.status, 401, 'the worker token opens nothing outside the worker routes');
});

test('hello answers whether the worker runs this server\'s analysis code and models', async (t) => {
  const h = await harness(t);
  const same = await h.hello(await h.worker());
  assert.equal(same.compatible, true);
  assert.equal(same.version, VERSION);
  assert.deepEqual(same.settings, { separator: 'demucs', structureModel: 'auto' });
  assert.equal(h.pool.idleWorker() !== null, true);

  const older = await h.hello(await h.worker(), { name: 'old-pc', version: '2.2+ffffffffffffffff' });
  assert.equal(older.compatible, false);
  assert.match(older.reason, /analysis code/);

  const fewer = await h.hello(await h.worker(), { name: 'thin-pc', models: ['beat_this', 'panns'] });
  assert.equal(fewer.compatible, false);
  assert.match(fewer.reason, /lacks htdemucs and has panns/);

  const gpu = await h.hello(await h.worker(), { name: 'gpu-pc', models: ['beat_this', 'htdemucs', 'songformer'] });
  assert.equal(gpu.compatible, true, 'SongFormer is what structure "auto" uses on a GPU');

  const listed = h.pool.status().workers.map((w) => [w.name, w.compatible]);
  assert.deepEqual(listed.sort(), [['gamertyc', true], ['gpu-pc', true], ['old-pc', false], ['thin-pc', false]]);
});

test('a job goes to the worker, which fetches the audio with its key and posts the document back', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const file = h.audio('track.flac', 5000);
  const offered = h.once(socket, 'job');
  const handle = h.pool.run(h.pool.idleWorker(), { source: file, targetDurationSec: null, priority: 'current', tag: 'file:track' });
  const [offer, ack] = await offered;
  assert.equal(offer.ext, '.flac');
  assert.equal(offer.bytes, 5000);
  assert.equal(offer.version, VERSION);
  assert.equal(offer.priority, 'current');
  assert.equal('source' in offer, false, 'the server\'s paths stay on the server');
  ack({ accepted: true });

  const audio = await fetch(`${h.base}${HTTP_BASE}/jobs/${offer.id}/audio`, { headers: workerHeaders(offer.key) });
  assert.equal(audio.status, 200);
  assert.equal((await audio.arrayBuffer()).byteLength, 5000);
  assert.equal(h.pool.idleWorker(), null, 'busy while the job runs');

  const posted = await postResult(h.base, offer, { version: VERSION, result: { schemaVersion: '2.2', bpm: 128 }, seconds: 41.2 }, { gzip: true });
  assert.equal(posted.status, 200);
  assert.deepEqual(await handle.result, { schemaVersion: '2.2', bpm: 128 });
  assert.notEqual(h.pool.idleWorker(), null, 'free for the next job at once');

  const status = await (await fetch(`${h.base}/api/analysis/workers`, { headers: { 'X-Lightshow-Token': MAIN_TOKEN } })).json();
  assert.equal(status.workers[0].stats.jobs, 1);
  assert.deepEqual([status.recent[0].worker, status.recent[0].outcome, status.recent[0].file, status.recent[0].tag],
    ['gamertyc', 'done', 'track.flac', 'file:track']);
  assert.equal(status.recent[0].workerSeconds, 41.2);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${offer.key}|${WORKER_TOKEN}|${h.base.split('//')[1]}/|${path.dirname(file)}`));
});

test('the job routes refuse a wrong key, another job\'s key, the UI token and an ended job', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const offered = h.once(socket, 'job');
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  const [offer, ack] = await offered;
  ack({ accepted: true });
  const get = (id, headers) => fetch(`${h.base}${HTTP_BASE}/jobs/${id}/audio`, { headers });
  assert.equal((await get(offer.id, workerHeaders('wrong'))).status, 404);
  assert.equal((await get('not-a-job', workerHeaders(offer.key))).status, 404);
  assert.equal((await get(offer.id, { 'X-Lightshow-Token': MAIN_TOKEN, 'X-Lightshow-Job-Key': offer.key })).status, 401);
  handle.cancel('test');
  await assert.rejects(handle.result, (err) => err.remote === 'cancelled');
  assert.equal((await get(offer.id, workerHeaders(offer.key))).status, 404);
});

test('a result from other analysis code is refused and the job fails over', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const offered = h.once(socket, 'job');
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  const [offer, ack] = await offered;
  ack({ accepted: true });
  const failed = assert.rejects(handle.result, (err) => err.remote === 'failed');
  const posted = await postResult(h.base, offer, { version: '2.2+ffffffffffffffff', result: { schemaVersion: '2.2' } });
  assert.equal(posted.status, 409);
  await failed;
  assert.equal(h.pool.status().workers[0].compatible, false);
});

test('an error the worker reports fails the job over to this machine', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const offered = h.once(socket, 'job');
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  const [offer, ack] = await offered;
  ack({ accepted: true });
  const failed = assert.rejects(handle.result, (err) => err.remote === 'failed' && /CUDA out of memory/.test(err.message));
  assert.equal((await postResult(h.base, offer, { version: VERSION, error: 'CUDA out of memory', recycle: true })).status, 200);
  await failed;
  assert.equal(h.pool.idleWorker(), null, 'not offered more work until it says it is ready');
  socket.emit('status', { available: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notEqual(h.pool.idleWorker(), null);
});

test('a worker that drops mid-job fails it over', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const offered = h.once(socket, 'job');
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  const [, ack] = await offered;
  ack({ accepted: true });
  socket.close();
  await assert.rejects(handle.result, (err) => err.remote === 'failed' && /disconnected/.test(err.message));
  assert.equal(h.pool.status().workers.length, 0);
});

test('a declined offer is not a failure, and the worker gets no more until it is ready', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const offered = h.once(socket, 'job');
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  const [, ack] = await offered;
  ack({ accepted: false, reason: 'a fullscreen game is running' });
  await assert.rejects(handle.result, (err) => err.remote === 'declined');
  assert.equal(h.pool.idleWorker(), null);
  assert.equal(h.pool.hasCompatible(), false, 'no prefetch waits for a worker that is not taking work');
  assert.equal(h.pool.status().workers[0].reason, 'a fullscreen game is running');
});

test('a worker that does not answer the offer is passed over', async (t) => {
  const h = await harness(t, { offerTimeoutMs: 150 });
  const socket = await h.worker();
  await h.hello(socket);
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  await assert.rejects(handle.result, (err) => err.remote === 'declined');
});

test('a job past the analysis timeout is called off on the worker', async (t) => {
  const h = await harness(t, { timeoutMs: 150 });
  const socket = await h.worker();
  await h.hello(socket);
  const offered = h.once(socket, 'job');
  const cancelled = h.once(socket, 'cancel');
  const handle = h.pool.run(h.pool.idleWorker(), { source: h.audio('a.mp3'), targetDurationSec: null, priority: 'normal', tag: 'a' });
  const [offer, ack] = await offered;
  ack({ accepted: true });
  await assert.rejects(handle.result, (err) => err.remote === 'failed' && /timed out/.test(err.message));
  const [message] = await cancelled;
  assert.equal(message.id, offer.id);
});

test('a second connection under one name replaces the first', async (t) => {
  const h = await harness(t);
  const first = await h.worker();
  await h.hello(first);
  const gone = h.once(first, 'disconnect');
  await h.hello(await h.worker());
  await gone;
  assert.equal(h.pool.status().workers.length, 1);
});

test('the server re-checks connected workers when its models change', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const told = h.once(socket, 'server');
  h.state.models = ['beat_this', 'htdemucs', 'muq'];
  await h.pool.refreshModels();
  const [message] = await told;
  assert.equal(message.compatible, false);
  assert.match(message.reason, /lacks muq/);
  assert.equal(h.pool.idleWorker(), null);
});

test('with the router: a track a worker dropped mid-job is finished here, and the next one goes to a new worker', async (t) => {
  const h = await harness(t);
  const socket = await h.worker();
  await h.hello(socket);
  const local = [];
  const router = new AnalysisRouter({
    analyze: (source, target, options) => new Promise((resolve) => local.push({ source, options, resolve })),
    cancel: () => true, promote() {}, setQueueOrder() {}, pause() {}, resume() {}, restart() {}, prewarm() {}, shutdown() {},
  }, { waitForRemoteMs: () => 60_000 });
  router.attachRemote(h.pool);
  const offered = h.once(socket, 'job');
  const done = router.analyze(h.audio('now.flac'), null, { priority: 'current', tag: 'now' });
  const [, ack] = await offered;
  ack({ accepted: true });
  assert.equal(local.length, 0, 'the idle worker took it');
  socket.close();
  await until(() => local.length === 1);
  const fresh = await h.worker();
  await h.hello(fresh, { name: 'gamertyc-2' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.pool.status().recent.length, 1, 'a job a worker dropped is not sent to a worker again');
  local[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });

  const offeredAgain = h.once(fresh, 'job');
  const next = router.analyze(h.audio('next.flac'), null, { priority: 'normal', tag: 'next' });
  const [offer, ack2] = await offeredAgain;
  ack2({ accepted: true });
  await postResult(h.base, offer, { version: VERSION, result: { schemaVersion: '2.2', by: 'gpu' } });
  assert.deepEqual(await next, { schemaVersion: '2.2', by: 'gpu' });
});

const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timed out');
};

test('a worker gets the local analyser\'s limit for the request, which grows with the track', (t) => {
  const pool = new RemoteAnalysisPool({ token: () => '', version: VERSION, serverModels: async () => [] });
  const short = { source: '/music/a.mp3', targetDurationSec: 30, priority: 'normal', tag: null };
  const long = { ...short, targetDurationSec: 900 };
  assert.equal(pool._timeoutMs(long), storedTimeoutMs(durationOf(long)));
  assert.ok(pool._timeoutMs(long) > pool._timeoutMs(short), 'no fixed limit of its own');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, 'a.wav');
  fs.writeFileSync(wav, wavHeader(8000 * 600));
  fs.truncateSync(wav, 44 + 8000 * 600);
  assert.equal(pool._timeoutMs({ ...short, source: wav }), storedTimeoutMs(600), 'a WAV header gives the length');
  assert.equal(pool._timeoutMs({ ...short, source: flacFile(561), targetDurationSec: null }), storedTimeoutMs(561), 'so does a FLAC');
  assert.equal(pool._timeoutMs({ ...short, source: mp3File(561), targetDurationSec: null }), storedTimeoutMs(561), 'and an MP3');
});

function wavHeader(dataBytes) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

test('only an absolute path to a file on this server is sent to a worker', () => {
  const pool = new RemoteAnalysisPool({ token: () => '', version: VERSION, serverModels: async () => [] });
  assert.equal(pool.eligible('/music/a.flac'), true);
  assert.equal(pool.eligible('https://example.invalid/a.mp3'), false);
  assert.equal(pool.eligible('relative/a.mp3'), false);
  assert.equal(pool.eligible(null), false);
});
