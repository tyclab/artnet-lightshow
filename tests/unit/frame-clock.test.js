import test from 'node:test';
import assert from 'node:assert';

import { FRAME_MS, FRAME_RATE, MAX_BEHIND_FRAMES, hrtimeMs, nextIndex, FrameStats, createTicker } from '../../src/server/frame-clock.ts';

test('the frame grid runs at forty-four frames a second', () => {
  assert.strictEqual(FRAME_RATE, 44);
  assert.ok(Math.abs(FRAME_MS - 1000 / 44) < 1e-9);
});

test('nextIndex finds the first deadline at or after a time', () => {
  assert.strictEqual(nextIndex(0, 0, 0, 10), 0);
  assert.strictEqual(nextIndex(10, 0, 0, 10), 1);
  assert.strictEqual(nextIndex(10.5, 0, 0, 10), 2);
  assert.strictEqual(nextIndex(15, 0, 6, 10), 1, 'phase shifts the grid');
  assert.strictEqual(nextIndex(-50, 0, 0, 10), 0, 'never before the epoch');
});

/**
 * A ticker on a fake clock and fake timers, so each firing can land exactly
 * where the test says: `lateBy(k)` is how late firing k is.
 */
function drive({ firings, lateBy = () => 0, phaseMs = 0, periodMs = 10 }) {
  let t = 1000;
  const pending = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => { const h = { fn, at: t + delay }; pending.push(h); return h; };
  globalThis.clearTimeout = (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); };
  const ticks = [];
  let ticker;
  try {
    ticker = createTicker({ periodMs, phaseMs, epochMs: 1000, now: () => t, onTick: (due, now) => ticks.push({ due, now }) });
    ticker.start();
    for (let k = 0; k < firings && pending.length; k++) {
      const h = pending.shift();
      t = Math.max(t, h.at) + lateBy(k);
      h.fn();
    }
    ticker.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return { ticks, stats: ticker.stats };
}

test('deadlines stay on the grid however late each frame fires', () => {
  const { ticks } = drive({ firings: 6, lateBy: (k) => [3, 0, 7, 1, 0, 4][k] });
  assert.deepStrictEqual(ticks.map((x) => x.due), [1000, 1010, 1020, 1030, 1040, 1050]);
});

test('a late frame does not push the next one later', () => {
  const { ticks } = drive({ firings: 3, lateBy: (k) => (k === 0 ? 8 : 0) });
  // Frame 1 was due at 1010 and armed from 1008: it fires on time.
  assert.strictEqual(ticks[1].now, 1010);
});

// Node keeps its timers in whole milliseconds of its loop clock, so a real
// timer goes off up to a millisecond or two before a deadline on hrtime. Armed
// from that deadline rather than from the time it went off, the next frame
// inherited the hair and added its own: the frames ran ahead of their
// deadlines without bound, 44.7 a second, 155 ms ahead after ten seconds.
test('a frame a hair early does not make the next one earlier', () => {
  const { ticks } = drive({ firings: 200, lateBy: () => -0.5 });
  const early = Math.max(...ticks.map((x) => x.due - x.now));
  assert.ok(early <= 1, `${early} ms early by frame 200`);
  assert.deepStrictEqual(ticks.slice(0, 3).map((x) => x.due), [1000, 1010, 1020]);
});

// A real timer comes due on libuv's loop clock, whole milliseconds that can
// trail hrtime, and on a loaded runner it went off more than the slack before
// its deadline: the frame must still wait for it, once, and not count as early.
test('a timer three milliseconds early waits for its deadline', () => {
  const { ticks, stats } = drive({ firings: 4, lateBy: (k) => (k === 1 ? -3 : 0) });
  assert.deepStrictEqual(ticks.map((x) => x.now), [1000, 1010, 1020]);
  assert.deepStrictEqual(ticks.map((x) => x.due), [1000, 1010, 1020]);
  assert.strictEqual(stats.totalFrames, 3, 'the early wake-up is not a frame');
  assert.strictEqual(stats.summary().lateMs.max, 0);
});

test('a timer inside the slack still serves its frame at once', () => {
  const { ticks, stats } = drive({ firings: 3, lateBy: (k) => (k === 1 ? -1 : 0) });
  assert.deepStrictEqual(ticks.map((x) => x.now), [1000, 1009, 1020]);
  assert.deepStrictEqual(ticks.map((x) => x.due), [1000, 1010, 1020]);
  assert.strictEqual(stats.totalFrames, 3);
});

// A test that mocks the timers hands the ticker a `now` that moves with them:
// each wake-up is then a frame on its deadline, a whole period after the last.
test('on a clock that moves with mocked timers, the frames come a period apart', () => {
  const delays = [];
  const ticks = [];
  let mock = 1000;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = [];
  globalThis.setTimeout = (fn, delay) => { delays.push(delay); const h = { fn, at: mock + delay }; pending.push(h); return h; };
  globalThis.clearTimeout = () => {};
  try {
    const ticker = createTicker({ periodMs: 10, epochMs: 1000, now: () => mock, onTick: (due, now) => ticks.push({ due, now }) });
    ticker.start();
    for (let k = 0; k < 6; k++) { const h = pending.shift(); mock = h.at; h.fn(); }
    ticker.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.deepStrictEqual(delays, [0, 10, 10, 10, 10, 10, 10]);
  assert.deepStrictEqual(ticks.map((x) => x.due), [1000, 1010, 1020, 1030, 1040, 1050]);
  assert.deepStrictEqual(ticks.map((x) => x.now), [1000, 1010, 1020, 1030, 1040, 1050]);
});

// On that clock a frame's own work moves time on too, as on a busy runner:
// however long a frame takes, up to a period, the next is armed no further
// out than a period, so a test stepping the mock a frame at a time sees one.
test('on a clock that moves with mocked timers, a slow frame never pushes the next far out', () => {
  for (const work of [0, 0.1, 0.5, 0.8, 0.9, 0.95, 0.99, 1]) {
    const delays = [];
    const dues = [];
    let mock = 1000;
    const pending = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => { delays.push(delay); pending.push({ fn, at: mock + delay }); return pending.at(-1); };
    globalThis.clearTimeout = () => {};
    try {
      const ticker = createTicker({ periodMs: FRAME_MS, epochMs: 1000, now: () => mock,
        onTick: (due) => { dues.push(due); mock += work * FRAME_MS; } });
      ticker.start();
      for (let k = 0; k < 200; k++) {
        const h = pending.shift();
        mock = Math.max(mock, h.at);
        h.fn();
      }
      ticker.stop();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    const longest = Math.max(...delays);
    assert.ok(longest <= FRAME_MS + 1e-9, `${work} of a period per frame: a frame armed ${longest.toFixed(2)} ms out`);
    assert.strictEqual(dues.length, 200, `${work} of a period per frame: every wake-up a frame`);
    dues.forEach((due, i) => assert.ok(Math.abs(due - (1000 + i * FRAME_MS)) < 1e-6, `${work} of a period per frame: frame ${i} due at ${due}`));
  }
});

test('a stall longer than a couple of frames skips ahead instead of bursting', () => {
  const { ticks, stats } = drive({ firings: 3, lateBy: (k) => (k === 0 ? 55 : 0) });
  // Due at 1000, fired at 1055: frames 0–4 are gone, frame 5 (1050) is served.
  assert.ok(55 > MAX_BEHIND_FRAMES * 10);
  assert.strictEqual(ticks[0].due, 1050);
  assert.strictEqual(ticks[1].due, 1060);
  assert.strictEqual(stats.skipped, 5);
  assert.strictEqual(stats.summary().skippedFramesTotal, 5);
  assert.strictEqual(stats.summary().skippedFramesLastMinute, 5);
});

test('a phase moves every deadline by the same amount', () => {
  const { ticks } = drive({ firings: 3, phaseMs: 4 });
  assert.deepStrictEqual(ticks.map((x) => x.due), [1004, 1014, 1024]);
});

test('stats report lateness, render time and the frames that went out late', () => {
  const stats = new FrameStats(10, 1);
  for (let i = 0; i < 90; i++) stats.record(1, 2);
  for (let i = 0; i < 10; i++) stats.record(8, 3);
  const s = stats.summary();
  assert.strictEqual(s.frames, 100);
  assert.strictEqual(s.lateMs.p50, 1);
  assert.strictEqual(s.lateMs.max, 8);
  assert.strictEqual(s.lateFrames, 10, 'more than half a period late');
  assert.strictEqual(s.renderMs.p95, 3);
});

test('stats keep a fixed window', () => {
  let now = 100;
  const stats = new FrameStats(10, 0.1, () => now);   // ten frames
  for (let i = 0; i < 25; i++) stats.record(i, 0);
  now = 350;
  const s = stats.summary();
  assert.strictEqual(s.frames, 10);
  assert.strictEqual(s.totalFrames, 25, 'lifetime count survives ring wrap');
  assert.strictEqual(s.startedAtMs, 100);
  assert.strictEqual(s.sampledAtMs, 350);
  assert.strictEqual(s.lateMs.max, 24);
  assert.strictEqual(s.lateMs.p50, 20, 'only the last ten remain');
  assert.strictEqual(new FrameStats(10, 0.1, () => now).summary().startedAtMs, 350, 'a new ticker has a distinct epoch');
});

test('a skip counts for a minute in the recent count and for good in the total', () => {
  let now = 1000;
  const stats = new FrameStats(10, 60, () => now);
  stats.skip(5, now);
  now = 31_000;
  stats.skip(2, now);
  let s = stats.summary();
  assert.strictEqual(s.skippedFramesLastMinute, 7);
  assert.strictEqual(s.skippedFramesTotal, 7);
  assert.ok(!('skippedFrames' in s), 'no field left that reads as either');
  now = 61_500;
  s = stats.summary();
  assert.strictEqual(s.skippedFramesLastMinute, 2, 'the start-up stall has aged out');
  assert.strictEqual(s.skippedFramesTotal, 7);
  stats.skip(1, now);
  assert.strictEqual(stats.summary().skippedFramesLastMinute, 3, 'a slot reused a minute on starts from nothing');
  now = 500_000;
  assert.strictEqual(stats.summary().skippedFramesLastMinute, 0);
  assert.strictEqual(stats.summary().skippedFramesTotal, 8);
});

/** Wait, a few milliseconds at a time, until `done()`; a hung loop fails after `limitMs`. */
async function until(done, what, limitMs = 10000) {
  const end = hrtimeMs() + limitMs;
  while (!done()) {
    assert.ok(hrtimeMs() < end, `still waiting for ${what} after ${limitMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// The real timers on the real clock. A count of frames in a sleep is a
// measure of how busy the machine is, not of the ticker: a loaded runner
// starves the event loop and the ticker skips what it missed, by design. So
// this measures on the clock the ticker reads (each tick's own due and now),
// waits by deadline, and stalls the loop itself, seven frames, the way the
// full suite once did, so the loaded path is proven on every run.
test('a real ticker keeps time against the wall', async () => {
  const ticks = [];
  const ticker = createTicker({ onTick: (due, now) => ticks.push({ due, now, skipped: ticker.stats.skipped }) });
  ticker.start();
  await until(() => ticks.length >= 3, 'three frames');
  const from = hrtimeMs();
  while (hrtimeMs() - from < 7 * FRAME_MS) { /* the event loop gets no turn */ }
  await until(() => ticks.length >= 13 && ticks.at(-1).now - ticks[0].now >= 300, '300 ms of frames');
  ticker.stop();
  const stoppedAt = hrtimeMs();

  const first = ticks[0];
  const last = ticks.at(-1);
  for (const [i, { due, now }] of ticks.entries()) {
    // On the 44 Hz grid, every deadline a whole number of frames from the first.
    const step = (due - first.due) / FRAME_MS;
    assert.ok(Math.abs(step - Math.round(step)) < 1e-6, `frame ${i} off the grid: ${step}`);
    if (i) assert.ok(due > ticks[i - 1].due, `frame ${i} served a deadline twice`);
    // Node keeps its timers in whole milliseconds of its loop clock, so a
    // timer can go off early; the ticker waits out any more than its two
    // milliseconds of slack, so no frame goes out earlier than that. Never
    // more than MAX_BEHIND_FRAMES periods after it: further behind, the
    // ticker skips to the latest deadline instead of running late.
    assert.ok(now - due > -2, `frame ${i} ${(due - now).toFixed(2)} ms early`);
    assert.ok(now - due <= MAX_BEHIND_FRAMES * FRAME_MS, `frame ${i} ${(now - due).toFixed(2)} ms late`);
  }
  // Every deadline between the first frame served and the last either went
  // out or was counted as skipped (a busy runner may skip some before the
  // first, too), and the stall cost at least the frames it covered beyond
  // the ones the ticker catches up.
  const steps = Math.round((last.due - first.due) / FRAME_MS) + 1;
  const skipped = last.skipped - first.skipped;
  assert.strictEqual(ticks.length + skipped, steps, 'served and skipped add up to the grid');
  assert.ok(skipped >= 7 - MAX_BEHIND_FRAMES - 1, `${skipped} skipped across a seven-frame stall`);
  // So the grid ran at the clock's rate: as far on as the wall, within what
  // one frame may be late or early.
  const drift = (last.due - first.due) - (last.now - first.now);
  assert.ok(Math.abs(drift) <= MAX_BEHIND_FRAMES * FRAME_MS + 2, `grid ${drift.toFixed(2)} ms off the wall`);

  // Stopped: nothing fires, however long the ticker's next deadline is waited
  // past. Timers run in deadline order, so once one due three frames on has
  // run, a frame the ticker had left armed would have gone first.
  const count = ticks.length;
  await until(() => hrtimeMs() - stoppedAt >= 3 * FRAME_MS, 'three frames past the stop');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(ticks.length, count, 'stop means stop');
});
