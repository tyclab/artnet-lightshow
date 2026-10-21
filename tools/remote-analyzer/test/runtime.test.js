import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnalysisProcess, imageTag, parseModelListing, venvKey, workerArgs } from '../runtime.js';

const pairs = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test('the analysis container: the GPU through /dev/dxg, unpinned memory, no network, read-only data', () => {
  const args = workerArgs({ name: 'lsremote-x', image: 'img', codeDir: '/c', venv: '/v', pythonDir: '/p', modelData: '/m', jobsDir: '/j',
    env: { ARTNET_STRUCTURE_MODEL: 'auto' } });
  assert.deepEqual(pairs(args, '--device'), ['/dev/dxg']);
  assert.ok(pairs(args, '-v').includes('/usr/lib/wsl:/usr/lib/wsl:ro'));
  const env = pairs(args, '-e');
  for (const want of ['LD_LIBRARY_PATH=/usr/lib/wsl/lib', 'ARTNET_PINNED_GB=0', 'HF_HUB_OFFLINE=1', 'ARTNET_STRUCTURE_MODEL=auto']) assert.ok(env.includes(want), want);
  assert.deepEqual(pairs(args, '--network'), ['none']);
  assert.ok(args.includes('--read-only') && args.includes('--rm') && args.includes('-i'));
  const mounts = pairs(args, '-v').filter((m) => !m.startsWith('/usr/lib/wsl'));
  assert.ok(mounts.every((m) => m.endsWith(':ro')), 'nothing the analysis can write to outlives it');
  assert.deepEqual(args.slice(-3), ['/data/.venv/bin/python', '/app/src/analyze.py', '--worker']);
});

test('a new lock gets a new environment; the image tag follows the Dockerfile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), 'a');
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'b');
  const before = venvKey(dir);
  assert.match(before, /^[0-9a-f]{16}-cu128$/);
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'c');
  assert.notEqual(venvKey(dir), before);
  assert.notEqual(imageTag('FROM a'), imageTag('FROM b'));
});

test('the model listing is the present ids', () => {
  const line = JSON.stringify({ root: '/data/models', models: [{ id: 'muq', present: true }, { id: 'songformer', present: false }, { id: 'beat_this', present: true }] });
  assert.deepEqual(parseModelListing(`[models] noise\n${line}\n`), ['beat_this', 'muq']);
  assert.throws(() => parseModelListing('nothing'));
});

function fakeDocker() {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), written: [] });
  c.stdout.setEncoding = c.stderr.setEncoding = () => {};
  c.stdin = Object.assign(new EventEmitter(), { write: (line) => c.written.push(JSON.parse(line)), end() {} });
  c.kill = () => {};
  return c;
}

test('the NDJSON worker: ready from its log, one reply per request, the rest of stdout ignored, exit fails what waits', async () => {
  const c = fakeDocker();
  const killed = [];
  const proc = new AnalysisProcess({ name: 'lsremote-x', args: [], start: () => c, kill: async (n) => { killed.push(n); } }).start();
  c.stderr.emit('data', '[analyze] models ready\n[analyzer] worker ready\n');
  await proc.ready;
  const reply = proc.request('/jobs/a.mp3', null);
  assert.deepEqual(c.written, [{ id: 1, source: '/jobs/a.mp3', targetDurationSec: null }]);
  await assert.rejects(proc.request('/jobs/b.mp3', null), /busy/);
  c.stdout.emit('data', 'not json\n{"id": 7, "result": {}}\n{"id": 1, "result": {"bpm": 1');
  c.stdout.emit('data', '28}}\n');
  assert.deepEqual((await reply).result, { bpm: 128 });
  const lost = proc.request('/jobs/c.mp3', null);
  c.emit('exit', 137, null);
  await assert.rejects(lost, /exited \(code 137\)/);
  await proc.stop();
  assert.deepEqual(killed, [], 'an exited container is not killed again');
});
