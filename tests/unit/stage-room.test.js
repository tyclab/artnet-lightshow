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
