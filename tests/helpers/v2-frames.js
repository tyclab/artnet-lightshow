// Shared fixtures for the v2 effect tests: frames, the synthetic room's effect room, and kind rendering.
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { effectRoom, voiceLayout } from '../../src/shared/effects/layer.ts';
import { syntheticRig, syntheticSpace } from '../../scripts/golden-frames.js';

export const RED = { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 };
export const BLUE = { r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0 };

/** An effect frame at a beat, 120 BPM, with an optional live audio reading. */
export function frameAt(beatPos, { audio = null, palette = [RED, BLUE], anchorBeat = 0, bpm = 120, spec = null } = {}) {
  return {
    beatPos, bpm, nowMs: beatPos * 60000 / bpm, dtMs: 25, anchorBeat, spec: spec ?? { kind: 'v2.test', params: {} },
    palette, lookPalette: palette, paletteOverride: null, roll: 0, gradient: null,
    audio, audioMode: audio ? 'reactive' : 'tempo', master: { ...HD_MASTER_DEFAULTS }, seed: [1, 2, 3, 4], acknowledged: true, hueStrobe: 'flash',
  };
}

/** A live audio reading with the given party band levels. */
export function audioOf({ full = 0, bass = 0, mid = 0, high = 0 } = {}) {
  return { t: 0, rms: full, power: full, dominantHz: null, party: { full, bass, mid, high },
    disco: { hit: [false, false, false], gate: [0, 0, 0], level: [0, 0, 0], peakHit: false, neural: { mainFrequency: 0, amplitude: 0 } },
    spl: { db: -60, level: 0, beat: null, section: null } };
}

/** The synthetic room as an effect room, with or without its space, and the rig behind it. */
export function syntheticRoom({ space = true } = {}) {
  const { fixtures, profileOf } = syntheticRig();
  const rig = buildRig(fixtures, profileOf);
  const layout = voiceLayout(rig);
  return { rig, layout, room: effectRoom(layout, space ? syntheticSpace() : null), fixtures };
}

/** Render a kind's spec over a room at one frame; returns its slots. */
export function renderKind(rawSpec, room, frame, state = undefined) {
  const spec = validateSpec(rawSpec);
  const def = kindOf(spec.kind);
  const f = { ...frame, spec };
  const s = state ?? def.init(spec.params, room, f);
  const out = Array.from({ length: room.n }, () => ({ colour: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, level: 0, strength: 0 }));
  def.render(spec.params, s, room, f, out);
  return { out, state: s, spec };
}
