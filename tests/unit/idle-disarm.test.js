// Outputs left armed with nothing playing disarm themselves after
// outputs.idleDisarmMin (src/server/idle-disarm.ts), ticked every 10 s as in main.ts.
// Which sources count as playing is main.ts's predicate, which no test imports: here it is one flag.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createIdleDisarm } from '../../src/server/idle-disarm.ts';
import { SettingsStore } from '../../src/server/settings.ts';

const TICK = 10_000;
const MIN = 60_000;

/** Armed at 0 on a fake clock with nothing playing. Its disarm only records: the arm is the test's to drop. */
function rig(minutes = 15) {
  const r = { at: 0, armed: true, playing: false, minutes, fails: 0, disarms: [] };
  const idle = createIdleDisarm({
    now: () => r.at,
    armed: () => r.armed,
    playing: () => r.playing,
    minutes: () => r.minutes,
    disarm: (m) => {
      if (r.fails-- > 0) throw new Error('save failed');
      r.disarms.push({ at: r.at, minutes: m });
    },
  });
  idle.tick();
  r.wait = (ms) => { for (const end = r.at + ms; r.at < end;) { r.at += TICK; idle.tick(); } };
  return r;
}

test('armed with nothing playing: disarmed exactly once, at the limit; arming again starts afresh', () => {
  const r = rig();
  r.wait(15 * MIN - TICK);
  assert.deepEqual(r.disarms, []);
  r.wait(TICK);
  assert.deepEqual(r.disarms, [{ at: 15 * MIN, minutes: 15 }]);
  r.wait(60 * MIN);
  assert.equal(r.disarms.length, 1, 'once per idle period, even with the arm still standing');
  r.armed = false;
  r.wait(TICK);
  r.armed = true;
  r.wait(15 * MIN);
  assert.equal(r.disarms.length, 1, 'armed again: 15 fresh minutes from the tick that saw it (75:20)');
  r.wait(TICK);
  assert.deepEqual(r.disarms.at(-1), { at: 90 * MIN + 2 * TICK, minutes: 15 });
});

test('anything playing starts the idle period over', () => {
  const r = rig();
  r.wait(14 * MIN);
  r.playing = true;
  r.wait(60 * MIN);
  r.playing = false;
  r.wait(15 * MIN);
  assert.deepEqual(r.disarms, [], 'never while it plays, and a full period after it stopped');
  r.wait(TICK);
  assert.deepEqual(r.disarms, [{ at: 89 * MIN + TICK, minutes: 15 }]);
});

test('a disarm that throws runs again on the next tick', () => {
  const r = rig();
  r.fails = 1;
  r.wait(15 * MIN - TICK);
  assert.throws(() => r.wait(TICK), /save failed/);
  r.wait(TICK);
  assert.deepEqual(r.disarms, [{ at: 15 * MIN + TICK, minutes: 15 }]);
});

test('a manual disarm cancels the period', () => {
  const r = rig();
  r.wait(14 * MIN);
  r.armed = false;
  r.wait(TICK);
  r.armed = true;
  r.wait(15 * MIN - TICK);
  assert.deepEqual(r.disarms, [], 'the 14 idle minutes before it are gone');
});

test('a limit of 0 never fires and drops the period it was in', () => {
  const r = rig(0);
  r.wait(24 * 60 * MIN);
  r.minutes = 15;
  r.wait(14 * MIN);
  r.minutes = 0;
  r.wait(TICK);
  r.minutes = 15;
  r.wait(15 * MIN - TICK);
  assert.deepEqual(r.disarms, []);
});

test('outputs.idleDisarmMin: 15 by default, whole minutes up to a day, stored', () => {
  const s = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-idle-disarm-')), 'settings.json')).load();
  assert.equal(s.get('outputs.idleDisarmMin'), 15);
  for (const bad of [-1, 2.5, 1441, '15']) assert.throws(() => s.update({ outputs: { idleDisarmMin: bad } }), String(bad));
  assert.deepEqual(s.update({ outputs: { idleDisarmMin: 0 } }), ['outputs.idleDisarmMin']);
  assert.equal(new SettingsStore(s.file).load().get('outputs.idleDisarmMin'), 0);
  fs.writeFileSync(s.file, JSON.stringify({ outputs: { armed: false } }));
  assert.equal(new SettingsStore(s.file).load().get('outputs.idleDisarmMin'), 15, 'a file from before it');
});
