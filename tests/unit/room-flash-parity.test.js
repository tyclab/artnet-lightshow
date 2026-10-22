import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { fixtureLuminance } from '../../src/shared/room-flash.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';

const bulb = { id: 'parity-bulb', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const surface = { id: 'parity-surface', channelCount: 192, channelMap: {}, cells: Array.from({ length: 64 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) };
const profiles = { [bulb.id]: bulb, [surface.id]: surface };
const fixtures = [surface, bulb].map((profile, i) => ({ id: i + 1, address: i ? 200 : 1,
  universe: 0, profileId: profile.id, maxBrightness: i ? 180 : 255, output: { protocol: 'ddp' } }));

test('fixture brightness averages cells before room weighting', () => {
  const white = { r: 255, g: 255, b: 255 };
  const many = Array.from({ length: 64 }, (_, i) => ({ col: white, dim: i < 16 ? 255 : 0 }));
  const bright = fixtureLuminance([{ col: white, dim: 255 }], bulb, null, 1);
  const patch = fixtureLuminance(many, surface, surface.cells.map((cell) => cell.channelMap), 1);
  assert.ok(Math.abs((bright + patch) / 2 - 0.625) < 1e-9, 'one bulb and one surface each contribute half the room estimate');
});

for (const pattern of ['hit', 'chase']) test(`room flash limiter keeps ${pattern} preview and output aligned`, () => {
  const renderer = createRenderer({ profileOf: (fixture) => profiles[fixture.profileId], profilesRevision: () => 0, now: 0 });
  const rig = buildRig(fixtures, (fixture) => profiles[fixture.profileId]), store = createUniverseStore(allocateShared());
  const look = { pattern, colorA: 1, colorB: 1, colorC: 1, colorD: 1, bpm: 180, beatDivision: 4, flashLimit: true };
  const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: look }], null, { profiles });
  const unbounded = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, flashLimit: false } }], null, { profiles });
  const input = { ...look, running: true, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
    masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
    fade: null, syncTest: null, universes: [0], fixtures };
  let limitedFrames = 0;
  const saved = new Map();
  for (let tick = 0; tick < 176; tick++) {
    const now = tick * (1000 / 44);
    renderer.frame(input, { beatPos: now * 180 / 60000, bpm: 180, epoch: 0 }, now, store, 0);
    const visible = preview(now, fixtures, COLOR_PRESETS, rig), free = unbounded(now, fixtures, COLOR_PRESETS, rig);
    const bytes = store.getBuffer(0);
    for (let u = 0; u < rig.units.length; u++) {
      const { fixture: i, cell } = rig.units[u], map = rig.cellMaps[i]?.[cell] ?? profiles[fixtures[i].profileId].channelMap;
      for (const channel of ['r', 'g', 'b']) {
        const wire = bytes[fixtures[i].address - 1 + map[{ r: 'red', g: 'green', b: 'blue' }[channel]]];
        assert.ok(Math.abs(wire - visible[u][channel]) <= 1, `frame ${tick}, unit ${u}, ${channel}: output ${wire}, preview ${visible[u][channel]}`);
      }
    }
    if (visible.some((colour, u) => Math.abs(colour.r - free[u].r) > 2)) limitedFrames++;
    if (tick % 17 === 0) saved.set(now, visible);
  }
  if (pattern === 'hit') assert.ok(limitedFrames > 10, 'room limiting actually changes the otherwise rapid pulses');
  for (const [now, expected] of [...saved].reverse()) assert.deepEqual(preview(now, fixtures, COLOR_PRESETS, rig), expected, 'seeks clone room flash history');
});
