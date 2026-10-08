import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { options, lightshowConfig } from '../config.js';

const base = ['--browser-profile', path.resolve('dedicated-profile'), '--visualizer-url', 'http://music.invalid:8095/#/now-playing?player=one&frameless=1'];

test('display and preview need no lightshow configuration; curtain is explicit', () => {
  const display = options(base, {});
  assert.equal(display.curtain, false); assert.equal(display.preview, false); assert.equal(display.nodecgConfig, undefined);
  const preview = options([...base, '--preview'], {});
  assert.equal(preview.preview, true); assert.equal(preview.nodecgConfig, undefined);
  const live = options([...base, '--curtain'], { LOCALAPPDATA: 'local' });
  assert.equal(live.curtain, true);
  assert.equal(live.fps, 10); assert.equal(live.fixtureId, 53); assert.equal(live.width * live.height * 3, 8568);
  for (const args of [['--fps', '20'], ['--width', '400'], ['--fixture', '-1'], ['--scene'], ['--token', 'secret'], ['--curtain'], ['--preview', '--curtain'], ['--parent-pid', '0']]) assert.throws(() => options([...base, ...args], {}));
});
test('only explicit player URLs, dedicated absolute profiles and loopback state endpoints pass', () => {
  for (const url of ['http://user:secret@music.invalid/#/now-playing?player=one', 'file:///tmp/source', 'http://music.invalid/#/now-playing', 'http://music.invalid/#/now-playing?player=one&token=secret']) assert.throws(() => options([...base, '--visualizer-url', url], {}), error => !error.message.includes('secret'));
  for (const url of ['http://evil.invalid/bundles/party-visuals/api/state', 'http://127.0.0.1:9090/bundles/party-visuals/api/cmd', 'http://127.0.0.1:9090/bundles/party-visuals/api/state?token=secret']) assert.throws(() => options([...base, '--controls-url', url], {}));
  assert.throws(() => options([...base, '--browser-profile', 'relative-profile'], {}));
});
test('credentials stay in files; tokenFile resolves relative to NodeCG root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-visuals-config-'));
  try {
    fs.mkdirSync(path.join(dir, 'cfg')); const file = path.join(dir, 'cfg', 'party-visuals.json');
    fs.writeFileSync(path.join(dir, 'cfg', 'token'), ' fixture-test-token \n');
    fs.writeFileSync(file, JSON.stringify({ lightshow: { url: 'http://example.invalid/show', tokenFile: 'cfg/token' } }));
    assert.deepEqual(lightshowConfig(file), { origin: 'http://example.invalid', socketPath: '/show/socket.io', token: 'fixture-test-token' });
    fs.writeFileSync(file, JSON.stringify({ lightshow: { url: 'http://user:private@example.invalid/?token=private', tokenFile: 'cfg/token' } }));
    assert.throws(() => lightshowConfig(file), error => !error.message.includes('private'));
    fs.writeFileSync(file, '{invalid private credential');
    assert.throws(() => lightshowConfig(file), error => !error.message.includes('private'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
