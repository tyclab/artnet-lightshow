import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO, loadConfig } from '../config.js';

function write(t, body, token = 'the-worker-token') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (token !== null) fs.writeFileSync(path.join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return { file, dir };
}

test('defaults: the GitHub repository, 4 GB of GPU memory for others, the party browsers allowed', (t) => {
  const { file } = write(t, { server: 'http://10.27.2.42:3000', tokenFile: 'token' });
  const config = loadConfig(file, { env: {}, hostname: 'GamerTyc.lan', home: '/home/op' });
  assert.equal(config.token, 'the-worker-token');
  assert.equal(config.name, 'gamertyc');
  assert.deepEqual(config.server, { origin: 'http://10.27.2.42:3000', base: 'http://10.27.2.42:3000', socketPath: '/socket.io' });
  assert.equal(config.repo, DEFAULT_REPO);
  assert.equal(config.dataDir, '/home/op/.local/share/lightshow-remote-analyzer');
  assert.equal(config.modelData, '/home/op/.local/share/lightshow-remote-analyzer/model-data');
  assert.equal(config.maxOtherVramMiB, 4096);
  assert.deepEqual(config.allowFullscreen, ['chrome', 'msedge', 'firefox']);
  assert.equal(config.source, null);
});

test('a lightshow behind a path keeps its prefix for the socket and the job routes', (t) => {
  const { file } = write(t, { server: 'https://show.example.invalid/lightshow/', tokenFile: 'token', allowFullscreen: ['Chrome.exe'] });
  const config = loadConfig(file, { env: {} });
  assert.equal(config.server.base, 'https://show.example.invalid/lightshow');
  assert.equal(config.server.socketPath, '/lightshow/socket.io');
  assert.deepEqual(config.allowFullscreen, ['chrome']);
});

test('the environment token wins; no token, credentials in the URL and unknown keys are refused without echoing secrets', (t) => {
  const { file } = write(t, { server: 'http://10.27.2.42:3000', tokenFile: 'token' });
  assert.equal(loadConfig(file, { env: { LIGHTSHOW_WORKER_TOKEN: 'from-env' } }).token, 'from-env');
  const bare = write(t, { server: 'http://10.27.2.42:3000' }, null);
  assert.throws(() => loadConfig(bare.file, { env: {} }), /No worker token/);
  for (const body of [
    { server: 'http://user:hunter2@10.27.2.42:3000', tokenFile: 'token' },
    { server: 'http://10.27.2.42:3000/?token=hunter2', tokenFile: 'token' },
    { server: 'ftp://10.27.2.42', tokenFile: 'token' },
    { server: 'http://10.27.2.42:3000', tokenFile: 'token', password: 'hunter2' },
    { server: 'http://10.27.2.42:3000', tokenFile: 'token', name: '../evil' },
    { server: 'http://10.27.2.42:3000', tokenFile: 'token', memory: '16g; rm -rf /' },
    { server: 'http://10.27.2.42:3000', tokenFile: 'token', repo: 'http://plain.invalid/repo.git' },
  ]) {
    const { file: bad } = write(t, body);
    assert.throws(() => loadConfig(bad, { env: {} }), (err) => !err.message.includes('hunter2') && !err.message.includes('the-worker-token'));
  }
});
