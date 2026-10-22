import { z } from 'zod';
import { neuralReading } from '../disco.ts';
import type { NeuralReading } from '../disco.ts';
import { registerKind } from '../registry.ts';
import { azimuthAround, centreOf, distanceTo, farthestCorner, paint, pointIn, positionsOf, triggerLevel, v2CommonSchema } from './common.ts';
import type { Point, Positions } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// The music in space: bass, mids and highs each light their own part of the room, live.
export const neuralSchema = v2CommonSchema.extend({
  layout: z.enum(['height', 'distance', 'zones']).default('height'),
  // The wash with no music.
  idle: z.number().min(0).max(1).default(0.08),
  // Share of a band level kept per 25 ms frame: 0 follows at once.
  smoothing: z.number().min(0).max(0.98).default(0.35),
  pitchColour: z.boolean().default(true),
});
export type NeuralParams = z.output<typeof neuralSchema>;

type Bands = [bass: number, mid: number, high: number];
interface NeuralState { bands: Bands | null; reading?: NeuralReading | null }

const FRAME = 25;
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
// Bands over a 0..1 axis: bass holds the bottom, highs the top, mids the middle, crossing over at the half.
const lowWeight = (h: number) => 1 - smoothstep(0.4, 0.6, h);
const highWeight = (h: number) => smoothstep(0.4, 0.6, h);
const midWeight = (h: number) => clamp(1 - Math.abs(h - 0.5) / 0.25);
const BAND_COLOUR = [0, 1 / 3, 2 / 3];

function heardBands(p: NeuralParams, s: NeuralState, f: EffectFrame): Bands | null {
  const audio = f.audioMode === 'reactive' ? f.audio : null;
  if (!audio) return null;
  const target: Bands = [clamp(audio.party.bass), clamp(audio.party.mid), clamp(audio.party.high)];
  if (!s.bands) { s.bands = target; return target; }
  const keep = Math.pow(p.smoothing, Math.max(0, f.dtMs) / FRAME);
  s.bands = s.bands.map((v, k) => target[k] + (v - target[k]) * keep) as Bands;
  return s.bands;
}

// What each band gives a unit where it stands.
function bandLevels(p: NeuralParams, room: Room, pos: Positions, i: number, speakers: Point[], reach: number, [bass, mid, high]: Bands): Bands {
  if (p.layout === 'height') {
    // On the plot "up" is the plot's rows toward its top.
    const h = pos.plan ? 1 - pos.z[i] : pos.y[i] / Math.max(1e-6, pos.bounds.height);
    return [bass * lowWeight(h), mid * midWeight(h), high * highWeight(h)];
  }
  if (p.layout === 'distance') {
    // Bass fills out from the nearest speaker as far as it is loud; mids and highs ring further out.
    const q = Math.min(...speakers.map((s) => distanceTo(pos, i, s))) / reach;
    return [(1 - smoothstep(0.9 * bass, 0.9 * bass + 0.1, q)) * clamp(bass / 0.1), mid * midWeight(q), high * highWeight(q)];
  }
  const listener = !pos.plan && room.space ? room.space.listener : { ...centreOf(pos), facingDeg: 0 };
  const turn = ((azimuthAround(pos, i, listener) - listener.facingDeg) * Math.PI) / 180;
  const ahead = Math.cos(turn);
  return [bass * (ahead > 0 ? ahead * ahead : 0), mid * Math.sin(turn) ** 2, high * (ahead < 0 ? ahead * ahead : 0)];
}

function renderNeural(p: NeuralParams, s: NeuralState, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const pos = positionsOf(room, p.space);
  const bands = heardBands(p, s, f);
  const reading = neuralReading(f.audioMode === 'reactive' ? f.audio : null, s);
  const trigger = triggerLevel(p, f);
  const anchors = Object.values(room.space?.anchors ?? {});
  const speakers = (anchors.length ? anchors : [room.space?.listener ?? centreOf(pos)]).map((a) => pointIn(room, pos, a) ?? centreOf(pos));
  const reach = Math.max(1e-6, ...speakers.map((sp) => farthestCorner(pos, sp)));
  for (let i = 0; i < room.n; i++) {
    let level = 0, band = 0;
    if (bands) {
      const given = bandLevels(p, room, pos, i, speakers, reach, bands);
      for (let k = 0; k < 3; k++) if (given[k] > level) { level = given[k]; band = k; }
    }
    const colour = p.pitchColour && reading ? reading.frequency : BAND_COLOUR[band];
    paint(p, f, colour, Math.max(p.idle, level * trigger), out[i]);
  }
}

registerKind<NeuralParams, NeuralState>({
  kind: 'v2.neural', app: 'own', level: 'cell', schema: neuralSchema,
  defaults: { params: neuralSchema.parse({}), brightness: 1 }, stateful: true,
  init: () => ({ bands: null, reading: null }),
  render: (params, state, room, frame, out) => renderNeural(params, state, room, frame, out),
});
