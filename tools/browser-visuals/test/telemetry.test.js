import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LeasePump } from '../pump.js';
import { PumpTelemetry, startTelemetry, telemetryWriter, TELEMETRY_INTERVAL_MS } from '../telemetry.js';

function harness(failure) {
  let now = 0, active = true;
  const pump = new LeasePump({ fixtureId: 53, width: 1, height: 1, fps: 44, now: () => now,
    wait: async ms => { now += ms; }, target: () => ({ ok: active, key: 'private-target' }),
    capture: async () => {
      now += failure === 'stale' ? 501 : 8;
      if (failure === 'capture') throw new Error('secret capture detail');
      if (failure === 'revoked') active = false;
      return { width: 1, height: 1, data: Buffer.from([255, 0, 0]) };
    },
    transport: { connected: true, id: 'private-connection', request: async event => {
      if (event.endsWith('claim')) return failure === 'claim' ? { ok: false, code: 'BUSY' }
        : { ok: true, leaseId: 'private-lease', ttlMs: 2000, maxFps: 60, format: 'rgb24', order: 'row-major' };
      if (event.endsWith('frame')) {
        now += 2;
        if (failure === 'ack') throw new Error('secret transport detail');
        if (failure === 'rejected') return { ok: false, code: 'RATE_LIMIT', error: 'secret server detail' };
      }
      return { ok: true };
    } },
  });
  pump.telemetry = new PumpTelemetry(pump, 'curtain', () => now);
  return { pump, at: value => { now = value; }, disarm: () => { active = false; } };
}

test('a window measures completed capture/ACK latency and achieved rate without retaining frames or identities', async () => {
  const h = harness();
  for (let i = 0; i < 1320; i++) { h.at(Math.max(i * 1000 / 44, h.pump.nextCaptureAt)); await h.pump.step(); }
  h.at(30_000);
  const record = h.pump.telemetry.snapshot();
  assert.equal(record.acceptedFrames, 1320);
  assert.equal(record.fps, 44);
  assert.equal(record.active, true);
  assert.equal(record.negotiatedFps, 44);
  assert.deepEqual(record.captureMs, { samples: 1320, mean: 8, max: 8 });
  assert.deepEqual(record.ackMs, { samples: 1320, mean: 2, max: 2 });
  assert.equal(JSON.stringify(record).includes('private'), false);
  assert.deepEqual(h.pump.telemetry.capture, { count: 0, total: 0, max: 0 });
  h.disarm(); h.at(60_000);
  const inactive = h.pump.telemetry.snapshot();
  assert.equal(inactive.active, false);
  assert.equal(inactive.fps, null, 'an idle disarmed window is not a zero-FPS load measurement');
  assert.equal(inactive.captureMs.mean, null);
});

test('capture, ACK, stale, revoked and rejected frames have separate bounded counters without error text', async () => {
  for (const [failure, counter] of [['capture', 'captureFailures'], ['ack', 'ackFailures'], ['stale', 'staleFrames'],
    ['revoked', 'revokedFrames'], ['rejected', 'rejectedFrames'], ['claim', 'claimFailures']]) {
    const h = harness(failure);
    await h.pump.step();
    const record = h.pump.telemetry.snapshot();
    assert.equal(record.acceptedFrames, 0);
    assert.equal(record[counter], 1, failure);
    assert.equal(Object.values(h.pump.telemetry.counts).reduce((sum, value) => sum + value, 0), 0, 'the window resets');
    assert.equal(JSON.stringify(record).includes('secret'), false);
    assert.equal(h.pump.busy, false);
  }
});

test('an idle visualizer counts one pause and reports its reason, never a capture failure', async () => {
  const h = harness();
  await h.pump.step();
  h.at(100);
  const capture = h.pump.capture;
  h.pump.capture = async () => { throw Object.assign(new Error('Visualizer idle'), { idle: true }); };
  await h.pump.step();
  let idle = true;
  h.pump.target = () => idle ? { ok: false, reason: 'Visualizer idle', idle: true } : { ok: true, key: 'private-target' };
  for (const at of [400, 700, 1000]) { h.at(at); await h.pump.step(); }
  const record = h.pump.telemetry.snapshot();
  assert.equal(record.captureFailures, 0);
  assert.equal(record.claimFailures, 0);
  assert.equal(record.idlePauses, 1, 'one fade is one pause, however many ticks it lasts');
  assert.equal(record.active, false);
  assert.equal(record.reason, 'Visualizer idle');
  idle = false; h.pump.capture = capture;
  for (const at of [1300, 1600]) { h.at(at); await h.pump.step(); }
  const resumed = h.pump.telemetry.snapshot();
  assert.equal(resumed.active, true);
  assert.equal(resumed.reason, null);
  assert.equal(resumed.idlePauses, 0);
});

test('room and curtain report every 30 seconds and stop without a telemetry timer in display-only mode', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = harness(), second = harness(), lines = [];
  let held = false;
  const stop = startTelemetry([['curtain', first.pump], ['room', second.pump]], undefined, line => lines.push(JSON.parse(line)), () => ({ displayHeld: held }));
  t.mock.timers.tick(TELEMETRY_INTERVAL_MS - 1);
  assert.equal(lines.length, 0);
  held = true; t.mock.timers.tick(1);
  assert.deepEqual(lines.map(line => line.output), ['curtain', 'room']);
  assert.deepEqual(lines.map(line => line.displayHeld), [true, true]);
  stop(); t.mock.timers.tick(TELEMETRY_INTERVAL_MS);
  assert.equal(lines.length, 2);
  assert.equal(first.pump.telemetry, null);
  startTelemetry([], undefined, () => assert.fail('display-only telemetry'))();
});

test('log rotation keeps one bounded backup and concurrent writes do not build a backlog', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-telemetry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'capture.ndjson'), write = telemetryWriter(file, () => assert.fail('unexpected file error'), 128);
  for (let frame = 0; frame < 30; frame++) await write([{ frame }]);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['capture.ndjson', 'capture.ndjson.1']);
  assert.ok((await fs.stat(file)).size <= 128);
  assert.ok((await fs.stat(file + '.1')).size <= 128);
  const concurrent = path.join(dir, 'concurrent.ndjson'), parallelWrite = telemetryWriter(concurrent);
  await Promise.all(Array.from({ length: 100 }, (_, frame) => parallelWrite([{ frame }])));
  assert.equal((await fs.readFile(concurrent, 'utf8')).trim().split('\n').length, 1);
});

test('a failed status read or logger cannot escape the telemetry timer', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness();
  h.pump.lease = { claim: { maxFps: 60 } };
  const stop = startTelemetry([['curtain', h.pump]], undefined, () => { throw new Error('closed log sink'); });
  assert.doesNotThrow(() => t.mock.timers.tick(TELEMETRY_INTERVAL_MS));
  h.pump.target = () => { throw new Error('state unavailable'); };
  assert.doesNotThrow(() => t.mock.timers.tick(TELEMETRY_INTERVAL_MS));
  stop();
});

test('an unwritable telemetry path never rejects or prevents subsequent captures', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-telemetry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'not-a-directory');
  await fs.writeFile(parent, 'existing');
  const warnings = [], write = telemetryWriter(path.join(parent, 'capture.ndjson'), warning => warnings.push(warning));
  const h = harness();
  await h.pump.step();
  await write([h.pump.telemetry.snapshot()]);
  h.at(100); await h.pump.step();
  await write([h.pump.telemetry.snapshot()]);
  assert.equal(h.pump.frames, 2);
  assert.deepEqual(warnings, ['Browser telemetry file unavailable']);
  await telemetryWriter(path.join(parent, 'capture.ndjson'), () => { throw new Error('closed warning sink'); })([{}]);
  assert.equal(await fs.readFile(parent, 'utf8'), 'existing');
});
