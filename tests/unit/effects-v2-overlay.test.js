import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoom } from '../../src/shared/room.ts';
import { OutputGuard } from '../../src/shared/output-guard.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';
import { harness } from '../helpers/ldj-harness.js';

const slots = [Array.from({ length: 100 }, (_, i) => i), [100], [101], [102], [103]];
const room = buildRoom(104, (i) => i < 100 ? 0 : i - 99, () => 0.5, () => 0.5, null);
const lamps = buildRoom(5, (i) => i / 4, (i) => i % 2, () => 0.5, null);
room.lamps = { ...lamps, cells: room, slots, lampOf: Array.from({ length: 104 }, (_, i) => i < 100 ? 0 : i - 99), cellAlong: [] };
const litLamps = (output) => slots.map((cells) => {
  const levels = cells.map((i) => output[i]?.level ?? 0);
  assert.ok(levels.every((level) => level === levels[0]), 'a selection flashes the whole lamp');
  return levels[0] > 0;
});

for (const space of ['room', 'plan']) for (const selection of ['step', 'scatter', 'zone']) {
  test(`${space} ${selection} overlay treats a hundred-cell fixture as one lamp`, () => {
    const at = harness('strobe', room, { params: { space, selection, clock: 'wall', flashesPerSecond: 2, density: 0.2 } });
    const seen = new Set();
    for (let cycle = 0; cycle < 150; cycle++) {
      const output = at.draw({ beatPos: cycle, nowMs: cycle * 500 });
      const lit = litLamps(output);
      if (selection !== 'zone') assert.equal(lit.filter(Boolean).length, 1);
      lit.forEach((value, lamp) => { if (value) seen.add(lamp); });
      at.draw({ beatPos: cycle + 0.5, nowMs: cycle * 500 + 250 });
    }
    assert.equal(seen.size, 5, 'small lamps and the large surface all participate');
  });
}

test('scatter overlay shares flashes with bulbs while selecting compact surface patches', () => {
  const pixels = 1024, bulbs = 8, n = pixels + bulbs;
  const surface = buildRoom(n, (i) => i < pixels ? (i % 32) / 31 : (i - pixels) / 7, () => 0.5, () => 0.5, null);
  surface.lamps = { slots: [Array.from({ length: pixels }, (_, i) => i), ...Array.from({ length: bulbs }, (_, i) => [pixels + i])] };
  surface.space = {
    x: Float32Array.from({ length: n }, (_, i) => i < pixels ? (i % 32) * 0.08 - 1.28 : Math.cos((i - pixels) * Math.PI / 4) * 3),
    y: Float32Array.from({ length: n }, (_, i) => i < pixels ? Math.floor(i / 32) * 0.08 : 1),
    z: Float32Array.from({ length: n }, (_, i) => i < pixels ? -2 : Math.sin((i - pixels) * Math.PI / 4) * 3),
    size: new Float32Array(n).fill(0.04), bounds: { width: 6, depth: 6, height: 3 }, anchors: {},
    listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 },
  };
  const at = harness('strobe', surface, { params: { selection: 'scatter', space: 'room', density: 0.2, clock: 'wall', flashesPerSecond: 2 } });
  const counts = new Array(bulbs).fill(0);
  let surfaceFlashes = 0;
  for (let cycle = 0; cycle < 200; cycle++) {
    const output = at.draw({ beatPos: cycle, nowMs: cycle * 500 });
    const lit = output.slice(0, pixels).filter((slot) => slot.level > 0).length;
    if (lit) { surfaceFlashes++; assert.ok(lit > 1 && lit < pixels / 4, `compact patch: ${lit} cells`); }
    counts.forEach((_, i) => { if (output[pixels + i].level > 0) counts[i]++; });
    at.draw({ beatPos: cycle + 0.5, nowMs: cycle * 500 + 250 });
  }
  assert.ok(counts.every((count) => count >= 15), `all bulbs participate: ${counts}`);
  assert.ok(surfaceFlashes > 10 && surfaceFlashes < 100, `surface shares flashes: ${surfaceFlashes}`);
});

test('one output permit survives alternating generator and overlay voices', () => {
  const guard = new OutputGuard(0), rises = [];
  for (let tick = 0; tick < 132; tick++) {
    const now = tick * 1000 / 44, dim = tick % 2 === 0 ? 255 : 0;
    const kind = Math.floor(tick / 2) % 2 ? 'strobe' : 'v2.scatter';
    if (guard.effectLevel(0, dim, 1, kind, now) > 0) rises.push(tick);
  }
  for (let i = 5; i < rises.length; i++) assert.ok(rises[i] - rises[i - 5] >= 44, `${rises}`);
  const copied = guard.clone();
  assert.equal(copied.effectLevel(0, 255, 1, 'strobe', 3000), guard.effectLevel(0, 255, 1, 'strobe', 3000));
});

test('white, colour, palette and spatial strobes share the acknowledged overlay and five-Hz ceiling', () => {
  for (const id of ['white-strobe', 'color-strobe', 'palette-strobe', 'overlay.all', 'overlay.step', 'overlay.scatter', 'overlay.zone']) {
    const spec = presetById(id).spec;
    assert.equal(spec.kind, 'strobe', id);
    assert.ok(spec.params.flashesPerSecond <= 5, id);
    assert.ok(requiresAcknowledgement(spec), id);
    const denied = harness('strobe', room, { spec, acknowledged: false }).draw(0);
    assert.ok(denied.every((slot) => slot.strength === 0), id);
  }
});

for (const technology of ['ddp', 'hue']) for (const id of ['white-strobe', 'color-strobe']) {
  test(`${id} overlay keeps preview and emitted ${technology} frames aligned`, async () => {
    const { createRenderer } = await import('../../src/server/renderer.ts');
    const { createPreviewSampler } = await import('../../src/shared/preview.ts');
    const { buildRig } = await import('../../src/shared/rig.ts');
    const { allocateShared, createUniverseStore } = await import('../../src/server/universes.ts');
    const profile = { id: 'overlay-rgb', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 },
      ...(technology === 'hue' ? { hue: { legacy: true } } : {}) };
    const fixtures = [{ id: 1, address: 1, universe: 0, profileId: profile.id, maxBrightness: 255,
      output: { protocol: technology }, hue: technology === 'hue' }];
    const hardware = { technologies: {}, products: {} }, safety = { acknowledged: true, hdFlashIntervalMs: 350 };
    const spec = presetById(id).spec;
    const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
    const store = createUniverseStore(allocateShared()), rig = buildRig(fixtures, () => profile);
    const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: id, bpm: 120 } }], null,
      { resolveEffect: () => spec, profiles: { [profile.id]: profile }, hardware, safety, hueStrobe: 'flash' });
    const input = { running: true, pattern: id, effect: spec, colorA: 0, colorB: 0, colorC: 0, colorD: 0,
      split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard',
      masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
      fade: null, syncTest: null, universes: [0], fixtures, hardware, safety, hueStrobe: 'flash' };
    const rises = [], colour = { r: 255, g: 0, b: 0 };
    let before = false;
    for (let tick = 0; tick < 220; tick++) {
      const now = tick * 1000 / 44;
      renderer.frame(input, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, 0);
      const wire = [...store.getBuffer(0).subarray(0, 3)], visible = preview(now, fixtures, [colour], rig)[0];
      ['r', 'g', 'b'].forEach((channel, i) => assert.ok(Math.abs(wire[i] - visible[channel]) <= 1, `frame ${tick}, ${channel}`));
      const bright = Math.max(...wire) > 38;
      if (bright && !before) rises.push(tick);
      before = bright;
    }
    assert.ok(rises.length >= 10, 'the overlay keeps playing');
    for (let i = 5; i < rises.length; i++) assert.ok(rises[i] - rises[i - 5] >= 44);
  });
}
