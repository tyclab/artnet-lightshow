import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesTarget, discoverPage, captureCanvas, ppm } from '../browser.js';
import { parentAlive, readControls } from '../cli.js';

const expected = 'http://music.invalid:8095/#/now-playing?player=one&frameless=1';
const ws = 'ws://127.0.0.1:9222/devtools/page/page-id';
function discovery({ active = '9222\n/devtools/browser/profile-id\n', version = 'ws://localhost:9222/devtools/browser/profile-id', targets = [{ type: 'page', url: expected, webSocketDebuggerUrl: ws }] } = {}) {
  const calls = [];
  return { calls, readFile: async () => active, fetcher: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    return { ok: true, text: async () => JSON.stringify(url.endsWith('/json/version') ? { webSocketDebuggerUrl: version } : targets) };
  } };
}

test('target match permits query order only, excluding other pages, players and credentials', () => {
  assert.equal(matchesTarget('http://music.invalid:8095/#/now-playing?frameless=1&player=one', expected), true);
  for (const actual of ['http://music.invalid:8095/#/login', expected.replace('one', 'two'), expected.replace('8095', '80'), expected + '&token=secret', expected.replace('http://', 'http://user:secret@'), 'invalid']) assert.equal(matchesTarget(actual, expected), false);
});
test('discovery verifies the profile browser identity and selects exactly one matching page', async () => {
  const deps = discovery({ targets: [{ type: 'page', url: 'http://unrelated.invalid', webSocketDebuggerUrl: 'ws://evil.invalid/devtools/page/other' }, { type: 'page', url: expected, webSocketDebuggerUrl: ws }] });
  assert.equal(await discoverPage('/dedicated', expected, deps), ws);
  assert.deepEqual(deps.calls, ['http://127.0.0.1:9222/json/version', 'http://127.0.0.1:9222/json/list']);
  for (const changes of [{ active: '0\n/devtools/browser/profile-id' }, { active: '9222\n/elsewhere' }, { version: 'ws://127.0.0.1:9222/devtools/browser/other-profile' }, { version: 'ws://evil.invalid:9222/devtools/browser/profile-id' }, { targets: [] }, { targets: [{ type: 'page', url: expected, webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/page/id' }] }, { targets: Array(2).fill({ type: 'page', url: expected, webSocketDebuggerUrl: ws }) }]) await assert.rejects(discoverPage('/dedicated', expected, discovery(changes)));
});
test('capture returns exact logical RGB bytes and never forwards secret-bearing settings', async () => {
  let request;
  const browser = { action: async options => { request = options; return { ok: true, width: 2, height: 1, data: [255, 0, 0, 0, 0, 255] }; } };
  const settings = { width: 2, height: 1, fit: 'cover', token: 'never-forward-this' };
  const image = await captureCanvas(browser, settings, false);
  assert.deepEqual(request, { mode: 'capture', width: 2, height: 1, fit: 'cover', visible: false });
  assert.deepEqual([...image.data], [255, 0, 0, 0, 0, 255]);
  assert.equal(ppm(image).subarray(0, 11).toString(), 'P6\n2 1\n255\n');
  for (const invalid of [{ ok: false }, { ok: true, width: 2, height: 1, data: Array(6).fill(256) }, { ok: true, width: 2, height: 1, data: Array(5).fill(0) }]) await assert.rejects(captureCanvas({ action: async () => invalid }, settings));
});
test('wash visibility ignores intensity and controls failures fail closed without redirects', async () => {
  for (const on of [true, false]) {
    const result = await readControls('http://127.0.0.1:9090/state', async (_url, options) => {
      assert.equal(options.redirect, 'error'); return { ok: true, text: async () => JSON.stringify({ controls: { wash: { on, intensity: 50 } } }) };
    });
    assert.deepEqual(result, { ok: true, visible: on });
  }
  for (const response of [{ ok: false }, { ok: true, text: async () => '{}' }, { ok: true, text: async () => 'x'.repeat(65_537) }]) assert.deepEqual(await readControls('local', async () => response), { ok: false, visible: false });
  assert.deepEqual(await readControls('local', async () => { throw new Error('offline'); }), { ok: false, visible: false });
});
test('parent watchdog distinguishes exited supervisor from access-denied alive process', () => {
  assert.equal(parentAlive(undefined, () => { throw new Error(); }), true);
  assert.equal(parentAlive(123, (pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0); }), true);
  assert.equal(parentAlive(123, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(parentAlive(123, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), true);
});
