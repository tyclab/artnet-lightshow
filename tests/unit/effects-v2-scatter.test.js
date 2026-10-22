// Scatter: random units on every step, single or in clusters, gated by band hits; Scatter
// Strobe is its rapid flash form and plays only through the existing flash safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { getProfile, profilesRevision } from '../../src/server/profiles.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { hdGuarded } from '../../src/shared/effects/layer.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { hueSectionColour } from '../../src/shared/hue-colour.ts';
import { lookInput } from '../../scripts/golden-party-looks.js';
import { syntheticRig, syntheticSpace } from '../../scripts/golden-frames.js';
import { buildRig } from '../../src/shared/rig.ts';
import '../../src/shared/effects/index.ts';
import { frameAt, audioOf, syntheticRoom, renderKind } from '../helpers/v2-frames.js';
import { HUE_COLOR } from './hue-test-lamps.js';

const FLASH = { curve: 'linear', attack: 0, hold: 0.06, release: 0.04 };
const scatter = (params, extra = {}) => ({ kind: 'v2.scatter', params, palette: ['#FFFFFF'], ...extra });
const STROBE = scatter({ density: 0.25, stepBeats: 0.25, envelope: FLASH });
const lit = (out) => out.filter((s) => s.level > 0).length;
const thousand = buildRoom(1000, (i) => (i % 40) / 39, (i) => Math.floor(i / 40) / 24, () => 0.5, null);

test('Scatter registers with its defaults; a short-step flash is a rapid flash', () => {
  assert.equal(kindOf('v2.scatter').app, 'own');
  const p = validateSpec(scatter({})).params;
  assert.deepEqual([p.density, p.stepBeats, p.clusterM, p.bands], [0.15, 0.25, 0, []]);
  assert.equal(requiresAcknowledgement(validateSpec(STROBE)), true);
  assert.equal(requiresAcknowledgement(validateSpec(scatter({ density: 0.25, stepBeats: 1, envelope: FLASH }))), false, 'a slow step');
  assert.equal(requiresAcknowledgement(validateSpec(scatter({ stepBeats: 0.25, envelope: { curve: 'linear', attack: 0.25, hold: 0.25, release: 1 } }))), false, 'a fade');
});

test('a quarter density lights a quarter of a thousand units on every step', () => {
  for (const step of [0, 1, 2, 7, 30]) {
    const out = renderKind(STROBE, thousand, frameAt(step * 0.25 + 0.01)).out;
    assert.ok(Math.abs(lit(out) - 250) <= 25, `step ${step}: ${lit(out)}`);
  }
  const a = renderKind(STROBE, thousand, frameAt(0.01)).out, b = renderKind(STROBE, thousand, frameAt(0.26)).out;
  assert.notDeepEqual(a.map((s) => s.level > 0), b.map((s) => s.level > 0), 'every step draws afresh');
  assert.equal(lit(renderKind(STROBE, thousand, frameAt(0.2)).out), 0, 'a flash is cut before the next step');
});

test('the same seed picks the same units', () => {
  const pick = () => renderKind(STROBE, thousand, frameAt(1.51)).out.map((s) => s.level > 0);
  assert.deepEqual(pick(), pick());
});

test('a cluster lights only units within its radius of each picked centre', () => {
  const { room } = syntheticRoom();
  const spec = scatter({ density: 0.02, clusterM: 0.4, stepBeats: 0.5, envelope: FLASH });
  const out = renderKind(spec, room, frameAt(0.01)).out;
  const on = out.map((s, i) => (s.level > 0 ? i : -1)).filter((i) => i >= 0);
  assert.ok(on.length > Math.round(0.02 * room.n), 'clusters light more than their centres');
  const { x, y, z } = room.space;
  const single = renderKind({ ...spec, params: { ...spec.params, clusterM: 0 } }, room, frameAt(0.01)).out;
  const centres = single.map((s, i) => (s.level > 0 ? i : -1)).filter((i) => i >= 0);
  for (const i of on) assert.ok(centres.some((c) => Math.hypot(x[i] - x[c], y[i] - y[c], z[i] - z[c]) <= 0.4 + 1e-6), `unit ${i} is near a centre`);
  const plan = renderKind({ ...spec, params: { ...spec.params, space: 'plan' } }, room, frameAt(0.01)).out;
  assert.equal(lit(plan), Math.round(0.02 * room.n), 'clusters are room-only');
});

test('band hits gate the steps when live audio plays', () => {
  const spec = scatter({ density: 0.5, stepBeats: 0.25, envelope: FLASH, bands: ['bass'] });
  assert.equal(lit(renderKind(spec, thousand, frameAt(0.01, { audio: audioOf({ bass: 0.05 }) })).out), 0);
  assert.equal(lit(renderKind(spec, thousand, frameAt(0.01, { audio: audioOf({ bass: 0.9 }) })).out), 500);
  assert.equal(lit(renderKind(spec, thousand, frameAt(0.01)).out), 500, 'without live input every step fires');
});

test('a step keeps the band decision it first saw', () => {
  const spec = scatter({ density: 0.5, stepBeats: 1, envelope: { curve: 'linear', attack: 0, hold: 0.8, release: 0 }, bands: ['high'] });
  const first = renderKind(spec, thousand, frameAt(0.01, { audio: audioOf({ high: 0.9 }) }));
  const later = renderKind(spec, thousand, frameAt(0.5, { audio: audioOf({ high: 0 }) }), first.state).out;
  assert.equal(lit(later), 500);
});

// The renderer at 120 BPM over a single fixture; `safety` and hardware as the engine hands them over.
function trace(fixtures, spec, { acknowledged = true, profileOf = getProfile, ms = 3000, hardware = { technologies: {}, products: {} } } = {}) {
  const renderer = createRenderer({ profileOf, profilesRevision, now: 0 });
  const store = createUniverseStore(allocateShared());
  const input = { ...lookInput('scatter', fixtures, () => validateSpec(spec)), safety: { acknowledged, hdFlashIntervalMs: 350 }, hardware };
  const frames = [];
  for (let t = 0; t <= ms; t += FRAME_MS) {
    renderer.frame(input, { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store, 0);
    frames.push({ t, bytes: Array.from(store.getBuffer(0).subarray(0, 96)) });
  }
  return frames;
}

test('before the photosensitivity acknowledgement a Scatter Strobe never flashes', () => {
  const pars = syntheticRig().fixtures.slice(0, 6);
  const frames = trace(pars, scatter({ density: 1, stepBeats: 0.25, envelope: FLASH }), { acknowledged: false });
  assert.ok(frames.every(({ bytes }) => bytes.every((v) => v === 0)));
  const allowed = trace(pars, scatter({ density: 1, stepBeats: 0.25, envelope: FLASH }));
  assert.ok(allowed.some(({ bytes }) => bytes.some((v) => v > 0)), 'and flashes once acknowledged');
});

test('a rapid Scatter Strobe takes the per-lamp flash permit', () => {
  assert.equal(hdGuarded('v2.scatter'), true);
  const pars = syntheticRig().fixtures.slice(0, 1);
  const red = getProfile(pars[0]).channelMap.red;
  const frames = trace(pars, scatter({ density: 1, stepBeats: 0.25, envelope: FLASH }));
  const rises = [];
  let was = false;
  for (const { t, bytes } of frames) { const on = bytes[red] > 140; if (on && !was) rises.push(t); was = on; }
  assert.ok(rises.length > 3);
  for (let k = 1; k < rises.length; k++) assert.ok(rises[k] - rises[k - 1] >= 350 - 1e-6, `rises ${rises[k - 1]} and ${rises[k]}`);
});

test('a Hue lamp is never re-flashed inside its hardware interval', () => {
  const hue = [{ id: 0, profileId: HUE_COLOR.id, address: 1, universe: 0, maxBrightness: 255, override: null,
    output: { protocol: 'hue', bridge: 'test', channels: [0] }, hardware: { maxFlashHz: 1, minTransitionMs: 0 }, position: null, group: null, geometry: null, hue: true }];
  const frames = trace(hue, scatter({ density: 1, stepBeats: 0.25, envelope: FLASH }), { profileOf: () => HUE_COLOR, ms: 6000 });
  const rises = [];
  let was = false;
  for (const { t, bytes } of frames) {
    const light = hueSectionColour(HUE_COLOR.channelMap, (offset) => (offset === undefined ? 0 : bytes[offset]), HUE_COLOR.hue);
    const on = Math.max(light.r, light.g, light.b) > 255 * 0.15;
    if (on && !was) rises.push(t);
    was = on;
  }
  assert.ok(rises.length > 1);
  for (let k = 1; k < rises.length; k++) assert.ok(rises[k] - rises[k - 1] >= 1000 - 1e-6, `rises ${rises[k - 1]} and ${rises[k]}`);
});

test('the renderer and the preview pick the same units', () => {
  const { fixtures, profileOf } = syntheticRig();
  const rig = buildRig(fixtures, profileOf);
  const spec = validateSpec(scatter({ density: 0.3, stepBeats: 0.5, envelope: { curve: 'linear', attack: 0, hold: 0.2, release: 0.2 }, clusterM: 0.3 }));
  const space = syntheticSpace();
  const renderer = createRenderer({ profileOf, profilesRevision, now: 0 });
  renderer.setSpace(space);
  const store = createUniverseStore(allocateShared());
  const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: 'scatter', colorA: 0, colorB: 6, colorC: 4, colorD: 8, bpm: 120 } }],
    null, { resolveEffect: (id) => (id === 'scatter' ? spec : null), space, safety: { acknowledged: true, hdFlashIntervalMs: 350 } });
  const input = { ...lookInput('scatter', fixtures, () => spec) };
  for (let k = 0; k * FRAME_MS <= 2000; k++) {
    // On the preview's frame grid and its own free clock, to the last bit: steps are edges.
    const t = k * FRAME_MS;
    renderer.frame(input, { beatPos: (t / 60000) * 120, bpm: 120, epoch: 0 }, t, store, 0);
    const preview = sample(t, fixtures, COLOR_PRESETS, rig);
    // Hue lamps leave the rig as Hue colour, not RGB channels: compare the DMX lights.
    const units = rig.units.map((unit, u) => ({ ...unit, u })).filter(({ fixture }) => !rig.hue[fixture]);
    const red = units.map(({ fixture, cell }) => {
      const f = fixtures[fixture], map = rig.cellMaps[fixture]?.[cell] ?? profileOf(f).channelMap;
      return store.getBuffer(0)[f.address - 1 + map.red];
    });
    assert.deepEqual(units.map(({ u }) => preview[u].r), red, `frame at ${t} ms`);
  }
});

test('a small rig still lights one unit on every step', () => {
  const four = buildRoom(4, (i) => i / 3, () => 0.5, () => 0.5, null);
  for (const step of [0, 1, 2]) assert.equal(lit(renderKind(scatter({ density: 0.08, stepBeats: 0.25, envelope: FLASH }), four, frameAt(step * 0.25 + 0.01)).out), 1);
  assert.equal(lit(renderKind(scatter({ density: 0, stepBeats: 0.25, envelope: FLASH }), four, frameAt(0.01)).out), 0);
});

test('with clusters the density is still the share of lights lit, so a dense curtain is not all lit', () => {
  // 1,600 cells 5 cm apart on a wall: a 0.3 m cluster covers about a hundred of them.
  const n = 1600;
  const wall = buildRoom(n, (i) => (i % 40) / 39, (i) => Math.floor(i / 40) / 39, () => 0.5, null);
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), size = new Float32Array(n).fill(0.025);
  for (let i = 0; i < n; i++) { x[i] = (i % 40) * 0.05 - 1; y[i] = Math.floor(i / 40) * 0.05 + 0.2; }
  const spaced = { ...wall, space: { x, y, z, size, bounds: { width: 4, depth: 4, height: 2.6 }, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 }, anchors: {} } };
  for (const step of [0, 1, 2]) {
    const on = lit(renderKind(scatter({ density: 0.2, clusterM: 0.3, stepBeats: 0.25, envelope: FLASH }), spaced, frameAt(step * 0.25 + 0.01)).out);
    assert.ok(on >= 320 && on < 320 + 120, `step ${step}: ${on} of ${n} lit`);
  }
});
