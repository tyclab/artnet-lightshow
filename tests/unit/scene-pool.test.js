// The one 3D stage that outlives the views showing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenePool } from '../../public-src/stage3d/scene-pool.js';

test('one stage scene is kept for the next view; a second is released with its WebGL context', () => {
  const made = (name) => {
    const entry = { name, disposed: 0, canvas: { removed: 0, remove() { this.removed++; } } };
    entry.scene = { dispose: () => { entry.disposed++; } };
    return entry;
  };
  const pool = createScenePool();
  assert.equal(pool.take(), null);
  const first = made('first'), second = made('second');
  pool.give(first);
  assert.equal(first.canvas.removed, 1, 'detached from the view that closed');
  assert.equal(first.disposed, 0);
  pool.give(second);
  assert.equal(second.disposed, 1, 'only one kept: the other is disposed');
  assert.equal(pool.take(), first);
  assert.equal(pool.take(), null);
});
