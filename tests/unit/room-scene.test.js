import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { RoomSceneStore } from '../../src/server/room-scene-store.ts';
import { attachRoomSceneRoutes } from '../../src/server/routes/room-scene.ts';
import { createAuth } from '../../src/server/auth.ts';

const room = () => ({
  version: 1, name: 'Example room', bounds: { width: 6, depth: 4, height: 3 },
  source: { name: 'Example survey', revision: 3, confidence: 'estimated' },
  rooms: [{ id: 'main', label: 'Main room', polygon: [[-3, -2], [3, -2], [3, 2], [-3, 2]] }],
  objects: [{ id: 'wall', kind: 'box', role: 'wall', position: { x: 0, y: 1.5, z: -2 }, size: { x: 6, y: 3, z: 0.1 } }],
  bindings: [
    { id: 'left', fixtureId: 17, position: { x: -1, y: 2.2, z: 0 }, confidence: 'estimated' },
    { id: 'right', fixtureId: 17, unit: 0, position: { x: 1, y: 2.2, z: 0 }, confidence: 'estimated' },
  ],
});

function storeFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-room-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new RoomSceneStore(path.join(dir, 'stage-room.json')).load();
}

test('room import preserves fixture IDs and shared output bindings with explicit units', () => {
  const parsed = roomSceneSchema.parse(room());
  assert.equal(parsed.source.revision, '3');
  assert.deepEqual(parsed.bindings.map((b) => [b.fixtureId, b.unit]), [[17, 0], [17, 0]]);
  assert.equal(parsed.bindings[0].position.y, 2.2);
});

test('room schema rejects unsafe geometry, remote assets and ambiguous IDs', () => {
  const mutations = [
    (r) => { r.bounds.width = Infinity; },
    (r) => { r.bounds.height = 0; },
    (r) => { r.texture = 'https://example.invalid/private.png'; },
    (r) => { r.objects[0].kind = 'script'; },
    (r) => { r.objects[0].position.x = 300; },
    (r) => { r.objects[0].size.y = -1; },
    (r) => { r.objects[0].rotation = { x: 0, y: NaN, z: 0 }; },
    (r) => { r.objects[0].kind = 'prism'; },
    (r) => { r.objects[0].kind = 'prism'; r.objects[0].polygon = [[0, 0], [30, 0], [0, 30]]; },
    (r) => { r.rooms[0].polygon = [[0, 0], [1, 1], [2, 2]]; },
    (r) => { r.rooms[0].polygon[0][0] = 100; },
    (r) => { r.bindings[1].id = r.bindings[0].id; },
    (r) => { r.bindings[0].unit = -1; },
    (r) => { r.objects = Array.from({ length: 1501 }, (_, i) => ({ ...r.objects[0], id: `object-${i}` })); },
  ];
  for (const mutate of mutations) {
    const candidate = room();
    mutate(candidate);
    assert.equal(roomSceneSchema.safeParse(candidate).success, false, mutate.toString());
  }
});

test('room store persists privately, isolates returned data and preserves the prior room on write failure', (t) => {
  const store = storeFor(t);
  assert.deepEqual(store.snapshot(), { room: null, revision: 'empty' });
  store.replace(room());
  const before = store.snapshot();
  const changed = store.snapshot();
  changed.room.bindings[0].position.x = 999;
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(new RoomSceneStore(store.file).load().snapshot(), before);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  const write = t.mock.method(store, 'writeJson', () => { throw new Error('disk full'); });
  assert.throws(() => store.replace({ ...room(), name: 'Another' }), /disk full/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(new RoomSceneStore(store.file).load().snapshot(), before);
  write.mock.restore();
  store.replace(null);
  assert.deepEqual(new RoomSceneStore(store.file).load().snapshot(), { room: null, revision: 'empty' });
});

test('invalid stored room is quarantined instead of erasing recoverable data', (t) => {
  const store = storeFor(t);
  fs.writeFileSync(store.file, '{"version":1,"name":"incomplete"}');
  t.mock.method(console, 'warn', () => {});
  store.load();
  assert.equal(store.snapshot().room, null);
  const files = fs.readdirSync(path.dirname(store.file));
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith('stage-room.json.invalid-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(store.file), files[0]))).name, 'incomplete');
});

test('room API protects private geometry, supports caching and prevents stale replacement/deletion', async (t) => {
  const store = storeFor(t);
  const app = express();
  app.use('/api', createAuth({ token: 'room-test-token' }).httpMiddleware);
  app.use(express.json({ limit: '1mb' }));
  attachRoomSceneRoutes(app, store);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ ok: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/stage/room`;
  const auth = { 'X-Lightshow-Token': 'room-test-token', 'Content-Type': 'application/json' };
  const request = (method, data, headers = {}) => fetch(url, { method, headers: { ...auth, ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await fetch(url)).status, 401);
  const initial = await (await request('GET')).json();
  assert.equal(initial.revision, 'empty');
  assert.equal((await request('PUT', room())).status, 428);
  assert.equal((await request('PUT', room(), { 'If-Match': 'stale' })).status, 412);
  const imported = await request('PUT', room(), { 'If-Match': 'empty' });
  assert.equal(imported.status, 200);
  const saved = await imported.json();
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(imported.headers.get('etag'), `"${saved.revision}"`);
  const cached = await request('GET', undefined, { 'If-None-Match': `"${saved.revision}"` });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  assert.equal((await request('PUT', { ...room(), url: 'http://example.invalid' }, { 'If-Match': saved.revision })).status, 400);
  assert.equal((await request('DELETE', undefined, { 'If-Match': 'empty' })).status, 412);
  assert.equal((await request('DELETE')).status, 428);
  assert.equal((await request('DELETE', undefined, { 'If-Match': `"${saved.revision}"` })).status, 200);
  assert.deepEqual(store.snapshot(), { room: null, revision: 'empty' });
});
