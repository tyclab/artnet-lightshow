import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMirror } from '../state.js';
export function snapshot() {
  return { protocol: 2, versions: { rig: 1, look: 1 }, state: {
    armed: true, clock: { bpm: 120, beatPos: 1, at: 1 }, safety: { photosensitivityAcknowledged: true },
    fixtures: [{ id: 53, profileId: 'panel', output: { protocol: 'ddp', host: 'example.invalid' } }],
    profiles: { panel: { grid: { columns: 2, rows: 1 }, cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }, { channelMap: { red: 3, green: 4, blue: 5 } }] } },
  } };
}
const options = { fixtureId: 53, width: 2, height: 1 };
test('fresh snapshot, armed state, acknowledgement and current complete grid are required', () => {
  let now = 0; const mirror = new StateMirror(() => now);
  assert.equal(mirror.target(options).ok, false);
  mirror.snapshot(snapshot()); assert.equal(mirror.target(options).ok, true);
  now = 1500; assert.equal(mirror.target(options).ok, false);
  for (const edit of [s => { s.state.armed = false; }, s => { s.state.clock = null; }, s => { s.state.safety.photosensitivityAcknowledged = false; }, s => { s.state.profiles.panel.zoned = true; }, s => { s.state.profiles.panel.cells[1].at = { x: 0, y: 0 }; }, s => { delete s.state.profiles.panel.cells[0].channelMap.blue; }, s => { s.state.fixtures[0].output.protocol = 'openrgb'; }]) {
    const value = snapshot(); edit(value); mirror.snapshot(value); assert.equal(mirror.target(options).ok, false);
  }
});
test('patch gaps and reconnect invalidate state; patches alone cannot renew freshness', () => {
  let now = 0; const mirror = new StateMirror(() => now);
  mirror.snapshot(snapshot());
  assert.equal(mirror.patch({ d: 'rig', v: 2, set: { armed: false } }), true);
  assert.equal(mirror.target(options).ok, false);
  assert.equal(mirror.patch({ d: 'rig', v: 4, set: { armed: true } }), false);
  assert.equal(mirror.target(options).ok, false);
  mirror.snapshot(snapshot()); now = 1500;
  mirror.patch({ d: 'look', v: 2, set: { clock: { bpm: 120, beatPos: 2, at: 2 } } });
  assert.equal(mirror.target(options).ok, false);
  mirror.snapshot(snapshot()); assert.equal(mirror.target(options).ok, true);
  mirror.reset(); assert.equal(mirror.target(options).ok, false);
});
test('route changes alter target identity without logging endpoint data', () => {
  const mirror = new StateMirror(); mirror.snapshot(snapshot()); const before = mirror.target(options).key;
  const next = snapshot(); next.state.fixtures[0].output.at = 5; mirror.snapshot(next);
  assert.notEqual(mirror.target(options).key, before);
});
