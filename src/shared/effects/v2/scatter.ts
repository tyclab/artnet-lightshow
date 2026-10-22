import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { hash01 } from '../hash.ts';
import { registerKind } from '../registry.ts';
import { accentStrobes, bandSchema, isFlashEnvelope, paint, positionsOf, triggerLevel, v2CommonSchema } from './common.ts';
import type { Positions } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// Random units on every step: single, or every unit within a radius of each pick (room space only).
export const scatterSchema = v2CommonSchema.extend({
  density: z.number().min(0).max(1).default(0.15),
  stepBeats: z.number().min(1 / 16).max(16).default(0.25),
  // Metres; density stays the share of lights lit, so clusters mean fewer, larger patches.
  clusterM: z.number().min(0).max(10).default(0),
  // With live audio, a step fires only on a hit in one of these bands; empty fires every step.
  bands: z.array(bandSchema).max(4).default([]),
});
export type ScatterParams = z.output<typeof scatterSchema>;

const KEEP_STEPS = 64;
const MAX_BACK_STEPS = 64;

export function scatterRapidFlash(p: Pick<ScatterParams, 'stepBeats' | 'envelope' | 'trigger'>): boolean {
  return (p.stepBeats <= 0.25 && isFlashEnvelope(p.envelope)) || accentStrobes(p);
}

interface ScatterState { fired: Map<number, boolean> }

// Fast seeded stream for the picks of one step; the step's seed comes from the shared hash.
function stream(word: number): () => number {
  let a = word >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first `count` units of a seeded shuffle for one step, with each pick's palette position. */
function picksOf(seed: EffectFrame['seed'], step: number, n: number, count: number): { units: Int32Array; colours: Float32Array } {
  const next = stream(Math.floor(hash01(seed, 11, step) * 4294967296));
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const colours = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(next() * (n - k));
    const swap = order[k]; order[k] = order[j]; order[j] = swap;
    colours[k] = next();
  }
  return { units: order.subarray(0, count), colours };
}

// Units bucketed by a cube of the cluster radius, so a pick only checks its 27 neighbouring cubes.
const hashes = new WeakMap<Positions, Map<number, Map<number, number[]>>>();
const OFFSET = 4096, SPAN = 8192;
const cubeKey = (ix: number, iy: number, iz: number) => ((ix + OFFSET) * SPAN + (iy + OFFSET)) * SPAN + (iz + OFFSET);
function neighbourhood(pos: Positions, n: number, radius: number): Map<number, number[]> {
  let byRadius = hashes.get(pos);
  if (!byRadius) { byRadius = new Map(); hashes.set(pos, byRadius); }
  let cubes = byRadius.get(radius);
  if (!cubes) {
    cubes = new Map();
    for (let i = 0; i < n; i++) {
      const key = cubeKey(Math.floor(pos.x[i] / radius), Math.floor(pos.y[i] / radius), Math.floor(pos.z[i] / radius));
      const cube = cubes.get(key);
      if (cube) cube.push(i); else cubes.set(key, [i]);
    }
    if (byRadius.size > 8) byRadius.clear();
    byRadius.set(radius, cubes);
  }
  return cubes;
}

// The lights of one step: its picks, or with clusters every light within the radius of each pick, adding
// picks until `count` lights are lit (a light keeps its first pick's colour). Pure in the seed and the
// step, so it is worked out once and remembered.
const stepMemo = new WeakMap<Positions, Map<string, { units: Int32Array; colours: Float32Array }>>();
const KEEP_STEP_LIGHTS = 32;
function stepLights(pos: Positions, n: number, seed: EffectFrame['seed'], step: number, count: number, cluster: number): { units: Int32Array; colours: Float32Array } {
  let memo = stepMemo.get(pos);
  if (!memo) { memo = new Map(); stepMemo.set(pos, memo); }
  const key = `${seed.join(',')}|${step}|${count}|${cluster}|${n}`;
  const known = memo.get(key);
  if (known) return known;
  const picks = picksOf(seed, step, n, cluster ? n : count);
  let found = picks;
  if (cluster) {
    const cubes = neighbourhood(pos, n, cluster);
    const colourOf = new Map<number, number>();
    for (let k = 0; k < n && colourOf.size < count; k++) {
      const c = picks.units[k];
      const cx = Math.floor(pos.x[c] / cluster), cy = Math.floor(pos.y[c] / cluster), cz = Math.floor(pos.z[c] / cluster);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const i of cubes.get(cubeKey(cx + dx, cy + dy, cz + dz)) ?? []) {
          if (!colourOf.has(i) && Math.hypot(pos.x[i] - pos.x[c], pos.y[i] - pos.y[c], pos.z[i] - pos.z[c]) <= cluster) colourOf.set(i, picks.colours[k]);
        }
      }
    }
    found = { units: Int32Array.from(colourOf.keys()), colours: Float32Array.from(colourOf.values()) };
  }
  memo.set(key, found);
  if (memo.size > KEEP_STEP_LIGHTS) memo.delete(memo.keys().next().value!);
  return found;
}

function fires(p: ScatterParams, s: ScatterState, f: EffectFrame, step: number): boolean {
  if (!p.bands.length || f.audioMode !== 'reactive' || !f.audio) return true;
  let fired = s.fired.get(step);
  if (fired === undefined) {
    const threshold = Math.max(f.master.threshold, p.trigger.threshold);
    fired = p.bands.some((band) => f.audio!.party[band] >= threshold);
    s.fired.set(step, fired);
    if (s.fired.size > KEEP_STEPS) s.fired.delete(s.fired.keys().next().value!);
  }
  return fired;
}

function renderScatter(p: ScatterParams, s: ScatterState, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const n = room.n;
  const pos = positionsOf(room, p.space);
  // Double precision, so a later equal level never displaces the first by single-precision rounding.
  const levels = new Float64Array(n), along = new Float64Array(n);
  const t = f.beatPos - f.anchorBeat;
  const now = Math.floor((Number.isFinite(t) ? t : 0) / p.stepBeats);
  const length = p.envelope.attack + p.envelope.hold + p.envelope.release;
  const back = Math.min(MAX_BACK_STEPS, Math.ceil(length / p.stepBeats));
  // At least one pick a step, so a sparse density still plays on a small rig.
  const count = p.density > 0 ? Math.min(n, Math.max(1, Math.round(p.density * n))) : 0;
  const cluster = p.clusterM > 0 && !pos.plan ? p.clusterM : 0;
  for (let step = now - back; step <= now && count > 0; step++) {
    const level = sampleEnvelope(t - step * p.stepBeats, p.envelope);
    if (!(level > 0) || !fires(p, s, f, step)) continue;
    const { units, colours } = stepLights(pos, n, f.seed, step, count, cluster);
    for (let k = 0; k < units.length; k++) {
      const i = units[k];
      if (level > levels[i]) { levels[i] = level; along[i] = colours[k]; }
    }
  }
  const trigger = triggerLevel(p, f);
  for (let i = 0; i < n; i++) paint(p, f, along[i], levels[i] * trigger, out[i]);
}

registerKind<ScatterParams, ScatterState>({
  kind: 'v2.scatter', app: 'own', level: 'cell', schema: scatterSchema,
  defaults: { params: scatterSchema.parse({}), brightness: 1 }, stateful: true,
  rapidFlashWhen: scatterRapidFlash,
  init: () => ({ fired: new Map() }),
  render: (params, state, room, frame, out) => renderScatter(params, state, room, frame, out),
});
