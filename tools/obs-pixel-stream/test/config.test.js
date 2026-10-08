import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { options, obsConfig, lightshowConfig } from '../config.js';

test('preview needs no lightshow configuration; live defaults remain constrained', () => {
  const preview = options(['--preview', '--obs-config', 'obs.json'], {});
  assert.equal(preview.preview, true); assert.equal(preview.nodecgConfig, undefined);
  const live = options([], { APPDATA: 'app', LOCALAPPDATA: 'local' });
  assert.equal(live.fps, 10); assert.equal(live.fixtureId, 53); assert.equal(live.width * live.height * 3, 8568);
  for (const args of [['--fps', '20'], ['--width', '400'], ['--fixture', '-1'], ['--scene'], ['--token', 'secret']]) assert.throws(() => options(args, {}));
});
test('credentials stay in files; tokenFile resolves relative to NodeCG root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-pixel-config-'));
  try {
    fs.mkdirSync(path.join(dir, 'cfg')); const file = path.join(dir, 'cfg', 'party-visuals.json');
    fs.writeFileSync(path.join(dir, 'cfg', 'token'), ' fixture-test-token \n');
    fs.writeFileSync(file, JSON.stringify({ lightshow: { url: 'http://example.invalid/show', tokenFile: 'cfg/token' } }));
    assert.deepEqual(lightshowConfig(file), { origin: 'http://example.invalid', socketPath: '/show/socket.io', token: 'fixture-test-token' });
    fs.writeFileSync(file, JSON.stringify({ lightshow: { url: 'http://user:private@example.invalid/?token=private', tokenFile: 'cfg/token' } }));
    assert.throws(() => lightshowConfig(file), error => !error.message.includes('private'));
    fs.writeFileSync(file, '{invalid private credential');
    assert.throws(() => obsConfig(file), error => !error.message.includes('private'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
