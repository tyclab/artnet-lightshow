import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { samplePalette } from '../palette.ts';
import type { Room } from '../../room.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';

// Every v2 generator plays in one of two first-class spaces: `room` (metres) or `plan` (the classic 2D plot).
export type V2Space = 'room' | 'plan';

// A plan unit box reads metric lengths and speeds against a nominal plot of this size, so a
// preset and its 2D twin keep the same musical timing.
export const PLAN_METRES = 4;
const PLAN_SIZE = 0.02;
// One palette cycle per four bars in `time` colour mode.
const TIME_CYCLE_BEATS = 16;

const unit = z.number().min(0).max(1);
const beats = z.number().min(0).max(64);
export const curveSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'cut']);
export const bandSchema = z.enum(['full', 'bass', 'mid', 'high']);
export const triggerSchema = z.object({
  mode: z.enum(['timeline', 'beatAccent', 'volumeGate']), band: bandSchema,
  beatInterval: z.number().min(1 / 16).max(64), threshold: unit, reactiveDepth: unit,
});
export const envelopeSchema = z.object({ curve: curveSchema, attack: beats, hold: beats, release: beats });

export const TRIGGER_DEFAULT = { mode: 'timeline', band: 'full', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } as const;
export const ENVELOPE_DEFAULT = { curve: 'linear', attack: 0, hold: 0.25, release: 0.5 } as const;

export const v2CommonSchema = z.object({
  space: z.enum(['room', 'plan']).default('room'),
  trigger: triggerSchema.default({ ...TRIGGER_DEFAULT }),
  envelope: envelopeSchema.default({ ...ENVELOPE_DEFAULT }),
  colour: z.enum(['along', 'time', 'solid']).default('along'),
  background: unit.default(0),
});
export type V2Common = z.output<typeof v2CommonSchema>;

export interface Positions {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
  size: ArrayLike<number>;
  bounds: { width: number; depth: number; height: number };
}

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const frac = (v: number) => v - Math.floor(v);
const PLAN_BOUNDS = Object.freeze({ width: 1, depth: 1, height: 1 });
const planMemo = new WeakMap<Room, Positions>();

/** Where a room's units are for a space: room metres from `room.space`, or the plot as a unit box (x across, z down the rows, y height). */
export function positionsOf(room: Room, space: V2Space): Positions {
  if (space === 'room' && room.space) return room.space;
  let plan = planMemo.get(room);
  if (!plan) {
    const n = room.n;
    const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
    for (let i = 0; i < n; i++) { x[i] = room.X[i]; y[i] = room.Z[i]; z[i] = 1 - room.Y[i]; }
    plan = { x, y, z, size: new Float32Array(n).fill(PLAN_SIZE), bounds: PLAN_BOUNDS };
    planMemo.set(room, plan);
  }
  return plan;
}

/** A metric length (metres, or metres per beat) in the units of a space. */
export function lengthIn(space: V2Space, metres: number): number {
  return space === 'plan' ? metres / PLAN_METRES : metres;
}

/** Beats since the latest trigger interval began, from the instance's anchor. */
export function intervalAge(common: V2Common, frame: Pick<EffectFrame, 'beatPos' | 'anchorBeat'>): number {
  const interval = common.trigger.beatInterval;
  const t = frame.beatPos - frame.anchorBeat;
  return Number.isFinite(t) ? t - Math.floor(t / interval) * interval : 0;
}

function bandGate(common: V2Common, frame: EffectFrame): number | null {
  if (frame.audioMode !== 'reactive' || !frame.audio) return null;
  const level = clamp(frame.audio.party[common.trigger.band]);
  const threshold = clamp(Math.max(frame.master.threshold, common.trigger.threshold));
  return threshold >= 1 ? Number(level >= 1) : clamp((level - threshold) / (1 - threshold));
}

/** The trigger's level now: 1 on the timeline, an envelope pulse per interval for a beat accent, the band above its threshold for a volume gate. */
export function triggerLevel(common: V2Common, frame: EffectFrame): number {
  const { mode, reactiveDepth } = common.trigger;
  if (mode === 'timeline') return 1;
  const gate = bandGate(common, frame);
  let raw: number;
  if (mode === 'beatAccent') raw = sampleEnvelope(intervalAge(common, frame), common.envelope) * (gate ?? 1);
  else if (gate === null) return 1;
  else raw = gate;
  const depth = clamp(reactiveDepth * (gate === null ? 1 : frame.master.reactiveDepth));
  return 1 - depth + depth * raw;
}

/** A smooth crest (half height at `width`/2 either side) averaged over an emitter of radius `size`. */
export function soft(distance: number, width: number, size: number): number {
  const w = Math.max(1e-3, width);
  const d = Math.abs(distance);
  if (!(size > 1e-6)) return d < w ? 0.5 * (1 + Math.cos((Math.PI * d) / w)) : 0;
  if (d - size >= w) return 0;
  const integral = (t: number) => { const c = clamp(t, -w, w); return 0.5 * (c + (w / Math.PI) * Math.sin((Math.PI * c) / w)); };
  return (integral(d + size) - integral(d - size)) / (2 * size);
}

/** Write a slot: colour from the palette by colour mode, level over the background floor. */
export function paint(common: V2Common, frame: EffectFrame, position01: number, level: number, out: EffectSlot): void {
  const pos = common.colour === 'solid' ? 0
    : common.colour === 'time' ? frac((frame.beatPos - frame.anchorBeat) / TIME_CYCLE_BEATS) : position01;
  out.colour = frame.gradient?.sample(pos) ?? samplePalette(frame.palette, pos);
  const lit = common.background + (1 - common.background) * clamp(level);
  out.level = lit;
  out.strength = lit > 0 ? 1 : 0;
}
