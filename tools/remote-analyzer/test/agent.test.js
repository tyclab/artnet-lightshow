// The agent against the server's real worker pool: the protocol both ends speak, with the GPU, the desktop
// and the analysis container faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { Agent, validOffer } from '../agent.js';
import { HTTP_BASE, RemoteAnalysisPool } from '../../../src/remote-analysis.ts';

const TOKEN = 'worker-token-for-the-test';
const VERSION = '2.2+0123456789abcdef';
const MODELS = ['beat_this', 'htdemucs'];
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function harness(t, { answer = (job) => ({ result: { schemaVersion: '2.2', bytes: job.bytes, env: job.env } }), usedMiB = 2300 } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const pool = new RemoteAnalysisPool({ token: () => TOKEN, version: VERSION, serverModels: async () => MODELS, offerTimeoutMs: 2000 });
  pool.attach(io);
  app.use(HTTP_BASE, pool.httpRouter());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agent-'));
  const music = path.join(dataDir, 'track.mp3');
  fs.writeFileSync(music, Buffer.alloc(3000, 1));

  const state = { usedMiB, reading: null, procs: [], holds: [] };
  const runtime = {
    prepare: async (version) => ({ version, models: MODELS, codeDir: '/code', venv: '/venv', pythonDir: '/python', image: 'image' }),
    startProcess(prepared, env) {
      const proc = {
        env, exited: false, stopped: 0, pending: null, ready: Promise.resolve(),
        request(source, targetDurationSec) {
          const file = path.join(dataDir, 'jobs', path.basename(source));
          const job = { bytes: fs.statSync(file).size, env, targetDurationSec };
          return new Promise((resolve, reject) => {
            proc.pending = { resolve, reject };
            const reply = answer(job);
            if (reply) resolve({ id: 1, ...reply });
          });
        },
        async stop() { proc.stopped++; proc.exited = true; proc.pending?.reject(new Error('stopped')); },
      };
      state.procs.push(proc);
      return proc;
    },
  };
  const hold = { held: 0, acquire() { this.held++; state.holds.push('on'); }, release() { if (this.held) { this.held--; state.holds.push('off'); } } };
  const config = {
    server: { origin, base: origin, socketPath: '/socket.io' }, token: TOKEN, name: 'gamertyc', dataDir,
    gpuMemory: 'auto', maxOtherVramMiB: 3072, allowFullscreen: ['chrome'], idleStopMin: 15,
  };
  const logs = [];
  const agent = new Agent(config, {
    runtime, hold, tickMs: 50, log: (line) => logs.push(line),
    gpu: async () => ({ ok: true, name: 'RTX', totalMiB: 8192, usedMiB: state.usedMiB }),
    desktop: { run() {}, stop() {}, latest: () => state.reading },
  });
  agent.start();
  t.after(async () => {
    await agent.stop();
    pool.shutdown();
    await new Promise((resolve) => io.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const request = { source: music, targetDurationSec: null, priority: 'current', tag: 'file:track' };
  return { pool, agent, state, logs, request, dataDir };
}

test('the agent prepares the server\'s analysis, then analyses a job end to end', async (t) => {
  const h = await harness(t);
  await until(() => h.pool.idleWorker());
  const worker = h.pool.status().workers[0];
  assert.deepEqual([worker.name, worker.version, worker.compatible, worker.device.kind], ['gamertyc', VERSION, true, 'cuda']);
  const handle = h.pool.run(h.pool.idleWorker(), h.request);
  const document = await handle.result;
  assert.equal(document.bytes, 3000, 'the audio arrived whole');
  assert.deepEqual(document.env, { ARTNET_USE_BS_ROFORMER: '0', ARTNET_STRUCTURE_MODEL: 'auto', ARTNET_GPU_MEMORY: 'auto' });
  await until(() => h.state.holds.length === 2);
  assert.deepEqual(h.state.holds, ['on', 'off'], 'Windows is kept awake for the job only');
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'jobs')), [], 'the audio is deleted afterwards');
  assert.equal(h.pool.status().recent[0].outcome, 'done');
});

test('a fullscreen game or a full GPU makes the agent decline; the party browser does not', async (t) => {
  const h = await harness(t);
  await until(() => h.pool.idleWorker());
  h.state.reading = { state: 5, fullscreen: true, app: 'chrome' };
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(h.pool.idleWorker(), 'the visuals browser fullscreen leaves the GPU to us');
  h.state.reading = { state: 5, fullscreen: true, app: 'Cyberpunk2077' };
  await until(() => !h.pool.idleWorker());
  assert.match(h.pool.status().workers[0].reason, /fullscreen program is in front \(cyberpunk2077\)/);
  assert.equal(h.pool.hasCompatible(), false);
  h.state.reading = null;
  await until(() => h.pool.idleWorker());
  h.state.usedMiB = 6000;
  await until(() => !h.pool.idleWorker());
  assert.match(h.pool.status().workers[0].reason, /6000 MiB/);
});

test('a game that comes to the front gives the running job back as yielded', async (t) => {
  const h = await harness(t, { answer: () => null });
  await until(() => h.pool.idleWorker());
  const handle = h.pool.run(h.pool.idleWorker(), h.request);
  const failed = assert.rejects(handle.result, (err) => err.remote === 'failed' && /fullscreen program came to the front/.test(err.message));
  await until(() => h.state.procs.length === 1 && h.state.procs[0].pending);
  h.state.reading = { state: 3, fullscreen: true, app: 'game' };
  await failed;
  assert.equal(h.pool.status().recent[0].outcome, 'yielded');
  assert.equal(h.state.procs[0].stopped, 1, 'the container is stopped to free the GPU');
});

test('a cancel from the server stops the container, and the worker is offered work again after', async (t) => {
  const h = await harness(t, { answer: () => null });
  await until(() => h.pool.idleWorker());
  const handle = h.pool.run(h.pool.idleWorker(), h.request);
  await until(() => h.state.procs[0]?.pending);
  handle.cancel('superseded');
  await assert.rejects(handle.result, (err) => err.remote === 'cancelled');
  await until(() => h.state.procs[0].stopped === 1);
  await until(() => h.pool.idleWorker());
  assert.deepEqual(h.state.holds, ['on', 'off']);
});

test('an error in the analyser goes back to the server as a failure', async (t) => {
  const h = await harness(t, { answer: () => ({ error: 'File not found' }) });
  await until(() => h.pool.idleWorker());
  const handle = h.pool.run(h.pool.idleWorker(), h.request);
  await assert.rejects(handle.result, (err) => err.remote === 'failed' && /File not found/.test(err.message));
});

test('only a well-formed offer is taken', () => {
  const offer = { id: '0b8c1a9e-2f2e-4a51-9a3d-5f6c7d8e9f00', key: 'k'.repeat(32), version: VERSION, ext: '.mp3', bytes: 10,
    targetDurationSec: null, priority: 'current', settings: { separator: 'demucs', structureModel: 'auto' } };
  assert.equal(validOffer(offer), true);
  for (const bad of [{ ext: '/../x' }, { id: '../../etc' }, { bytes: 0 }, { settings: { separator: 'rm -rf', structureModel: 'auto' } }, { key: 'short' }]) {
    assert.equal(validOffer({ ...offer, ...bad }), false);
  }
});
