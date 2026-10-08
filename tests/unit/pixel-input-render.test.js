import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { ddpRoutes } from '../../src/server/ddp-routes.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { hrtimeMs } from '../../src/server/frame-clock.ts';

const grid = (width, height, reverse = false) => ({
  id: 'pixel-input-grid', name: 'Screen', channelCount: width * height * 3, channelMap: {}, grid: { columns: width, rows: height },
  cells: Array.from({ length: width * height }, (_, i) => ({
    at: { x: reverse ? width - 1 - i % width : i % width, y: Math.floor(i / width) },
    channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 },
  })),
});
const par = { id: 'pixel-input-par', name: 'Other lamp', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixture = (id, profileId, universe) => ({ id, profileId, address: 1, universe, maxBrightness: 255,
  override: null, hue: false, position: null, group: null, geometry: null, output: { protocol: 'ddp', host: '127.0.0.1' } });
const base = (profile, patch = {}) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 },
  universes: profile.channelCount > 512 ? [1, 2, 10] : [1, 10], fixtures: [fixture(53, profile.id, 1), fixture(54, par.id, 10)], ...patch,
});
const frame = (profile, data, expiresAt = 2000) => ({ fixtureId: 53, leaseId: 'test', width: profile.grid.columns,
  height: profile.grid.rows, expiresAt, data: Uint8Array.from(data) });
function rig(profile) {
  const lookup = f => f.profileId === profile.id ? profile : par;
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: lookup, profilesRevision: () => 0, now: 0 });
  return { renderer, store, lookup, draw(now, patch = {}) {
    const input = base(profile, patch);
    renderer.frame(input, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, 0);
    const read = channelReader(1, 1, profile, u => store.getBuffer(u));
    return { pixels: profile.cells.flatMap(c => ['red', 'green', 'blue'].map(k => read(c.channelMap[k]))), other: [...store.getBuffer(10).slice(0, 3)] };
  } };
}

test('external RGB follows the profile grid and channel mapping across universes; other fixtures are identical', () => {
  const profile = grid(17, 11, true), r = rig(profile);
  const data = Uint8Array.from({ length: 17 * 11 * 3 }, (_, i) => (i * 13 + 7) % 256);
  const before = r.draw(100), after = r.draw(100, { pixelInputs: [frame(profile, data)] });
  const expected = profile.cells.flatMap(({ at }) => [...data.slice((at.y * 17 + at.x) * 3, (at.y * 17 + at.x) * 3 + 3)]);
  assert.deepEqual(after.pixels, expected);
  assert.deepEqual(after.other, before.other);
  assert.ok(r.store.getBuffer(2).some(v => v !== 0));
});

test('pixels obey master, fixture trim, manual override, fixture blackout and master blackout', () => {
  const p = grid(2, 1), pixels = [frame(p, [255, 128, 64, 80, 160, 240])], fixtures = base(p).fixtures;
  fixtures[0].maxBrightness = 128;
  assert.deepEqual(rig(p).draw(100, { pixelInputs: pixels, fixtures, masterDimmer: 128 }).pixels, [64, 32, 16, 20, 40, 60]);
  fixtures[0].maxBrightness = 255;
  fixtures[0].override = { enabled: true, blackout: false, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  assert.deepEqual(rig(p).draw(100, { pixelInputs: pixels, fixtures }).pixels, [0, 255, 0, 0, 255, 0]);
  fixtures[0].override.blackout = true;
  assert.deepEqual(rig(p).draw(100, { pixelInputs: pixels, fixtures }).pixels, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rig(p).draw(100, { pixelInputs: pixels, masterBlackout: true }).pixels, [0, 0, 0, 0, 0, 0]);
});

test('stream does not inherit legacy strobe and safety revocation restores the authored look', () => {
  const p = grid(2, 1), r = rig(p), data = [10, 20, 30, 40, 50, 60];
  for (let now = 0; now < 1000; now += 25) assert.deepEqual(r.draw(now, {
    pattern: 'strobe', strobeSpeed: 255, pixelInputs: [frame(p, data)],
  }).pixels, data);
  const baseline = rig(p).draw(100).pixels;
  assert.deepEqual(rig(p).draw(100, { pixelInputs: [frame(p, data)], safety: { acknowledged: false, hdFlashIntervalMs: 350 } }).pixels, baseline);
});

test('expired or incompatible frames fall back to the running authored look', () => {
  const p = grid(2, 1), r = rig(p), pixels = [frame(p, [1, 2, 3, 4, 5, 6], 100)];
  assert.deepEqual(r.draw(99, { pixelInputs: pixels }).pixels, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.draw(100, { pixelInputs: pixels }).pixels, rig(p).draw(100).pixels);
  assert.deepEqual(r.draw(50, { pixelInputs: [{ ...pixels[0], width: 1, height: 2 }] }).pixels, rig(p).draw(50).pixels);
});

test('manual kill and identify retain priority over screen pixels', () => {
  const p = grid(2, 1), pixelInputs = [frame(p, [12, 34, 56, 12, 34, 56])];
  const kill = { id: 'manual-kill', spec: { kind: 'energy.kill' }, targets: [53], tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: seedFrom('kill') };
  assert.deepEqual(rig(p).draw(100, { pixelInputs, voices: [kill] }).pixels, [0, 0, 0, 0, 0, 0]);
  const identify = { seq: 1, ids: [53], ms: 1000, at: 0 };
  const expected = rig(p).draw(100, { identify }).pixels;
  assert.notDeepEqual(expected, [12, 34, 56, 12, 34, 56]);
  assert.deepEqual(rig(p).draw(100, { pixelInputs, identify }).pixels, expected);
});

test('screen frames pass through hardware flash limits and the optional large-area limiter', () => {
  const p = grid(2, 1), r = rig(p);
  const hardware = { technologies: { ddp: { maxFlashHz: 2, minTransitionMs: 0 } }, products: {} };
  const draw = (now, value) => r.draw(now, { hardware, pixelInputs: [frame(p, Array(6).fill(value))] }).pixels;
  assert.deepEqual(draw(0, 255), Array(6).fill(255));
  assert.deepEqual(draw(50, 0), Array(6).fill(0));
  assert.deepEqual(draw(100, 255), Array(6).fill(0));
  assert.deepEqual(draw(550, 255), Array(6).fill(255));
  const guarded = rig(p), unguarded = rig(p); let changed = false;
  for (let now = 0; now <= 1800; now += 50) {
    const pixelInputs = [frame(p, Array(6).fill(now % 100 === 0 ? 255 : 0))];
    const a = guarded.draw(now, { pixelInputs, flashLimit: true }).pixels;
    const b = unguarded.draw(now, { pixelInputs, flashLimit: false }).pixels;
    if (a.some((v, i) => v !== b[i])) changed = true;
  }
  assert.ok(changed, 'large-area guard must still affect streamed video');
});

test('existing transmitter emits no streamed pixels while disarmed', () => {
  const p = grid(2, 1), r = rig(p); r.draw(100, { pixelInputs: [frame(p, Array(6).fill(255))] });
  const sent = [], wire = (...args) => { sent.push(args); return true; };
  const tx = createTransmitter({ wires: { artnet: wire, artnetSync: wire, sacn: wire, sacnDiscovery: wire, ddp: wire, openrgb: wire, openrgbClose: wire } });
  const routes = ddpRoutes([base(p).fixtures[0]], r.lookup, f => f.universe);
  const config = { armed: false, artnet: { enabled: false }, delayMs: 0, ddp: routes };
  assert.deepEqual(tx.send(1, r.store.getBuffer(1), config), []); tx.endFrame(config);
  assert.equal(sent.length, 0);
});

test('real worker matches main rendering and expires its retained pixel snapshot without new input', async t => {
  const p = grid(17, 11, true), r = rig(p), data = Uint8Array.from({ length: 561 }, (_, i) => i % 256);
  const worker = new Worker(new URL('../../src/server/engine-worker.ts', import.meta.url), {
    workerData: { shared: allocateShared(), capture: true, startNow: 0 },
  });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  worker.postMessage({ type: 'profiles', profiles: [p, par] });
  const input = base(p, { pixelInputs: [frame(p, data, 100)] });
  for (const now of [50, 101]) {
    const local = r.draw(now, { pixelInputs: input.pixelInputs });
    const response = once(worker, 'message');
    worker.postMessage({ type: 'render', id: now, input, reading: { beatPos: now / 500, bpm: 120, epoch: 0 }, now, gridOriginMs: 0 });
    const [message] = await response;
    assert.equal(message.type, 'rendered');
    for (const universe of input.universes) assert.deepEqual(message.frames[universe], [...r.store.getBuffer(universe)]);
    if (now > 100) assert.deepEqual(local.pixels, rig(p).draw(now).pixels);
  }
});

test('running worker releases the screen when the control thread stops sending snapshots', async t => {
  const p = grid(2, 1), shared = allocateShared(), store = createUniverseStore(shared, { readOnly: true });
  const worker = new Worker(new URL('../../src/server/engine-worker.ts', import.meta.url), { workerData: { shared } });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  worker.postMessage({ type: 'profiles', profiles: [p, par] });
  const now = hrtimeMs(), expiresAt = now + 750;
  worker.postMessage({ type: 'snapshot', at: now, input: base(p, { pixelInputs: [frame(p, [0, 255, 0, 0, 255, 0], expiresAt)] }),
    reading: { beatPos: 0, bpm: 120, epoch: 0, moving: true }, outputs: { armed: false, artnet: { enabled: false }, delayMs: 0 } });
  while (store.getBuffer(1)[1] !== 255 && hrtimeMs() < expiresAt) await new Promise(r => setTimeout(r, 5));
  assert.equal(store.getBuffer(1)[1], 255, 'worker displayed the accepted screen');
  while (store.getBuffer(1)[1] === 255 && hrtimeMs() < expiresAt + 2000) { /* no control callbacks can run here */ }
  assert.ok(hrtimeMs() >= expiresAt);
  assert.deepEqual([...store.getBuffer(1).slice(0, 6)], [255, 0, 0, 255, 0, 0], 'worker independently restored its base');
});
