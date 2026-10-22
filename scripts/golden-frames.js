// Per-unit golden frames and the numeric frame diff later steps use as their tolerance.
// Rows are output units in rig order; a row holds that unit's channels for every sampled beat.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createRenderer } from '../src/server/renderer.ts';
import * as universes from '../src/server/universes.ts';
import { getProfile, profilesRevision } from '../src/server/profiles.ts';
import { barProfile } from '../src/server/bar-profile.ts';
import { buildRig } from '../src/shared/rig.ts';
import { roomSceneSchema } from '../src/shared/room-scene.ts';
import { buildUnitSpace } from '../src/shared/space.ts';
import { presetById } from '../src/shared/effects/catalogue.ts';
import { BEATS, BPM, flatRig, lookInput, placedRig } from './golden-party-looks.js';
import { V2_PRESETS } from '../src/shared/effects/v2/presets.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM } from '../src/shared/demo-track.ts';

const MS_PER_BEAT = 60000 / BPM;
const SEED = 0x5eed;
// The Spatial goldens sample the party looks' beats.
export const V2_BEATS = BEATS;
export const V2_COMPLETE_BEATS = [...BEATS, 15.5, 16.25, 24, 32.5, 48.25, 63];
const demoMs = (ms) => ms * BPM / DEMO_BPM;
export const V2_COMPLETE_OPTIONS = {
  audioAt: (ms) => ({ ...DEMO_AUDIO_SOURCE.frameAt(demoMs(ms)), t: ms }),
  modulationAt: (ms) => DEMO_AUDIO_SOURCE.modulationAt(demoMs(ms)),
  pictureAt: (ms) => ({ ...DEMO_AUDIO_SOURCE.pictureAt(demoMs(ms)), expiresAt: ms + 1000 }),
};

/** The committed synthetic room: its fixtures, the profiles they need and the room model. */
export function syntheticRig() {
  const doc = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/rigs/synthetic-room.json', import.meta.url), 'utf8'));
  const profiles = new Map(doc.profiles.map(({ bar, grid }) => {
    const profile = barProfile(bar);
    return [profile.id, grid ? { ...profile, grid } : profile];
  }));
  const profileOf = (fixture) => profiles.get(fixture.profileId) || getProfile(fixture);
  // As the engine hands fixtures to the renderer: full brightness, no override.
  const fixtures = doc.fixtures.map(({ label: _label, ...f }) => ({ maxBrightness: 255, override: null, hue: false, ...f }));
  return { fixtures, profiles, profileOf, room: doc.room, units: buildRig(fixtures, profileOf).units.length };
}

/** The synthetic rig's unit space, as the engine builds it from the room. */
export function syntheticSpace() {
  const { fixtures, profileOf, room } = syntheticRig();
  return buildUnitSpace(buildRig(fixtures, profileOf), roomSceneSchema.parse(room));
}

function rigOf(name) {
  if (name === 'flat') return { fixtures: flatRig(), profileOf: getProfile };
  if (name === 'placed') return { fixtures: placedRig(), profileOf: getProfile };
  if (name === 'synthetic') return syntheticRig();
  throw new Error(`Unknown golden rig ${name}`);
}

// Seeded so patterns that roll Math.random render the same frames on every run.
function seeded(value) {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const effectOf = (id) => presetById(id)?.spec ?? null;

/** Channel offsets of each unit, relative to its fixture's address: a cell's own channels, or a lamp's whole footprint. */
function unitChannels(fixtures, profileOf) {
  const rig = buildRig(fixtures, profileOf);
  return rig.units.map(({ fixture, cell }) => {
    const f = fixtures[fixture], maps = rig.cellMaps[fixture];
    const offsets = maps ? Object.values(maps[cell]).filter(Number.isInteger).sort((a, b) => a - b)
      : Array.from({ length: profileOf(f).channelCount }, (_, k) => k);
    return { universe: f.universe ?? 0, offsets: offsets.map((k) => f.address - 1 + k) };
  });
}

/** Frames per id on a named rig: one row per unit, its channels at each beat in turn. The synthetic rig plays in its room unless `space` is false. */
export function renderGolden(ids, rigName, beats, { space = true, audioAt, modulationAt, pictureAt } = {}) {
  const { fixtures, profileOf } = rigOf(rigName);
  const unitSpace = space && rigName === 'synthetic' ? syntheticSpace() : null;
  const channels = unitChannels(fixtures, profileOf);
  const random = Math.random;
  Math.random = seeded(SEED);
  try {
    return Object.fromEntries(ids.map((id) => {
      const renderer = createRenderer({ profileOf, profilesRevision, now: 0 });
      renderer.setSpace(unitSpace);
      const store = universes.createUniverseStore(universes.allocateShared());
      const rows = channels.map(() => []);
      const input = lookInput(id, fixtures, effectOf);
      for (const beatPos of beats) {
        const ms = beatPos * MS_PER_BEAT;
        if (audioAt) { input.audio = audioAt(ms); input.audioMode = 'reactive'; }
        if (modulationAt) input.modulation = modulationAt(ms);
        if (pictureAt) input.pictureFeatures = pictureAt(ms);
        renderer.frame(input, { beatPos, bpm: BPM, epoch: 0 }, ms, store);
        channels.forEach(({ universe, offsets }, u) => {
          const buffer = store.getBuffer(universe);
          for (const k of offsets) rows[u].push(buffer[k]);
        });
      }
      return [id, rows];
    }));
  } finally {
    Math.random = random;
  }
}

/** The largest absolute channel difference over all units and frames, and how many units differ at all. */
export function frameDiff(a, b) {
  let maxChannel = 0, units = 0;
  const n = Math.max(a.length, b.length);
  for (let u = 0; u < n; u++) {
    const x = a[u] ?? [], y = b[u] ?? [];
    let differs = x.length !== y.length;
    for (let k = 0; k < Math.max(x.length, y.length); k++) {
      const d = Math.abs((x[k] ?? 0) - (y[k] ?? 0));
      if (d > 0) differs = true;
      if (d > maxChannel) maxChannel = d;
    }
    if (differs) units++;
  }
  return { maxChannel, units };
}

// Phase A remains a read-only baseline; this records the complete show against deterministic demo input.
function main() {
  const frames = renderGolden(V2_PRESETS.map((p) => p.id), 'synthetic', V2_COMPLETE_BEATS, V2_COMPLETE_OPTIONS);
  const body = Object.entries(frames).map(([id, rows]) => `  ${JSON.stringify(id)}: [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`);
  fs.writeFileSync(new URL('../tests/fixtures/golden/v2-complete.json', import.meta.url), `{\n${body.join(',\n')}\n}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
