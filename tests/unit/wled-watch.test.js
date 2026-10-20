// Watching the patched WLEDs while the outputs are armed (src/server/wled-watch.ts):
// a board in live override (`lor`, set by the WLED app) ignores DDP without a
// word, so the server asks each one every ten seconds and says when it does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWledWatch, startWledWatch, stopWledWatch, wledStatus, wledBoards } from '../../src/server/wled-watch.ts';
import { readLive, wledLive } from '../../src/server/wled.ts';
import { assess, health } from '../../src/server/health.ts';
import { getLiveState } from '../../src/server/state.ts';
import { domainOf } from '../../src/server/protocol.ts';

const CURTAIN = { host: '10.0.0.60', fixtures: [{ id: 7, label: 'Curtain' }] };
const GLORB = { host: 'glorb.local', fixtures: [{ id: 8, label: 'Glorb A' }, { id: 9, label: 'Glorb B' }] };

/** A WLED's /json/si as the fake network answers it: `boards[host]` is { lor, live } or an Error. */
function fakeNetwork(boards) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.ok(init.signal, 'every poll is bounded by a timeout');
    const host = new URL(url).hostname;
    const answer = boards[host];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ state: { on: true, lor: answer.lor, seg: [] }, info: { ver: '16.0.1', live: answer.live, lm: answer.live ? 'DDP' : '' } }));
  };
  return { fetchImpl, calls };
}

function fakeLog() {
  const lines = [];
  const at = (level) => (fields, msg) => lines.push({ level, msg, ...fields });
  return { lines, log: { info: at('info'), warn: at('warn') } };
}

function watchOf({ boards = [CURTAIN], answers = { '10.0.0.60': { lor: 0, live: true } }, armed = () => true } = {}) {
  let clock = 0;
  const net = fakeNetwork(answers);
  const { lines, log } = fakeLog();
  const watch = createWledWatch({ boards: () => boards, armed, fetchImpl: net.fetchImpl, now: () => clock, log });
  return { watch, net, lines, answers, advance: (ms) => { clock += ms; } };
}

test('a WLED says whether it is in live override and whether it takes live data', () => {
  assert.deepEqual(readLive({ state: { lor: 2 }, info: { live: true } }, 'h'), { lor: 2, live: true });
  assert.deepEqual(readLive({ state: { lor: 0 }, info: {} }, 'h'), { lor: 0, live: null });
  assert.throws(() => readLive({ state: {}, info: { live: true } }, 'h'), /not a WLED/);
});

test('one GET of /json/si per board, state and info together', async () => {
  const net = fakeNetwork({ '10.0.0.60': { lor: 1, live: false } });
  assert.deepEqual(await wledLive('10.0.0.60', { fetchImpl: net.fetchImpl }), { lor: 1, live: false });
  assert.deepEqual(net.calls, ['http://10.0.0.60/json/si']);
});

test('the boards are the patched WLEDs, one per host, with their fixtures', () => {
  const fixtures = [
    { id: 7, label: 'Curtain', output: { protocol: 'ddp', host: '10.0.0.60' } },
    { id: 8, label: 'Glorb A', output: { protocol: 'ddp', host: 'Glorb.local', at: 0 } },
    { id: 9, label: 'Glorb B', output: { protocol: 'ddp', host: 'glorb.local', at: 120 } },
    { id: 10, label: 'Par', address: 1, universe: 0 },
    { id: 11, label: 'PC', output: { protocol: 'openrgb', host: '10.0.0.70', device: 0 } },
  ];
  assert.deepEqual(wledBoards(fixtures), [
    { host: '10.0.0.60', fixtures: [{ id: 7, label: 'Curtain' }] },
    { host: 'Glorb.local', fixtures: [{ id: 8, label: 'Glorb A' }, { id: 9, label: 'Glorb B' }] },
  ]);
});

test('disarmed, nothing is asked and nothing is said', async () => {
  const { watch, net } = watchOf({ armed: () => false });
  await watch.tick();
  assert.deepEqual(net.calls, []);
  assert.deepEqual(watch.status(), []);
});

test('a board taking the show is live, and that is not news', async () => {
  const { watch, lines } = watchOf();
  assert.deepEqual(watch.status().map((b) => b.status), ['checking'], 'armed: watched before the first answer');
  await watch.tick();
  assert.deepEqual(watch.status(), [{ host: '10.0.0.60', fixtures: [7], status: 'live', lor: 0, live: true, problem: null }]);
  assert.deepEqual(lines, []);
});

test('live override is said once when it starts and once when it ends, and never cleared', async () => {
  const { watch, net, lines, answers, advance } = watchOf({ answers: { '10.0.0.60': { lor: 2, live: true } } });
  await watch.tick();
  const [board] = watch.status();
  assert.equal(board.status, 'override');
  assert.equal(board.lor, 2);
  assert.match(board.problem, /WLED live override active .*the board ignores the show/);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
  assert.match(lines[0].msg, /"Curtain" at 10\.0\.0\.60: WLED live override active \(lor 2\)/);
  assert.deepEqual([lines[0].host, lines[0].lor], ['10.0.0.60', 2]);

  advance(10_000);
  await watch.tick();
  assert.equal(lines.length, 1, 'still in override: nothing more to say');

  answers['10.0.0.60'] = { lor: 0, live: true };
  advance(10_000);
  await watch.tick();
  assert.equal(watch.status()[0].status, 'live');
  assert.equal(watch.status()[0].problem, null);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].level, 'info');
  assert.match(lines[1].msg, /takes the show again/);
  assert.ok(net.calls.every((url) => url.endsWith('/json/si')), 'only GETs: the override is HA\'s to clear');
});

test('a board that answers but takes no live data is said after two readings', async () => {
  const { watch, lines, advance } = watchOf({ answers: { '10.0.0.60': { lor: 0, live: false } } });
  await watch.tick();
  assert.equal(watch.status()[0].status, 'checking', 'one reading may predate the first frame');
  assert.deepEqual(lines, []);
  advance(10_000);
  await watch.tick();
  const [board] = watch.status();
  assert.equal(board.status, 'not-live');
  assert.match(board.problem, /not taking the stream/);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
});

test('a board that does not answer is backed off, then said once', async () => {
  const { watch, net, lines, answers, advance } = watchOf({ answers: { '10.0.0.60': new TypeError('fetch failed') } });
  await watch.tick();
  assert.equal(net.calls.length, 1);
  assert.equal(watch.status()[0].status, 'checking', 'one miss is not a fault');
  advance(10_000);
  await watch.tick();
  assert.equal(net.calls.length, 1, 'backed off: not asked again yet');
  advance(10_000);
  await watch.tick();
  assert.equal(net.calls.length, 2);
  assert.equal(watch.status()[0].status, 'unreachable');
  assert.match(watch.status()[0].problem, /does not answer/);
  assert.deepEqual(lines.map((l) => l.level), ['warn']);
  for (let k = 0; k < 3; k++) { advance(10_000); await watch.tick(); }
  assert.equal(net.calls.length, 2, 'two misses: forty seconds before the next try');
  answers['10.0.0.60'] = { lor: 0, live: true };
  advance(10_000);
  await watch.tick();
  assert.equal(net.calls.length, 3);
  assert.equal(watch.status()[0].status, 'live');
  assert.deepEqual(lines.map((l) => l.level), ['warn', 'info']);
});

test('a poll still out is not asked again', async () => {
  let release;
  const calls = [];
  const fetchImpl = (url) => { calls.push(url); return new Promise((resolve) => { release = resolve; }); };
  const watch = createWledWatch({ boards: () => [CURTAIN], armed: () => true, fetchImpl, now: () => 0, log: fakeLog().log });
  const first = watch.tick();
  await watch.tick();
  assert.equal(calls.length, 1);
  release(new Response(JSON.stringify({ state: { lor: 0 }, info: { live: true } })));
  await first;
  assert.equal(watch.status()[0].status, 'live');
});

test('disarming drops what was known, and an answer that comes after is ignored', async () => {
  let armed = true;
  let release;
  const fetchImpl = () => new Promise((resolve) => { release = resolve; });
  const { lines, log } = fakeLog();
  const watch = createWledWatch({ boards: () => [CURTAIN], armed: () => armed, fetchImpl, now: () => 0, log });
  const out = watch.tick();
  armed = false;
  assert.deepEqual(watch.status(), [], 'disarmed: nothing goes out, so nothing is claimed');
  await watch.tick();
  release(new Response(JSON.stringify({ state: { lor: 2 }, info: { live: false } })));
  await out;
  armed = true;
  assert.deepEqual(watch.status().map((b) => b.status), ['checking']);
  assert.deepEqual(lines, []);
});

test('boards come and go with the patch', async () => {
  let boards = [CURTAIN, GLORB];
  const net = fakeNetwork({ '10.0.0.60': { lor: 0, live: true }, 'glorb.local': { lor: 1, live: true } });
  const watch = createWledWatch({ boards: () => boards, armed: () => true, fetchImpl: net.fetchImpl, now: () => 0, log: fakeLog().log });
  await watch.tick();
  assert.deepEqual(watch.status().map((b) => [b.host, b.fixtures, b.status]), [['10.0.0.60', [7], 'live'], ['glorb.local', [8, 9], 'override']]);
  boards = [CURTAIN];
  await watch.tick();
  assert.deepEqual(watch.status().map((b) => b.host), ['10.0.0.60']);
});

test('the live state and the health report carry it; an override degrades health', async (t) => {
  const net = fakeNetwork({ '10.0.0.60': { lor: 2, live: true } });
  const watch = startWledWatch({ boards: () => [CURTAIN], armed: () => true, fetchImpl: net.fetchImpl, log: fakeLog().log, intervalMs: 60_000 });
  t.after(() => stopWledWatch());
  await watch.tick();
  assert.equal(wledStatus()[0].status, 'override');
  assert.deepEqual(getLiveState().wled, wledStatus());
  assert.equal(domainOf('wled'), 'rig');
  assert.deepEqual(health().outputs.wled, wledStatus());

  const fine = {
    engine: { running: true, frames: 1000, lateFrames: 0 }, eventLoop: null, rssMb: 100, errors: { count: 0, last: null },
    supervisor: { supervised: false, restarts: 0, lastExit: null, recovering: false }, auto: null,
  };
  const degraded = assess({ ...fine, wled: wledStatus() });
  assert.equal(degraded.status, 'degraded');
  assert.match(degraded.problems[0].what, /"Curtain" at 10\.0\.0\.60: WLED live override active/);
  assert.equal(assess({ ...fine, wled: [{ ...wledStatus()[0], status: 'live', problem: null }] }).status, 'ok');
  stopWledWatch();
  assert.deepEqual(wledStatus(), []);
});
