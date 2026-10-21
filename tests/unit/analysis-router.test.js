// The router between this machine's analyser and remote GPU workers, with
// both sides faked: which side gets a job, and what happens when one fails.

import test from 'node:test';
import assert from 'node:assert/strict';

import AnalysisRouter from '../../src/analysis-router.ts';
import { cancelledError, isCancelled } from '../../src/errors.ts';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** This machine's AnalyzerWorker: every call recorded, every job settled by the test. */
function fakeLocal() {
  const jobs = [];
  return {
    jobs,
    cancelled: [],
    analyze(source, target, options) {
      const job = { source, target, options, ...deferred() };
      jobs.push(job);
      return job.promise;
    },
    cancel(tag) {
      this.cancelled.push(tag);
      const open = jobs.filter((j) => j.options.tag === tag && !j.done);
      for (const job of open) { job.done = true; job.reject(cancelledError()); }
      return open.length > 0;
    },
    running(tag) { return jobs.find((j) => j.options.tag === tag && !j.done); },
    promote() {}, setQueueOrder() {}, pause() {}, resume() {}, restart() {}, prewarm() {}, shutdown() {},
  };
}

function remoteError(kind, message = kind) {
  return Object.assign(new Error(message), { remote: kind });
}

/** The pool of remote workers: `idle` says whether its one worker can take a job. */
function fakePool({ idle = true, compatible = true } = {}) {
  const pool = {
    idle, compatible, runs: [], listeners: [],
    eligible: (source) => typeof source === 'string' && !/^https?:/.test(source),
    idleWorker() { return this.compatible && this.idle ? 'gpu-1' : null; },
    hasCompatible() { return this.compatible; },
    run(worker, request) {
      this.idle = false;
      const run = { worker, request, cancelled: null, ...deferred() };
      run.handle = {
        id: `job-${this.runs.length}`, worker, tag: request.tag, priority: request.priority, result: run.promise,
        cancel: (reason) => { run.cancelled = reason; run.reject(remoteError('cancelled', reason)); },
      };
      this.runs.push(run);
      return run.handle;
    },
    onChange(fn) { this.listeners.push(fn); },
    free() { this.idle = true; for (const fn of this.listeners) fn(); },
  };
  return pool;
}

function router(pool, { waitMs = 60_000 } = {}) {
  const local = fakeLocal();
  const r = new AnalysisRouter(local, { waitForRemoteMs: () => waitMs });
  if (pool) r.attachRemote(pool);
  return { r, local };
}

test('without a remote worker every analysis runs on this machine', async () => {
  const { r, local } = router(null);
  const done = r.analyze('/music/a.wav', 200, { priority: 'normal', tag: 'a', queuePos: 2 });
  assert.equal(local.jobs.length, 1);
  assert.deepEqual(local.jobs[0].options, { priority: 'normal', tag: 'a', queuePos: 2 });
  assert.equal(local.jobs[0].target, 200);
  local.jobs[0].resolve({ bpm: 120 });
  assert.deepEqual(await done, { bpm: 120 });
});

test('an idle GPU worker takes the analysis and this machine stays idle', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'current', tag: 'a' });
  assert.equal(pool.runs.length, 1);
  assert.equal(local.jobs.length, 0);
  assert.deepEqual(pool.runs[0].request, { source: '/music/a.wav', targetDurationSec: null, priority: 'current', tag: 'a' });
  pool.runs[0].resolve({ bpm: 128, by: 'gpu' });
  assert.deepEqual(await done, { bpm: 128, by: 'gpu' });
});

test('the playing track starts here at once when the worker is busy, and the worker joins it when free', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  assert.equal(local.jobs.length, 1, 'no wait for the GPU on the playing track');
  pool.free();
  assert.equal(pool.runs.length, 1, 'the freed worker runs the same track beside this machine');
  pool.runs[0].resolve({ by: 'gpu' });
  assert.deepEqual(await done, { by: 'gpu' });
  await tick();
  assert.deepEqual(local.cancelled, ['now'], 'the slower copy here is called off');
});

test('when this machine finishes first the copy on the worker is called off', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  pool.free();
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
  assert.ok(pool.runs[0].cancelled);
});

test('a prefetch waits for a busy worker, and runs here once the wait is over', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool, { waitMs: 40 });
  const done = r.analyze('/music/next.wav', null, { priority: 'normal', tag: 'next' });
  assert.equal(local.jobs.length, 0);
  await tick(80);
  assert.equal(local.jobs.length, 1);
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
});

test('a prefetch the freed worker picks up within the wait never runs here', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool, { waitMs: 5_000 });
  const done = r.analyze('/music/next.wav', null, { priority: 'normal', tag: 'next' });
  pool.free();
  assert.equal(pool.runs.length, 1);
  pool.runs[0].resolve({ by: 'gpu' });
  assert.deepEqual(await done, { by: 'gpu' });
  assert.equal(local.jobs.length, 0);
});

test('with no compatible worker a prefetch runs here at once', () => {
  const pool = fakePool({ compatible: false });
  const { r, local } = router(pool);
  r.analyze('/music/next.wav', null, { priority: 'normal', tag: 'next' });
  assert.equal(local.jobs.length, 1);
});

test('a job a worker fails or drops comes back to this machine', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  pool.runs[0].reject(remoteError('failed', 'gamertyc disconnected'));
  await tick();
  assert.equal(local.jobs.length, 1, 'requeued here, without waiting for the worker again');
  pool.free();
  assert.equal(pool.runs.length, 1, 'not offered to a worker a second time');
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
});

test('a declined offer goes to this machine when no worker is left to take it', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  pool.compatible = false;
  pool.runs[0].reject(remoteError('declined', 'a game is running'));
  await tick();
  assert.equal(local.jobs.length, 1);
});

test('the playing track takes the worker from a prefetch, which goes back in the queue', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  const prefetch = r.analyze('/music/later.wav', null, { priority: 'normal', tag: 'later' });
  const current = r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  assert.ok(pool.runs[0].cancelled, 'the prefetch on the worker is stopped');
  assert.equal(local.jobs.length, 1);
  assert.equal(local.jobs[0].options.tag, 'now', 'the playing track starts here meanwhile');
  pool.free();
  assert.equal(pool.runs[1].request.tag, 'now', 'the worker runs the playing track first');
  pool.runs[1].resolve({ track: 'now' });
  assert.deepEqual(await current, { track: 'now' });
  await tick();
  pool.free();
  assert.equal(pool.runs[2].request.tag, 'later', 'then the prefetch again');
  pool.runs[2].resolve({ track: 'later' });
  assert.deepEqual(await prefetch, { track: 'later' });
});

test('a new playing track supersedes the old one on the worker', async () => {
  const pool = fakePool();
  const { r } = router(pool);
  const old = r.analyze('/music/old.wav', null, { priority: 'current', tag: 'old' });
  r.analyze('/music/new.wav', null, { priority: 'current', tag: 'new' });
  await assert.rejects(old, (err) => err.superseded === true);
  assert.ok(pool.runs[0].cancelled);
});

test('the playing track preempts a prefetch running here', async () => {
  const { r, local } = router(null);
  const prefetch = r.analyze('/music/later.wav', null, { priority: 'normal', tag: 'later' });
  r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  assert.deepEqual(local.cancelled, ['later']);
  assert.equal(local.jobs[1].options.tag, 'now');
  local.jobs[1].resolve({});
  await tick();
  assert.equal(local.jobs[2].options.tag, 'later', 'the prefetch resumes after the playing track');
  local.jobs[2].resolve({ track: 'later' });
  assert.deepEqual(await prefetch, { track: 'later' });
});

test('cancel reaches queued, local and remote work', async () => {
  const pool = fakePool();
  const { r, local } = router(pool, { waitMs: 60_000 });
  const remote = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  const here = r.analyze('http://example.invalid/b.mp3', null, { priority: 'normal', tag: 'b' });
  const queued = r.analyze('/music/c.wav', null, { priority: 'normal', tag: 'c' });
  assert.equal(r.cancel('c'), true);
  await assert.rejects(queued, isCancelled);
  assert.equal(r.cancel('a'), true);
  await assert.rejects(remote, isCancelled);
  assert.ok(pool.runs[0].cancelled);
  assert.equal(r.cancel('b'), true);
  await assert.rejects(here, isCancelled);
  assert.deepEqual(local.cancelled, ['b']);
  assert.equal(r.cancel('nothing'), false);
});

test('a link is analysed here: the worker only receives files this server holds', () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  r.analyze('https://example.invalid/a.mp3', null, { priority: 'current', tag: 'url' });
  assert.equal(pool.runs.length, 0);
  assert.equal(local.jobs.length, 1);
});

test('promoting a prefetch that runs here lets a freed worker race it', async () => {
  const pool = fakePool({ compatible: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  assert.equal(local.jobs.length, 1);
  pool.compatible = true;
  r.promote('a', 'current');
  pool.free();
  assert.equal(pool.runs.length, 1);
  assert.equal(pool.runs[0].request.priority, 'current');
  pool.runs[0].resolve({ by: 'gpu' });
  assert.deepEqual(await done, { by: 'gpu' });
});

test('shutdown fails what is queued and stops the remote work', async () => {
  const pool = fakePool({ idle: false });
  const { r } = router(pool, { waitMs: 60_000 });
  const queued = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  r.shutdown();
  await assert.rejects(queued, /shutting down/);
  await assert.rejects(r.analyze('/music/b.wav', null), /shutting down/);
});
