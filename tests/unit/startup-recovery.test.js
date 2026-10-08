import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateSequence } from '../../src/server/sequencer.ts';
import { BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

test('a restart recovers a workspace that targets the saved patch, not the default one', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-recovery-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    server: { host: '127.0.0.1', port, token: '' }, artnet: { enabled: false }, sacn: { enabled: false }, sources: { prolink: false, smtc: false },
  }));
  fs.writeFileSync(path.join(dir, 'show.json'), JSON.stringify({
    nextFixtureId: 8, fixtures: [{ id: 7, label: 'Seven', address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255 }],
  }));
  const sequence = validateSequence({ id: 'recover-me', name: 'Recover me', mode: 'arrangement',
    lanes: [{ id: 'track', kind: 'track', fixtureId: 7, name: 'Seven' }] });
  fs.writeFileSync(path.join(dir, 'sequence-workspace.json'), JSON.stringify({
    version: 1, sequence, baseline: null, savedSequenceId: null, beat: 0, take: null, takeCompatible: false,
  }));
  const child = spawn(process.execPath, ['server.js', '--no-supervisor'], { cwd: ROOT, stdio: 'ignore', env: {
    ...process.env, LIGHTSHOW_CONFIG_DIR: dir, LIGHTSHOW_CACHE_DIR: path.join(dir, 'cache'), LIGHTSHOW_LOG_DIR: path.join(dir, 'logs'), LIGHTSHOW_SUPERVISOR: '0',
  } });
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); });
  let body = null;
  for (let i = 0; i < 200 && !body; i++) {
    body = await fetch(`http://127.0.0.1:${port}/api/sequence/workspace`).then((r) => r.json()).catch(() => null);
    if (!body) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(body, 'the server answered');
  assert.deepEqual([body.workspace.recovered, body.workspace.blocked, body.workspace.error], [true, false, null]);
  assert.equal(body.document.sequence.id, 'recover-me');
});
