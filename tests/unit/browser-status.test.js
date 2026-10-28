import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { statusSnapshot, statusWriter } from '../../tools/browser-visuals/status.js';
import { options } from '../../tools/browser-visuals/config.js';

test('status separates missing visuals from disarmed output and excludes configuration', () => {
  const feed = { armed: () => false, pump: { transport: { connected: true, token: 'never-serialize' }, lease: null, frames: 0 } };
  const s = statusSnapshot({ connected: true, ready: true, live: false, visible: true,
    reason: 'visualizer-unavailable', feeds: [['room', feed]], token: 'never-serialize' });
  assert.equal(s.display.reason, 'visualizer-unavailable');
  assert.equal(s.outputs[0].reason, 'disarmed');
  assert.equal(JSON.stringify(s).includes('never-serialize'), false);
  assert.equal(statusSnapshot({ connected: true, live: true, stopped: true }).display.live, false);
  assert.equal(statusSnapshot({ connected: false, ready: false, live: true }).display.live, false, 'disconnect invalidates the previous live frame');
  assert.equal(statusSnapshot({ connected: true, ready: false, live: true }).display.live, false, 'navigation invalidates the previous player');
  assert.equal(statusSnapshot({ connected: true, reason: 'secret arbitrary error' }).display.reason, null);
});

test('status writes one bounded complete latest snapshot and preserves it on failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-status-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'status.json'), warnings = [];
  const write = statusWriter(file, message => warnings.push(message));
  const writes = Array.from({ length: 100 }, (_, n) => write({ version: 1, n }));
  await Promise.all(writes);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, n: 99 });
  await write({ oversized: 'x'.repeat(65537) });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, n: 99 });
  assert.equal(warnings.length, 1);
  assert.deepEqual(await fs.readdir(dir), ['status.json']);
  await write({ version: 1, stopped: true });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).stopped, true);
});

test('status output requires an absolute path without changing output modes', () => {
  const args = ['--browser-profile', path.resolve('test-profile'), '--visualizer-url', 'http://music.invalid/#/now-playing?player=test'];
  assert.throws(() => options([...args, '--status-file', 'relative.json']), /absolute path/);
  const value = options([...args, '--status-file', path.resolve('status.json')]);
  assert.equal(value.curtain, false);
  assert.equal(value.room, false);
});
