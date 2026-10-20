import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DisplayHold, HOLD_SCRIPT, displayHold, holdProcess } from '../awake.js';

function child() {
  const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), killed: 0, closed: 0 });
  process.stdin = Object.assign(new EventEmitter(), { destroy: () => { process.closed++; } });
  process.kill = () => { process.killed++; return true; };
  process.confirm = () => process.stdout.emit('data', Buffer.from('held\r\n'));
  return process;
}
function harness(options = {}) {
  let now = 0;
  const children = [], logs = [];
  const hold = new DisplayHold({ now: () => now, log: line => logs.push(line), spawn: () => { const value = child(); children.push(value); return value; }, ...options });
  return { hold, children, logs, at: value => { now = value; } };
}

test('armed outputs start one confirmed holder however often the state repeats, and log once', () => {
  const h = harness();
  h.hold.update(false);
  assert.equal(h.children.length, 0, 'disarmed: nothing is held');
  h.hold.update(true); h.hold.update(true);
  assert.equal(h.children.length, 1);
  assert.equal(h.hold.held, false, 'not held until the holder confirms the request');
  assert.deepEqual(h.logs, []);
  h.children[0].confirm(); h.children[0].confirm();
  for (let at = 0; at < 60_000; at += 250) { h.at(at); h.hold.update(true); }
  assert.equal(h.children.length, 1);
  assert.equal(h.hold.held, true);
  assert.deepEqual(h.logs, ['Displays kept awake while outputs are armed']);
});

test('disarm or an unreachable server ends the holder after a short grace; a missed sync does not', () => {
  const h = harness();
  h.hold.update(true); h.children[0].confirm();
  h.at(1000); h.hold.update(false);
  h.at(2000); h.hold.update(true);
  h.at(11_000); h.hold.update(false);
  assert.equal(h.children[0].killed, 0, 'a dropped state sync is not a disarm');
  h.at(11_999); h.hold.update(false);
  assert.equal(h.children[0].killed, 0);
  h.at(12_000); h.hold.update(false);
  assert.equal(h.children[0].killed, 1);
  assert.equal(h.children[0].closed, 1);
  assert.equal(h.hold.held, false);
  h.at(13_000); h.hold.update(false);
  h.children[0].emit('exit', 1);
  assert.deepEqual(h.logs, ['Displays kept awake while outputs are armed', 'Displays may sleep again']);
  h.at(14_000); h.hold.update(true);
  assert.equal(h.children.length, 2, 're-arming holds again at once');
});

test('a holder that dies or never starts is retried every 30 seconds, warned about once, and never doubled', () => {
  const h = harness();
  h.hold.update(true); h.children[0].confirm();
  h.at(500); h.children[0].emit('exit', 1);
  assert.equal(h.hold.held, false);
  h.at(1000); h.hold.update(true);
  assert.equal(h.children.length, 1, 'no respawn loop');
  h.at(30_500); h.hold.update(true);
  assert.equal(h.children.length, 2);
  h.children[1].emit('error', new Error('spawn powershell.exe ENOENT')); h.children[1].emit('exit', -1);
  h.at(60_499); h.hold.update(true);
  assert.equal(h.children.length, 2);
  h.at(60_500); h.hold.update(true);
  h.children[2].emit('exit', 1);
  h.at(90_500); h.hold.update(true);
  h.children[3].confirm();
  assert.deepEqual(h.logs, ['Displays kept awake while outputs are armed', 'Display keep-awake ended unexpectedly; retrying',
    'Display keep-awake unavailable; retrying', 'Displays kept awake while outputs are armed']);
  const thrown = harness({ spawn: () => { throw new Error('no process'); } });
  assert.doesNotThrow(() => thrown.hold.update(true));
  assert.deepEqual(thrown.logs, ['Display keep-awake unavailable; retrying']);
});

test('stop ends the holder at once and nothing restarts it while the helper exits', () => {
  const h = harness();
  h.hold.update(true); h.children[0].confirm();
  h.hold.stop();
  assert.equal(h.children[0].killed, 1);
  assert.equal(h.hold.held, false);
  h.hold.update(true); h.at(60_000); h.hold.update(true);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.logs, ['Displays kept awake while outputs are armed', 'Displays may sleep again']);
  harness().hold.stop();
});

test('the holder is a hidden Windows PowerShell whose display request lasts exactly as long as its stdin pipe', () => {
  let call;
  const result = holdProcess(HOLD_SCRIPT, { SystemRoot: 'D:\\Win' }, (...args) => { call = args; return 'process'; });
  assert.equal(result, 'process');
  const [file, args, options] = call;
  assert.equal(file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'never resolved through PATH');
  assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, HOLD_SCRIPT);
  assert.match(script, /SetThreadExecutionState\(0x80000002u\)/, 'ES_CONTINUOUS | ES_DISPLAY_REQUIRED');
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.doesNotMatch(script, /powercfg/i, 'the power plan stays as it is');
  assert.deepEqual(options, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  assert.equal(displayHold(() => {}, 'linux'), null);
  assert.ok(displayHold(() => {}, 'win32') instanceof DisplayHold);
});
