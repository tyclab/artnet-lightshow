// Sweep (a plane through the room) and Shell (distance from an origin): Light DJ's
// pseudo-3D waves made spatial, each in the room and in its classic plan form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { effectRoom, voiceLayout } from '../../src/shared/effects/layer.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { beatPositionAt, localBpm, makeGrid } from '../../src/shared/beat-clock.ts';
import { lookInput } from '../../scripts/golden-party-looks.js';
import '../../src/shared/effects/index.ts';
import { frameAt, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

const { room, layout, rig } = syntheticRoom();
const plain = syntheticRoom({ space: false }).room;
const slotOf = (fixtureId, cell = 0) => layout.units.list.findIndex((u) => rig.fixtures[rig.units[u].fixture].id === fixtureId && rig.units[u].cell === cell);
const level = (out, fixtureId, cell = 0) => out[slotOf(fixtureId, cell)].level;
const sweep = (params, extra = {}) => ({ kind: 'v2.sweep', params, palette: ['#FF0000'], ...extra });
const shell = (params, extra = {}) => ({ kind: 'v2.shell', params, palette: ['#FF0000'], ...extra });
const ACCENT_BAR = { mode: 'beatAccent', band: 'bass', beatInterval: 4, threshold: 0.15, reactiveDepth: 1 };

test('both kinds register as own cell-level kinds with their documented defaults', () => {
  for (const kind of ['v2.sweep', 'v2.shell']) {
    const def = kindOf(kind);
    assert.equal(def.app, 'own');
    assert.equal(def.level, 'cell');
  }
  const s = validateSpec({ kind: 'v2.sweep', params: {} }).params;
  assert.deepEqual([s.space, s.azimuthDeg, s.elevationDeg, s.profile, s.width, s.speed, s.motion, s.turnPerLap], ['room', 0, 0, 'crest', 0.6, 1.5, 'loop', 0]);
  const h = validateSpec({ kind: 'v2.shell', params: {} }).params;
  assert.deepEqual([h.origin, h.anchor, h.alsoAnchor, h.profile, h.direction, h.width, h.speed, h.twistDeg], ['anchor', 'speakerLeft', 'speakerRight', 'ring', 'out', 0.5, 2, 0]);
});

test('a floor-to-ceiling sweep climbs the room at its speed', () => {
  const spec = sweep({ elevationDeg: 90, width: 0.3, speed: 1.3 });
  const atZero = renderKind(spec, room, frameAt(0)).out;
  assert.ok(level(atZero, 3) >= 0.99, `floor par ${level(atZero, 3)}`);
  assert.ok(level(atZero, 2) <= 0.01, `ceiling par ${level(atZero, 2)}`);
  const atOne = renderKind(spec, room, frameAt(1)).out;
  assert.ok(level(atOne, 4) >= 0.9, `par at 1.3 m ${level(atOne, 4)}`);
  assert.ok(level(atOne, 3) <= 0.01);
});

test('the plan form of the same sweep climbs the plot rows, not the heights, and ignores the room', () => {
  const spec = sweep({ elevationDeg: 90, width: 0.3, speed: 1.3, space: 'plan' });
  for (const beat of [0, 0.4, 1.1, 2]) {
    const out = renderKind(spec, room, frameAt(beat)).out;
    assert.equal(level(out, 1), level(out, 6), `same plot row, different heights at ${beat}`);
    assert.deepEqual(out.map((s) => s.level), renderKind(spec, plain, frameAt(beat)).out.map((s) => s.level));
  }
  const rows = [0, 0.25, 0.5, 0.75, 1, 1.25].map((beat) => renderKind(spec, room, frameAt(beat)).out);
  assert.ok(rows.some((out) => Math.abs(level(out, 4) - level(out, 6)) > 0.5), 'different rows light at different times');
});

test('every sweep profile and motion lights the room', () => {
  for (const profile of ['crest', 'line', 'comet', 'gradient', 'stripe']) {
    for (const motion of ['loop', 'bounce', 'random']) {
      for (const space of ['room', 'plan']) {
        const lit = [0, 0.7, 1.9, 3.3].some((beat) => renderKind(sweep({ profile, motion, space, azimuthDeg: 90, turnPerLap: 30 }), room, frameAt(beat)).out.some((s) => s.level > 0.5));
        assert.ok(lit, `${profile} ${motion} ${space}`);
      }
    }
  }
});

test('a comet trails behind its head', () => {
  const spec = sweep({ elevationDeg: 90, profile: 'comet', width: 0.3, speed: 1.3 });
  const out = renderKind(spec, room, frameAt(1)).out;
  assert.ok(level(out, 4) >= 0.9, 'head at 1.3 m');
  assert.ok(level(out, 1) > 0.2 && level(out, 1) < level(out, 4), 'tail below the head');
  assert.ok(level(out, 6) < 0.05, 'nothing ahead of the head');
});

test('a shell from the left speaker reaches one metre in half a beat', () => {
  const spec = shell({ trigger: ACCENT_BAR, alsoAnchor: null, speed: 2 });
  const out = renderKind(spec, room, frameAt(0.5)).out;
  assert.ok(level(out, 1) >= 0.9, `1 m from the speaker: ${level(out, 1)}`);
  assert.ok(level(out, 5) <= 0.05, `3 m from the speaker: ${level(out, 5)}`);
});

test('with alsoAnchor both speakers ring', () => {
  const one = renderKind(shell({ trigger: ACCENT_BAR, alsoAnchor: null, speed: 2 }), room, frameAt(1)).out;
  const both = renderKind(shell({ trigger: ACCENT_BAR, speed: 2 }), room, frameAt(1)).out;
  assert.ok(level(one, 1) <= 0.05, 'the left ring has passed 1 m');
  assert.ok(level(both, 1) >= 0.9, 'the right ring reaches it at 2 m');
});

test('a missing anchor falls back to the room centre', () => {
  const spec = shell({ anchor: 'nowhere', alsoAnchor: null, trigger: ACCENT_BAR, speed: 2 });
  const centre = shell({ origin: 'centre', alsoAnchor: null, trigger: ACCENT_BAR, speed: 2 });
  assert.deepEqual(renderKind(spec, room, frameAt(0.6)).out.map((s) => s.level), renderKind(centre, room, frameAt(0.6)).out.map((s) => s.level));
});

test('an inward shell closes on its origin', () => {
  const spec = shell({ origin: 'listener', direction: 'in', trigger: ACCENT_BAR, speed: 2 });
  const late = renderKind(spec, room, frameAt(1.1)).out, early = renderKind(spec, room, frameAt(0.2)).out;
  assert.ok(level(late, 4) > level(early, 4), 'the par 1.5 m from the desk lights late');
});

test('a twisted shell lights a spiral: a quarter turn peaks a quarter wavelength later', () => {
  const profiles = { lamp: { channelMap: { red: 0 } } };
  const fixtures = [{ id: 1, profileId: 'lamp', position: { x: 50, y: 40 } }, { id: 2, profileId: 'lamp', position: { x: 60, y: 50 } }];
  const tiny = buildRig(fixtures, (f) => profiles[f.profileId]);
  const model = roomSceneSchema.parse({ version: 1, name: 'Spiral', bounds: { width: 4, depth: 4, height: 2.6 },
    bindings: [{ id: 'a', fixtureId: 1, position: { x: 0, y: 1, z: -1 }, confidence: 'measured' }, { id: 'b', fixtureId: 2, position: { x: 1, y: 1, z: 0 }, confidence: 'measured' }],
    anchors: [{ id: 'o', position: { x: 0, y: 1, z: 0 } }] });
  const tinyLayout = voiceLayout(tiny);
  const tinyRoom = effectRoom(tinyLayout, buildUnitSpace(tiny, model));
  const spec = shell({ anchor: 'o', alsoAnchor: null, twistDeg: 90, speed: 2, width: 0.3, trigger: { ...ACCENT_BAR, beatInterval: 2 } });
  const beats = Array.from({ length: 40 }, (_, k) => k * 0.05);
  const peakOf = (fixtureId) => {
    const slot = tinyLayout.units.list.findIndex((u) => tiny.fixtures[tiny.units[u].fixture].id === fixtureId);
    const levels = beats.map((beat) => renderKind(spec, tinyRoom, frameAt(beat)).out[slot].level);
    return beats[levels.indexOf(Math.max(...levels))];
  };
  assert.ok(Math.abs(peakOf(1) - 0.5) < 0.051, `${peakOf(1)}`);
  assert.ok(Math.abs(peakOf(2) - peakOf(1) - 0.5) < 0.051, '1 m later on a 4 m wavelength');
});

test('without a room both kinds play their plan fallback', () => {
  for (const spec of [sweep({ elevationDeg: 90 }), sweep({ space: 'plan' }), shell({}), shell({ space: 'plan', origin: 'listener' }), shell({ origin: 'random' })]) {
    const lit = [0, 0.3, 0.8, 1.6].some((beat) => renderKind(spec, plain, frameAt(beat)).out.some((s) => s.level > 0.3));
    assert.ok(lit, JSON.stringify(spec.params));
  }
});

test('the room and plan forms differ, and a shell plan ring starts at the speaker lamps', () => {
  const roomForm = renderKind(shell({ trigger: ACCENT_BAR, alsoAnchor: null }), room, frameAt(0.05)).out;
  const planForm = renderKind(shell({ trigger: ACCENT_BAR, alsoAnchor: null, space: 'plan' }), room, frameAt(0.05)).out;
  assert.notDeepEqual(roomForm.map((s) => s.level), planForm.map((s) => s.level));
  assert.ok(level(planForm, 1) > 0.5, 'the lamp nearest the left speaker starts the 2D ring');
});

// A vertical strip in the room, played through a tempo change in the renderer and the preview.
const STRIP = barProfile({ id: 'v2-test-column', name: 'Column', cells: 64, firstChannel: 1, order: 'RGB' });
const column = [{ id: 1, address: 1, universe: 0, profileId: STRIP.id, maxBrightness: 255, override: null, position: { x: 50, y: 50 }, group: null, geometry: { length: 20, angle: 90 }, hue: false }];
const profileOf = (f) => (f.profileId === STRIP.id ? STRIP : getProfile(f));
const columnRig = buildRig(column, profileOf);
const columnSpace = buildUnitSpace(columnRig, roomSceneSchema.parse({ version: 1, name: 'Column', bounds: { width: 4, depth: 4, height: 2.6 },
  bindings: [{ id: 'col', fixtureId: 1, position: { x: 0, y: 1.3, z: 0 }, path: [{ x: 0, y: 0.05, z: 0 }, { x: 0, y: 2.55, z: 0 }], confidence: 'measured' }] }));
const cellY = Array.from({ length: 64 }, (_, c) => columnSpace.y[c]);
// 120 BPM for eight beats, then 174 BPM.
const BEATS = [...Array.from({ length: 9 }, (_, k) => k * 0.5), ...Array.from({ length: 16 }, (_, k) => 4 + ((k + 1) * 60) / 174)];
const grid = makeGrid(BEATS);
const SWEEP_UP = validateSpec(sweep({ elevationDeg: 90, motion: 'bounce', width: 0.6, speed: 1.5 }));
const centroid = (reds) => { let w = 0, y = 0; reds.forEach((r, c) => { if (r > 128) { w += r; y += r * cellY[c]; } }); return w ? y / w : null; };

test('a tempo change mid-sweep moves the crest less than one width per frame, in the renderer and the preview alike', () => {
  const times = [];
  for (let t = 0; t <= 6500; t += FRAME_MS) times.push(t);
  assert.ok(beatPositionAt(grid, 3000) < 8 && beatPositionAt(grid, 6500) > 9 && localBpm(grid, 6500) > 170);
  const renderer = createRenderer({ profileOf, profilesRevision, now: times[0] });
  renderer.setSpace(columnSpace);
  const store = universes.createUniverseStore(universes.allocateShared());
  const input = lookInput('sweep-up', column, () => SWEEP_UP);
  const rigFrames = times.map((t) => {
    renderer.frame(input, { beatPos: beatPositionAt(grid, t), bpm: localBpm(grid, t), epoch: 0 }, t, store, 0);
    return Array.from({ length: 64 }, (_, c) => store.getBuffer(0)[c * 3]);
  });
  const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: 'sweep-up', colorA: 0, colorB: 6, colorC: 4, colorD: 8, bpm: 120 } }],
    { beats: BEATS }, { resolveEffect: (id) => (id === 'sweep-up' ? SWEEP_UP : null), space: columnSpace });
  const previewFrames = times.map((t) => sample(t, column, COLOR_PRESETS, columnRig).map((c) => c.r));
  assert.deepEqual(previewFrames, rigFrames, 'the preview draws what the rig drives');
  const crests = rigFrames.map(centroid);
  assert.ok(crests.filter((c) => c !== null).length > times.length * 0.8);
  for (let k = 1; k < crests.length; k++) {
    if (crests[k] === null || crests[k - 1] === null) continue;
    assert.ok(Math.abs(crests[k] - crests[k - 1]) < 0.6, `crest jumped ${crests[k - 1]} -> ${crests[k]} at ${times[k]} ms`);
  }
});

test('a turning sweep keeps its crest moving smoothly, however long it has played', () => {
  const frameBeats = (FRAME_MS / 60000) * 128;
  // A soft crest moving 8 cm a frame changes no light by more than about a third in one frame; a jump flips many.
  for (const [motion, turnPerLap, profile, width] of [['bounce', 45, 'crest', 0.35], ['loop', 30, 'crest', 0.6]]) {
    for (const space of ['room', 'plan']) {
      const spec = sweep({ azimuthDeg: 90, profile, width, speed: 1.5, motion, turnPerLap, space });
      for (const start of [0, 4096]) {
        let previous = null, worst = 0;
        for (let k = 0; k < 300; k++) {
          const levels = renderKind(spec, room, frameAt(start + k * frameBeats, { bpm: 128 })).out.map((s) => s.level);
          if (previous) worst = Math.max(worst, levels.filter((v, i) => Math.abs(v - previous[i]) > 0.5).length);
          previous = levels;
        }
        assert.ok(worst <= room.n * 0.05, `${motion} turning ${turnPerLap}° in ${space} from beat ${start}: ${worst} of ${room.n} lights flip in one frame`);
      }
    }
  }
});

test('a ring from a random corner light crosses the whole room', async () => {
  const { hash01 } = await import('../../src/shared/effects/hash.ts');
  const profiles = { lamp: { channelMap: { red: 0 } } };
  const fixtures = [{ id: 1, profileId: 'lamp', position: { x: 50, y: 50 } }, { id: 2, profileId: 'lamp', position: { x: 5, y: 5 } }, { id: 3, profileId: 'lamp', position: { x: 95, y: 95 } }];
  const tiny = buildRig(fixtures, (f) => profiles[f.profileId]);
  const model = roomSceneSchema.parse({ version: 1, name: 'Corners', bounds: { width: 4, depth: 4, height: 2.6 }, bindings: [
    { id: 'c', fixtureId: 1, position: { x: 0, y: 1.3, z: 0 }, confidence: 'measured' },
    { id: 'a', fixtureId: 2, position: { x: -1.9, y: 0.1, z: -1.9 }, confidence: 'measured' },
    { id: 'b', fixtureId: 3, position: { x: 1.9, y: 2.5, z: 1.9 }, confidence: 'measured' }] });
  const tinyLayout = voiceLayout(tiny);
  const tinyRoom = effectRoom(tinyLayout, buildUnitSpace(tiny, model));
  const slot = (id) => tinyLayout.units.list.findIndex((u) => tiny.fixtures[tiny.units[u].fixture].id === id);
  const pick = (seed, event) => Math.min(2, Math.floor(hash01(seed, 5, event) * 3));
  // A seed whose first ring starts at the centre light and a later one at corner a.
  let seed = null, event = 0;
  for (let s = 1; s < 500 && !seed; s++) {
    const candidate = [s, 7, 7, 7];
    if (pick(candidate, 0) !== slot(1)) continue;
    for (let k = 1; k < 20; k++) if (pick(candidate, k) === slot(2)) { seed = candidate; event = k; break; }
  }
  assert.ok(seed, 'a seed to test with');
  const spec = shell({ origin: 'random', alsoAnchor: null, speed: 2, width: 0.3, trigger: { ...ACCENT_BAR, mode: 'timeline' } });
  const far = Math.hypot(3.8, 2.4, 3.8);
  const at = { ...frameAt(event * 4 + far / 2), seed };
  assert.ok(renderKind(spec, tinyRoom, at).out[slot(3)].level >= 0.8, 'the ring from corner a reaches corner b');
});
