import { V2_PRESETS } from '../shared/effects/v2/presets.ts';
import { kindOf, validateSpec } from '../shared/effects/registry.ts';
import { effectRoom, voiceLayout } from '../shared/effects/layer.ts';
import { HD_MASTER_DEFAULTS } from '../shared/effects/types.ts';
import type { EffectFrame, EffectSlot } from '../shared/effects/types.ts';
import type { Room } from '../shared/room.ts';
import type { Rig } from '../shared/rig.ts';
import type { UnitSpace } from '../shared/space.ts';

const CANDIDATES = V2_PRESETS.filter((p) => p.spec.kind === 'v2.particles' && !p.id.endsWith('.2d'));
const EMPTY: ReadonlySet<string> = new Set();
const WHITE = { r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 };
const yieldFrame = () => new Promise<void>((resolve) => setImmediate(resolve));
export interface CoverageResult { eligible: Set<string>; darkBeats: Map<string, number> }

// Automatic policy: two cycles, sampled every eighth beat, with no all-dark gap longer than one bar.
// Fixed-seed geometric evidence, without hardware admission: a sample must survive 8-bit level quantization.
// This does not guarantee coverage for every launch seed or later stochastic cycle.
export async function measureParticleCoverage(room: Room, cancelled = () => false,
  pause: () => Promise<void> = yieldFrame): Promise<CoverageResult> {
  const eligible = new Set<string>(), darkBeats = new Map<string, number>();
  for (const preset of CANDIDATES) {
    await pause();
    if (cancelled()) return { eligible, darkBeats };
    const spec = validateSpec(preset.spec), def = kindOf(spec.kind)!;
    const frame: EffectFrame = { beatPos: 0, anchorBeat: 0, bpm: 120, nowMs: 0, dtMs: 62.5, spec,
      palette: [WHITE], lookPalette: [WHITE], paletteOverride: null, roll: 0, audio: null,
      audioMode: 'tempo', master: { ...HD_MASTER_DEFAULTS }, seed: [1, 2, 3, 4], acknowledged: false, hueStrobe: 'flash' };
    const state = def.init(spec.params, room, frame);
    const out: EffectSlot[] = Array.from({ length: room.n }, () => ({ colour: WHITE, level: 0, strength: 0 }));
    const samples = Math.ceil(Number(spec.params?.cycleBeats ?? 8) * 16);
    let dark = 0, longest = 0, lit = false;
    for (let sample = 0; sample < samples; sample++) {
      frame.beatPos = sample / 8; frame.nowMs = sample * 62.5;
      def.render(spec.params, state, room, frame, out);
      const visible = out.some((slot) => Math.round(slot.level * (spec.brightness ?? 1) * 255) > 0);
      lit ||= visible;
      dark = visible ? 0 : dark + 1; longest = Math.max(longest, dark);
      if (longest > 32) break;
      await pause();
      if (cancelled()) return { eligible, darkBeats };
    }
    darkBeats.set(preset.id, longest / 8);
    if (lit && longest <= 32) eligible.add(preset.id);
  }
  return { eligible, darkBeats };
}

// Keep only the current geometry. Profile/order changes replace Rig; room edits replace UnitSpace.
export class ParticleCoverage {
  allowed: ReadonlySet<string> = EMPTY;
  ready: Promise<void> = Promise.resolve();
  private rig: Rig | null = null;
  private space: UnitSpace | null = null;
  private generation = 0;
  private changed: () => void;
  constructor(changed: () => void) { this.changed = changed; }
  forRig(rig: Rig, space: UnitSpace | null): ReadonlySet<string> {
    if (rig === this.rig && space === this.space) return this.allowed;
    this.rig = rig; this.space = space; this.allowed = EMPTY;
    const generation = ++this.generation, cancelled = () => generation !== this.generation;
    this.ready = yieldFrame().then(async () => {
      if (cancelled()) return;
      const result = await measureParticleCoverage(effectRoom(voiceLayout(rig), space), cancelled);
      if (cancelled()) return;
      this.allowed = result.eligible;
      this.changed();
    }).catch(() => {
      if (!cancelled()) console.warn('[auto-show] particle coverage unavailable; keeping broad spatial effects');
    });
    return this.allowed;
  }
}
