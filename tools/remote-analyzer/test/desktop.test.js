import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopWatch, HOLD_SCRIPT, PROBE_SCRIPT, SystemHold, blockingApp, powershellPath } from '../desktop.js';
import { parseSmi } from '../gpu.js';

const ALLOW = ['chrome', 'msedge', 'firefox'];

test('a fullscreen program in front blocks unless it is the party browser; an exclusive D3D game always does', () => {
  assert.equal(blockingApp(null, ALLOW), null, 'an unknown desktop blocks nothing');
  assert.equal(blockingApp({ state: 2, fullscreen: false, app: 'WindowsTerminal' }, ALLOW), null,
    'busy because the visuals are fullscreen on another screen: the window in front decides');
  assert.equal(blockingApp({ state: 2, fullscreen: true, app: 'chrome' }, ALLOW), null);
  assert.equal(blockingApp({ state: 5, fullscreen: true, app: 'eldenring' }, ALLOW), 'eldenring');
  assert.equal(blockingApp({ state: 3, fullscreen: false, app: 'chrome' }, ALLOW), 'chrome');
});

test('the scripts ask Windows for exactly what they say', () => {
  assert.match(HOLD_SCRIPT, /SetThreadExecutionState\(0x80000001u\)/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED, not the display');
  assert.match(HOLD_SCRIPT, /ReadToEnd/, 'held until the agent closes the pipe');
  assert.match(PROBE_SCRIPT, /SHQueryUserNotificationState/);
  assert.match(PROBE_SCRIPT, /GetMonitorInfo/);
  assert.doesNotMatch(PROBE_SCRIPT + HOLD_SCRIPT, /Set-ItemProperty|powercfg|reg add/i, 'nothing is changed on Windows');
  assert.equal(powershellPath('linux', {}, () => false), null);
  assert.match(powershellPath('linux', {}, () => true), /^\/mnt\/c\/Windows\/System32\//);
});

function child() {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { destroy() { c.closed = true; } }) });
  c.kill = () => { c.killed = true; c.emit('exit', null); };
  return c;
}

test('the watch keeps the latest reading, forgets a stale one, and retries a dead probe', async () => {
  let now = 0;
  const children = [];
  const logs = [];
  const watch = new DesktopWatch({ start: () => { const c = child(); children.push(c); return c; }, now: () => now, log: (l) => logs.push(l), retryMs: 10, staleMs: 1000 });
  watch.run();
  children[0].stdout.emit('data', '{"state":5,"fullscreen":true,"app":"game"}\r\n{"state":');
  assert.deepEqual(watch.latest(), { state: 5, fullscreen: true, app: 'game', at: 0 });
  now = 2000;
  assert.equal(watch.latest(), null);
  children[0].emit('exit', 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 2);
  assert.equal(logs.length, 1);
  watch.stop();
  assert.equal(children[1].killed, true);
});

test('the system hold is one holder per job, released with its pipe', () => {
  const children = [];
  const hold = new SystemHold({ start: () => { const c = child(); children.push(c); return c; } });
  hold.acquire(); hold.acquire();
  assert.equal(children.length, 1);
  children[0].stdout.emit('data', 'held\r\n');
  assert.equal(hold.held, true);
  hold.release();
  assert.equal(children[0].closed, true);
  assert.equal(hold.held, false);
});

test('nvidia-smi lines are read; anything else is not', () => {
  assert.deepEqual(parseSmi('NVIDIA GeForce RTX 2080 SUPER, 8192, 2349\n'), { name: 'NVIDIA GeForce RTX 2080 SUPER', totalMiB: 8192, usedMiB: 2349 });
  assert.equal(parseSmi('NVIDIA-SMI has failed'), null);
});
