import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';

// Two RGB pars and one 2 x 1 matrix: the picture paints the pars' units, never the matrix.
const par = { id: 'picture-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const bar = { id: 'picture-bar', name: 'Bar', channelCount: 6, channelMap: {},
  cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }, { channelMap: { red: 3, green: 4, blue: 5 } }] };
const grid = { id: 'picture-grid', name: 'Screen', channelCount: 6, channelMap: {}, grid: { columns: 2, rows: 1 },
  cells: [{ at: { x: 0, y: 0 }, channelMap: { red: 0, green: 1, blue: 2 } }, { at: { x: 1, y: 0 }, channelMap: { red: 3, green: 4, blue: 5 } }] };
const profiles = { [par.id]: par, [bar.id]: bar, [grid.id]: grid };
const fixture = (id, profileId, universe, position) => ({ id, profileId, address: 1, universe, maxBrightness: 255,
  override: null, hue: false, position, group: null, geometry: null, output: { protocol: 'ddp', host: '127.0.0.1' } });
const fixtures = () => [fixture(1, par.id, 1, { x: 10, y: 50 }), fixture(2, bar.id, 2, { x: 50, y: 50 }), fixture(3, grid.id, 3, { x: 90, y: 50 })];
const base = (patch = {}) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, universes: [1, 2, 3], fixtures: fixtures(), ...patch,
});
// Units in rig order: par (1), bar (2), grid (2) = 5 units.
const picture = (data, expiresAt = 2000) => ({ leaseId: 'lease', signature: 'rig', units: 5, expiresAt, data: Uint8Array.from(data) });
const colours = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

function rig() {
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
  const read = (universe, profile) => {
    const r = channelReader(universe, 1, profile, (u) => store.getBuffer(u));
    return (profile.cells ?? [{ channelMap: profile.channelMap }]).flatMap((c) => ['red', 'green', 'blue'].map((k) => r(c.channelMap[k])));
  };
  return { draw(now, patch = {}) {
    renderer.frame(base(patch), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, 0);
    return { par: read(1, par), bar: read(2, bar), grid: read(3, grid) };
  } };
}

test('the picture paints every non-matrix unit in rig order and leaves the matrix to its effect', () => {
  const r = rig();
  const plain = r.draw(100);
  const painted = r.draw(100, { picture: picture(colours) });
  assert.deepEqual(painted.par, [10, 20, 30]);
  assert.deepEqual(painted.bar, [40, 50, 60, 70, 80, 90]);
  assert.deepEqual(painted.grid, plain.grid);
});

test('voices and overrides stay above the picture; the master dimmer and blackout still apply', () => {
  const fx = fixtures();
  fx[0].override = { enabled: true, blackout: false, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const out = rig().draw(100, { picture: picture(colours), fixtures: fx });
  assert.deepEqual(out.par, [0, 255, 0]);
  assert.deepEqual(out.bar, [40, 50, 60, 70, 80, 90]);
  assert.deepEqual(rig().draw(100, { picture: picture(colours), masterDimmer: 128 }).par, [5, 10, 15]);
  assert.deepEqual(rig().draw(100, { picture: picture(colours), masterBlackout: true }).bar, [0, 0, 0, 0, 0, 0]);
});

test('an expired, mis-sized or unacknowledged picture falls back to the effect', () => {
  const r = rig(), plain = r.draw(100);
  assert.deepEqual(r.draw(2000, { picture: picture(colours, 2000) }).par, rig().draw(2000).par);
  assert.deepEqual(r.draw(100, { picture: picture(colours.slice(0, 12)) }).par, plain.par);
  assert.deepEqual(r.draw(100, { picture: picture(colours), safety: { acknowledged: false, hdFlashIntervalMs: 350 } }).par, plain.par);
  assert.deepEqual(r.draw(100, { picture: null }).par, plain.par);
});
