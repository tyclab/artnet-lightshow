// The room kept between views (public-src/stage-room.js): asked again on every
// mount, downloaded again only when the server's revision moved on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAudited } from '../helpers/render-audit.js';

const ui = await loadAudited("export { knownRoom, loadRoom, rememberRoom } from './public-src/stage-room.js';");

function server(snapshot) {
  const asked = [];
  globalThis.fetch = async (path, init = {}) => {
    const tag = init.headers && init.headers['If-None-Match'];
    asked.push(tag ?? null);
    if (tag === `"${snapshot.revision}"`) return { ok: false, status: 304, json: async () => { throw new Error('no body'); } };
    return { ok: true, status: 200, json: async () => ({ ok: true, ...structuredClone(snapshot) }) };
  };
  return { asked, set: (next) => { snapshot = next; } };
}

test('a room is downloaded once, then revalidated, and the same object kept while it is unchanged', async () => {
  const room = { version: 1, name: 'Kept', objects: [] };
  const fake = server({ room, revision: 'r1' });
  const first = await ui.loadRoom();
  assert.equal(first.ok, true);
  assert.deepEqual(first.room, room);
  const again = await ui.loadRoom();
  assert.equal(again.room, first.room, 'unchanged: the kept object, so nothing built from it is rebuilt');
  assert.deepEqual(fake.asked, [null, '"r1"']);

  fake.set({ room: { ...room, name: 'Moved' }, revision: 'r2' });
  const changed = await ui.loadRoom();
  assert.equal(changed.room.name, 'Moved');
  assert.equal(ui.knownRoom().revision, 'r2');
});

test('a saved room is kept, so the next view starts from it', async () => {
  const fake = server({ room: null, revision: 'empty' });
  ui.rememberRoom({ ok: true, room: null, revision: 'empty' });
  assert.deepEqual(ui.knownRoom(), { room: null, revision: 'empty' });
  ui.rememberRoom({ ok: false, error: 'stale' });
  assert.deepEqual(ui.knownRoom(), { room: null, revision: 'empty' }, 'a refused save keeps what was there');
  const loaded = await ui.loadRoom();
  assert.equal(loaded.room, null);
  assert.deepEqual(fake.asked, ['"empty"']);
});

/** A server whose answers wait until the test releases them, in any order. */
function heldServer() {
  const pending = [];
  globalThis.fetch = (path, init = {}) => new Promise((resolve) => {
    pending.push({ tag: (init.headers && init.headers['If-None-Match']) ?? null, answer: (snapshot) => resolve(snapshot === 304
      ? { ok: false, status: 304, json: async () => { throw new Error('no body'); } }
      : { ok: true, status: 200, json: async () => ({ ok: true, ...structuredClone(snapshot) }) }) });
  });
  return pending;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a load answered after a save does not rewind the kept room to the older revision', async () => {
  ui.rememberRoom({ ok: true, room: { name: 'Old' }, revision: 'old' });
  const pending = heldServer();
  const loading = ui.loadRoom();
  await settle();
  ui.rememberRoom({ ok: true, room: { name: 'Saved' }, revision: 'saved' });
  pending[0].answer({ room: { name: 'Old, read before the save' }, revision: 'old-2' });
  const loaded = await loading;
  assert.equal(ui.knownRoom().revision, 'saved', 'the save stays the kept room');
  assert.equal(loaded.room, ui.knownRoom().room);
});

test('two loads answered with the same revision keep one room object', async () => {
  ui.rememberRoom({ ok: true, room: { name: 'Before' }, revision: 'before' });
  const pending = heldServer();
  const first = ui.loadRoom();
  const second = ui.loadRoom();
  await settle();
  pending[0].answer({ room: { name: 'Next' }, revision: 'next' });
  pending[1].answer({ room: { name: 'Next' }, revision: 'next' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.room, b.room, 'one object for one revision, so nothing built from it is built twice');
  assert.equal(ui.knownRoom().room, a.room);
});

test('a 200 for the revision already kept keeps the kept object', async () => {
  const kept = ui.rememberRoom({ ok: true, room: { name: 'Same' }, revision: 'same' });
  const pending = heldServer();
  const loading = ui.loadRoom();
  await settle();
  pending[0].answer({ room: { name: 'Same' }, revision: 'same' });
  assert.equal((await loading).room, kept.room);
});
