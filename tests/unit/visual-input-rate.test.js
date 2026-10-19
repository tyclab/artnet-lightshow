import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVisualFrame, VISUAL_INPUT_MAX_FPS } from '../../src/server/visual-input-rate.ts';

test('60 fps visual input tolerates arrival jitter without rejecting an ordinary stream', () => {
  let next = -Infinity;
  for (let i = 0; i < 600; i++) {
    const now = i * 1000 / VISUAL_INPUT_MAX_FPS + (i % 3 - 1) * 3;
    next = nextVisualFrame(now, next);
    assert.notEqual(next, null, `frame ${i}`);
  }
});

test('arrival credit stays bounded through floods and long pauses', () => {
  let next = -Infinity, accepted = 0;
  for (let now = 0; now < 1000; now++) {
    const update = nextVisualFrame(now, next);
    if (update !== null) { next = update; accepted++; }
  }
  assert.ok(accepted >= 60 && accepted <= 61, `${accepted} accepted frames`);
  next = nextVisualFrame(100000, next);
  assert.notEqual(next, null);
  assert.equal(nextVisualFrame(100000, next), null, 'idle time does not accumulate a burst budget');
});
