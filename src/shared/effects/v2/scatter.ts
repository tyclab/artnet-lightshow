import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { hash01 } from '../hash.ts';
import { registerKind } from '../registry.ts';
import { bandSchema, paint, positionsOf, triggerLevel, v2CommonSchema } from './common.ts';
import type { Positions, V2Common } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// Random units on every step: single, or every unit within a radius of each pick (room space only).
export const scatterSchema = v2CommonSchema.extend({
  density: z.number().min(0).max(1).default(0.15),
  stepBeats: z.number().min(1 / 16).max(16).default(0.25),
  clusterM: z.number().min(0).max(10).default(0),
  // With live audio, a step fires only on a hit in one of these bands; empty fires every step.
  bands: z.array(bandSchema).max(4).default([]),
});
export type ScatterParams = z.output<typeof scatterSchema>;

// The slot kind a rapid Scatter Strobe reports, so the per-lamp flash permit (layer.ts) covers it.
export const SCATTER_FLASH_KIND = 'v2.scatter.flash';
const KEEP_STEPS = 64;
const MAX_BACK_STEPS = 64;

/** A flash envelope: no attack and gone within a fifth of a beat. */
export function isFlashEnvelope(envelope: V2Common['envelope']): boolean {
  return envelope.attack <= 0.02 && envelope.hold + envelope.release <= 0.2;
}

export function scatterRapidFlash(p: Pick<ScatterParams, 'stepBeats' | 'envelope'>): boolean {
  return p.stepBeats <= 0.25 && isFlashEnvelope(p.envelope);
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
  const levels = new Float32Array(n), along = new Float32Array(n);
  const t = f.beatPos - f.anchorBeat;
  const now = Math.floor((Number.isFinite(t) ? t : 0) / p.stepBeats);
  const length = p.envelope.attack + p.envelope.hold + p.envelope.release;
  const back = Math.min(MAX_BACK_STEPS, Math.ceil(length / p.stepBeats));
  // At least one pick a step, so a sparse density still plays on a small rig.
  const count = p.density > 0 ? Math.min(n, Math.max(1, Math.round(p.density * n))) : 0;
  const cluster = p.clusterM > 0 && !pos.plan ? p.clusterM : 0;
  const cubes = cluster ? neighbourhood(pos, n, cluster) : null;
  const light = (i: number, level: number, colour: number) => { if (level > levels[i]) { levels[i] = level; along[i] = colour; } };
  for (let step = now - back; step <= now && count > 0; step++) {
    const level = sampleEnvelope(t - step * p.stepBeats, p.envelope);
    if (!(level > 0) || !fires(p, s, f, step)) continue;
    const { units, colours } = picksOf(f.seed, step, n, count);
    for (let k = 0; k < count; k++) {
      const c = units[k];
      if (!cubes) { light(c, level, colours[k]); continue; }
      const cx = Math.floor(pos.x[c] / cluster), cy = Math.floor(pos.y[c] / cluster), cz = Math.floor(pos.z[c] / cluster);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const i of cubes.get(cubeKey(cx + dx, cy + dy, cz + dz)) ?? []) {
          if (Math.hypot(pos.x[i] - pos.x[c], pos.y[i] - pos.y[c], pos.z[i] - pos.z[c]) <= cluster) light(i, level, colours[k]);
        }
      }
    }
  }
  const trigger = triggerLevel(p, f);
  const kind = scatterRapidFlash(p) ? SCATTER_FLASH_KIND : undefined;
  for (let i = 0; i < n; i++) {
    paint(p, f, along[i], levels[i] * trigger, out[i]);
    if (kind && out[i].strength > 0) out[i].kind = kind;
  }
}

registerKind<ScatterParams, ScatterState>({
  kind: 'v2.scatter', app: 'own', level: 'cell', schema: scatterSchema,
  defaults: { params: scatterSchema.parse({}), brightness: 1 }, stateful: true,
  rapidFlashWhen: scatterRapidFlash,
  init: () => ({ fired: new Map() }),
  render: (params, state, room, frame, out) => renderScatter(params, state, room, frame, out),
});
