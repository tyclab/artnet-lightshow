// How the server is doing (src/server/health.ts, src/server/supervised.ts):
// what counts as wrong and how it is said, what the supervisor tells the
// server, the heartbeat, and the two routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { assess, health, performanceSample, startHealthMonitor, loopDelayOf, LOOP_RESOLUTION_MS } from '../../src/server/health.ts';
import { buffer } from '../../src/server/log.ts';
import { supervision, startHeartbeat, EXIT_RESTART, EXIT_CONFIG } from '../../src/server/supervised.ts';
import { attachRoutes } from '../../src/server/routes.ts';

const fine = {
  engine: { running: true, fellBack: false, frames: 1000, lateFrames: 3 },
  eventLoop: { p50Ms: 10, p99Ms: 20, maxMs: 30 },
  rssMb: 300,
  errors: { count: 0, last: null },
  supervisor: { supervised: true, restarts: 0, lastExit: null, recovering: false },
  auto: { status: 'ready', error: null },
};

test('a server doing well is ok, with nothing to say', () => {
  assert.deepEqual(assess(fine), { status: 'ok', problems: [] });
});

for (const [name, patch, status, levels] of [
  ['late frames', { engine: { ...fine.engine, lateFrames: 120 } }, 'degraded', ['warn']],
  ['stalled event loop', { eventLoop: { p50Ms: 10, p99Ms: 250, maxMs: 900 } }, 'degraded', ['warn']],
  ['recent errors', { errors: { count: 2, last: { component: 'hue', msg: 'bridge gone\nstack…' } } }, 'degraded', ['warn']],
  ['successful restart', { supervisor: { ...fine.supervisor, restarts: 1, lastExit: { reason: 'stopped responding' } } }, 'ok', ['info']],
  ['stopped engine and high memory', { engine: { running: false }, rssMb: 2000 }, 'failing', ['error', 'warn']],
]) {
  test(`health classifies ${name}`, () => {
    const result = assess({ ...fine, ...patch });
    assert.equal(result.status, status);
    assert.deepEqual(result.problems.map((p) => p.level), levels);
    assert.ok(result.problems.every((p) => p.what.length > 0));
    assert.ok(result.problems.every((p) => !p.what.includes('\n')));
  });
}

test('what the supervisor tells the server, read from its environment', () => {
  assert.deepEqual(supervision({}), { supervised: false, restarts: 0, lastExit: null, recovering: false });
  const lastExit = { code: 1, signal: null, reason: 'crashed with exit code 1', at: '2026-09-25T00:00:00.000Z' };
  assert.deepEqual(supervision({
    LIGHTSHOW_SUPERVISED: '1', LIGHTSHOW_RESTARTS: '2', LIGHTSHOW_LAST_EXIT: JSON.stringify(lastExit), LIGHTSHOW_RECOVER: '1',
  }), { supervised: true, restarts: 2, lastExit, recovering: true });
  assert.equal(supervision({ LIGHTSHOW_LAST_EXIT: '{not json' }).lastExit, null);
  assert.deepEqual([EXIT_RESTART, EXIT_CONFIG], [75, 78]);
});

test('the heartbeat stops sending after teardown', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = [];
  const stop = startHeartbeat((m) => sent.push(m.type), 1000);
  t.mock.timers.tick(3000);
  stop();
  t.mock.timers.tick(3000);
  assert.deepEqual(sent, ['ready', 'heartbeat', 'heartbeat', 'heartbeat']);
});

test('event-loop delay is what the loop added to the sampling timer', () => {
  const ms = 1e6;
  const histogram = (p50, p99, max) => ({ count: 100, percentile: (p) => (p === 50 ? p50 : p99) * ms, max: max * ms });
  assert.equal(LOOP_RESOLUTION_MS, 10);
  assert.deepEqual(loopDelayOf(histogram(10.3, 14, 57)), { p50Ms: 0.3, p99Ms: 4, maxMs: 47 });
  assert.deepEqual(loopDelayOf(histogram(9.77, 10.89, 10.89)), { p50Ms: 0, p99Ms: 0.9, maxMs: 0.9 }, 'an idle loop reads nothing, never less');
  assert.equal(loopDelayOf({ count: 0, percentile: () => 0, max: 0 }), null);
});

test('heartbeat teardown works without a supervisor', () => {
  assert.doesNotThrow(() => startHeartbeat(undefined)());
});

const timing = {
  thread: 'worker', running: true, rate: 44, fellBack: null,
  commands: { submitted: 0, processed: 0, applied: 0 },
  startedAtMs: 100, sampledAtMs: 1000, totalFrames: 40,
  frames: 40, lateFrames: 1, skippedFramesTotal: 2, skippedFramesLastMinute: 2,
  renderMs: { p50: 1, p95: 2, max: 5 }, lateMs: { p50: 0, p95: 3, max: 10 },
};
const memory = { rss: 1024, heapUsed: 512 };
const sample = (engine, previous = null, now = 31_010) => performanceSample(engine, fine.eventLoop, memory, false, previous, now);

test('performance summaries measure elapsed throughput without leaking health details', (t) => {
  t.mock.method(Date, 'now', () => -1_000_000);
  const next = { ...timing, sampledAtMs: 31_000, totalFrames: 1240, frames: 1000, lateFrames: 20, skippedFramesTotal: 122, skippedFramesLastMinute: 3,
    fellBack: 'private diagnostic', host: 'private host', token: 'private token' };
  const s = sample(next, timing);
  assert.equal(s.actualFps, 40, 'measured throughput differs from the configured target');
  assert.equal(s.targetFps, 44);
  assert.equal(s.intervalMs, 30_000);
  assert.equal(s.intervalSkipped, 120);
  assert.equal(s.skippedFramesTotal, 122);
  assert.ok(!('skippedFrames' in s));
  assert.equal(s.windowFrames, 1000);
  assert.equal(s.lateFrames, 20);
  assert.equal(s.engineSampleAgeMs, 10);
  assert.equal(s.engineFallback, true);
  assert.equal(s.renderP95Ms, 2);
  assert.equal(s.eventLoopP99Ms, 20);
  assert.equal(s.rssBytes, 1024);
  assert.equal(s.armed, false);
  assert.ok(!JSON.stringify(s).includes('private'));
  assert.ok(Object.values(s).every((value) => value === null || ['boolean', 'number', 'string'].includes(typeof value)));
});

test('performance deltas reject startup, restart, fallback and stale or reset counters', () => {
  const next = { ...timing, sampledAtMs: 31_000, totalFrames: 1240, skippedFramesTotal: 10 };
  assert.equal(sample(next).actualFps, null);
  for (const patch of [
    { startedAtMs: 2000 }, { thread: 'main' }, { running: false },
    { sampledAtMs: timing.sampledAtMs }, { sampledAtMs: -100 },
    { totalFrames: 0 }, { skippedFramesTotal: 0 }, { startedAtMs: undefined },
  ]) {
    const s = sample({ ...next, ...patch }, timing);
    assert.equal(s.actualFps, null, JSON.stringify(patch));
    assert.equal(s.intervalSkipped, null);
    assert.equal(s.intervalMs, null);
  }
  assert.equal(sample(timing, timing).engineSampleAgeMs, 30_010, 'stale worker reports remain visible');
  assert.equal(sample({ ...timing, frames: undefined, renderMs: undefined }).renderMaxMs, null);
});

test('one existing health timer emits bounded summaries and survives collection failure', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const since = buffer.last;
  const summaries = () => buffer.since(since).filter((entry) => entry.component === 'performance');
  startHealthMonitor();
  startHealthMonitor();
  t.mock.timers.tick(29_999);
  assert.equal(summaries().length, 0);
  t.mock.timers.tick(1);
  assert.equal(summaries().length, 1);
  const usage = t.mock.method(process, 'memoryUsage', () => { throw new Error('collection failed'); });
  assert.doesNotThrow(() => t.mock.timers.tick(30_000));
  usage.mock.restore();
  t.mock.timers.tick(30_000);
  assert.equal(summaries().length, 2);
  assert.equal(summaries()[1].data.engineRunning, false);
  assert.equal(summaries()[1].data.actualFps, null);
  assert.ok(JSON.stringify(summaries()[1]).length < 1500);
});

test('health routes expose liveness and detailed status', async (t) => {
  const app = express();
  attachRoutes(app, { integrations: { broadcast() {} }, autoShow: { status: 'idle', running: false, error: null } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`).then((res) => res.json());

  assert.deepEqual(await get('/healthz'), { ok: true });
  const h = await get('/api/health');
  // No engine is running in this test, which is what failing means.
  assert.equal(h.status, 'failing');
  assert.equal(h.ok, false);
  assert.equal(h.problems[0].level, 'error');
  for (const key of ['version', 'node', 'pid', 'uptimeS', 'engine', 'memory', 'outputs', 'supervisor', 'log']) assert.ok(key in h, key);
  assert.deepEqual(h.auto, { status: 'idle', running: false, error: null });
  assert.equal(typeof health().uptimeS, 'number');
  assert.equal(typeof h.counts.effects, 'number');
  assert.ok(h.counts.effects > 0);
  assert.equal(h.counts.voices, 0);
  assert.deepEqual(h.counts.sequence, { loaded: 0, playing: 0 });
});
