import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { SRGB_DECODE } from '../../src/shared/color.ts';
import { blackPointGain } from '../../src/shared/picture-grade.ts';

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
// The picture's bytes drive each unit as sent (no decode, no black point unless the input asks), then the masters.
const sent = (bytes, gain = 1) => bytes.map((v) => Math.round(v * gain));
const linear = (bytes) => bytes.map((v) => Math.round(SRGB_DECODE[v]));
// One unit's three bytes through the black point: the peak sets the gain, all three take it.
const lifted = (bytes, blackPoint, gain = 1) => bytes.map((v) => Math.round(v * blackPointGain(Math.max(...bytes), blackPoint) * gain));

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
  assert.deepEqual(painted.par, colours.slice(0, 3));
  assert.deepEqual(painted.bar, colours.slice(3, 9));
  assert.deepEqual(painted.grid, plain.grid);
  const decoded = r.draw(100, { picture: picture(colours), pictureDecode: true });
  assert.deepEqual(decoded.par, linear(colours.slice(0, 3)), 'decode on: the linear light the bytes stand for');
  assert.deepEqual(decoded.bar, linear(colours.slice(3, 9)));
  assert.deepEqual(decoded.grid, plain.grid);
});

test('the black point darkens the units at or under it and ramps the rest, hue kept, before the masters', () => {
  const r = rig(), at = (blackPoint, patch = {}) => r.draw(100, { picture: picture(colours), pictureBlackPoint: blackPoint, ...patch });
  // The par's peak is 30, the threshold byte at 0.12: off. The bar's cells peak at 60 and 90: lifted.
  const lifted12 = at(0.12);
  assert.deepEqual(lifted12.par, [0, 0, 0]);
  assert.deepEqual(lifted12.bar, [...lifted([40, 50, 60], 0.12), ...lifted([70, 80, 90], 0.12)]);
  assert.deepEqual(lifted12.bar, [22, 28, 33, 53, 60, 68]);
  assert.ok(lifted12.bar.every((v, i) => v < colours[3 + i]), 'every lit byte ramps down');
  assert.ok(Math.abs(lifted12.bar[0] / lifted12.bar[2] - 40 / 60) < 0.03 && Math.abs(lifted12.bar[3] / lifted12.bar[5] - 70 / 90) < 0.03, 'the ratios hold');
  assert.deepEqual(at(0.12, { masterDimmer: 128 }).bar, [...lifted([40, 50, 60], 0.12, 128 / 255), ...lifted([70, 80, 90], 0.12, 128 / 255)], 'the master applies after the lift');
  assert.deepEqual(at(0).par, colours.slice(0, 3), 'zero: every byte as sent');
  assert.deepEqual(at(0).bar, colours.slice(3, 9));
  assert.deepEqual(at(0.5).bar, [0, 0, 0, 0, 0, 0], 'half: 90 is under 127.5');
  const bright = picture([255, 128, 0, 31, 0, 0, 200, 100, 50, 0, 0, 0, 0, 0, 0]);
  const lit = r.draw(100, { picture: bright, pictureBlackPoint: 0.12 });
  assert.deepEqual(lit.par, [255, 128, 0], 'a full peak stays as sent');
  assert.deepEqual(lit.bar, [0, 0, 0, ...lifted([200, 100, 50], 0.12)], '31 lights, but rounds to nothing on the wire');
});

test('voices and overrides stay above the picture; the master dimmer and blackout still apply', () => {
  const fx = fixtures();
  fx[0].override = { enabled: true, blackout: false, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const out = rig().draw(100, { picture: picture(colours), fixtures: fx });
  assert.deepEqual(out.par, [0, 255, 0]);
  assert.deepEqual(out.bar, colours.slice(3, 9));
  assert.deepEqual(rig().draw(100, { picture: picture(colours), masterDimmer: 128 }).bar, sent(colours.slice(3, 9), 128 / 255));
  assert.deepEqual(rig().draw(100, { picture: picture(colours), masterBlackout: true }).bar, [0, 0, 0, 0, 0, 0]);
});

test('an expired, mis-sized or unacknowledged picture falls back to the effect', () => {
  const r = rig(), plain = r.draw(100);
  assert.deepEqual(r.draw(2000, { picture: picture(colours, 2000) }).par, rig().draw(2000).par);
  assert.deepEqual(r.draw(100, { picture: picture(colours.slice(0, 12)) }).par, plain.par);
  assert.deepEqual(r.draw(100, { picture: picture(colours), safety: { acknowledged: false, hdFlashIntervalMs: 350 } }).par, plain.par);
  assert.deepEqual(r.draw(100, { picture: null }).par, plain.par);
});
