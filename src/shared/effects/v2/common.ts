import { z } from 'zod';
import type { Colour } from '../../../types/rig.ts';
import { requiresAcknowledgement } from '../registry.ts';
import { sampleEnvelope } from '../envelope.ts';
import { parseHex, samplePalette } from '../palette.ts';
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
  backgroundColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
});
export type V2Common = z.output<typeof v2CommonSchema>;

export interface Positions {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
  size: ArrayLike<number>;
  bounds: { width: number; depth: number; height: number };
  // True for the plot's unit box: generators then work in the plot's plane (x across, z down the rows).
  plan?: boolean;
}

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const frac = (v: number) => v - Math.floor(v);
const PLAN_BOUNDS = Object.freeze({ width: 1, depth: 1, height: 1 });
const planMemo = new WeakMap<Room, Positions>();
const roomMemo = new WeakMap<object, Positions>();

function roomPositions(space: NonNullable<Room['space']>): Positions {
  let positions = roomMemo.get(space);
  if (!positions) {
    positions = { x: space.x, y: space.y, z: space.z, size: space.size, bounds: space.bounds, plan: false };
    roomMemo.set(space, positions);
  }
  return positions;
}

/** Where a room's units are for a space: room metres from `room.space`, or the plot as a unit box (x across, z down the rows, y height). */
export function positionsOf(room: Room, space: V2Space): Positions {
  if (space === 'room' && room.space) return roomPositions(room.space);
  let plan = planMemo.get(room);
  if (!plan) {
    const n = room.n;
    const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
    for (let i = 0; i < n; i++) { x[i] = room.X[i]; y[i] = room.Z[i]; z[i] = 1 - room.Y[i]; }
    plan = { x, y, z, size: new Float32Array(n).fill(PLAN_SIZE), bounds: PLAN_BOUNDS, plan: true };
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

/** The trigger band above its threshold, 0..1, while live audio drives the show; null without it. */
export function bandGate(common: V2Common, frame: EffectFrame): number | null {
  if (frame.audioMode !== 'reactive' || !frame.audio) return null;
  const level = clamp(frame.audio.party[common.trigger.band]);
  const threshold = clamp(Math.max(frame.master.threshold, common.trigger.threshold));
  return threshold >= 1 ? Number(level >= 1) : clamp((level - threshold) / (1 - threshold));
}

/** A flash envelope: no attack and gone within a fifth of a beat. */
export function isFlashEnvelope(envelope: V2Common['envelope']): boolean {
  return envelope.attack <= 0.02 && envelope.hold + envelope.release <= 0.2;
}

/** A beat accent fast and short enough to strobe: every v2 kind then asks for the photosensitivity acknowledgement. */
export function accentStrobes(common: Pick<V2Common, 'trigger' | 'envelope'>): boolean {
  return common.trigger.mode === 'beatAccent' && common.trigger.beatInterval <= 0.25 && isFlashEnvelope(common.envelope);
}

/** A beat accent's peak now: the band gate with live audio, else full, kept above the depth floor. */
export function accentPeak(common: V2Common, frame: EffectFrame): number {
  const gate = bandGate(common, frame);
  const depth = clamp(common.trigger.reactiveDepth * (gate === null ? 1 : frame.master.reactiveDepth));
  return 1 - depth + depth * (gate ?? 1);
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

/**
 * A smooth crest (half height at `width`/2 either side), averaged over an emitter of radius `size`
 * and scaled so its peak stays 1: a large lamp fades in and out across a thin line instead of switching.
 */
export function soft(distance: number, width: number, size: number): number {
  const w = Math.max(1e-3, width);
  const d = Math.abs(distance);
  if (!(size > 1e-6)) return d < w ? 0.5 * (1 + Math.cos((Math.PI * d) / w)) : 0;
  if (d - size >= w) return 0;
  const integral = (t: number) => { const c = clamp(t, -w, w); return 0.5 * (c + (w / Math.PI) * Math.sin((Math.PI * c) / w)); };
  return (integral(d + size) - integral(d - size)) / (integral(size) - integral(-size));
}

const backgroundColours = new WeakMap<V2Common, { hex: string; colour: Colour }>();
function backgroundColour(common: V2Common): Colour {
  let cached = backgroundColours.get(common);
  if (!cached || cached.hex !== common.backgroundColour) {
    cached = { hex: common.backgroundColour, colour: parseHex(common.backgroundColour) };
    backgroundColours.set(common, cached);
  }
  return cached.colour;
}

/** A generator with an authored floor has a bed under every slot, so no gap for Between effect hits to change. */
export const gapsWithoutFloor = (p: { background: number; idle?: number }): boolean => !(Math.max(p.background, p.idle ?? 0) > 0);

/** Write a slot: colour from the palette by colour mode, level over the background floor. */
export function paint(common: V2Common, frame: EffectFrame, position01: number, level: number, out: EffectSlot): void {
  const pos = common.colour === 'solid' ? 0
    : common.colour === 'time' ? frac((frame.beatPos - frame.anchorBeat) / TIME_CYCLE_BEATS) : position01;
  const foreground = clamp(level);
  const background = common.background * (1 - foreground);
  const lit = foreground + background;
  // Without an authored floor the uncovered share is a gap, published only when the effect reveals it.
  out.background = common.background > 0 || frame.revealGaps !== false ? { colour: backgroundColour(common), level: background,
    fullLevel: common.background, coverage: 1 - foreground, dark: foreground === 0 && requiresAcknowledgement(frame.spec) } : undefined;
  if (!(lit > 0)) {
    out.colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
    out.level = 0;
    // A generator owns its dark rests; transparency would reveal the base look beneath a voice.
    out.strength = 1;
    return;
  }
  const colour = frame.gradient?.sample(pos) ?? samplePalette(frame.palette, pos);
  if (background > 0) {
    const base = backgroundColour(common);
    const mix = (a = 0, b = 0) => (a * foreground + b * background) / lit;
    out.colour = { r: mix(colour.r, base.r), g: mix(colour.g, base.g), b: mix(colour.b, base.b),
      w: mix(colour.w, base.w), a: mix(colour.a, base.a), uv: mix(colour.uv, base.uv) };
  } else out.colour = colour;
  out.level = lit;
  out.strength = lit > 0 ? 1 : 0;
}

// ── Geometry shared by the generators ───────────────────────────────────────
// Azimuths are degrees seen from above, clockwise: 0 looks toward -z (the plot top), 90 toward +x.

export interface Point { x: number; y: number; z: number }

/** The unit vector of an azimuth and an elevation (90 is straight up). */
export function directionOf(azimuthDeg: number, elevationDeg: number): Point {
  const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
  return { x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: -Math.cos(el) * Math.cos(az) };
}

/** The same direction on the plot, where "up" folds onto the rows toward the top of the plot. */
export function planDirectionOf(azimuthDeg: number, elevationDeg: number): Point {
  const d = directionOf(azimuthDeg, elevationDeg);
  const x = d.x, z = d.z - d.y, length = Math.hypot(x, z);
  return length > 1e-6 ? { x: x / length, y: 0, z: z / length } : { x: 0, y: 0, z: -1 };
}

/** Projection onto a direction: on the plot only x and z count. */
export function project(pos: Positions, i: number, d: Point): number {
  return pos.x[i] * d.x + (pos.plan ? 0 : pos.y[i] * d.y) + pos.z[i] * d.z;
}

/** The room box (or the plot square) projected onto a direction, as [lo, hi]. */
export function extentAlong(pos: Positions, d: Point): [number, number] {
  const span = (a: number, b: number, k: number): [number, number] => [Math.min(a * k, b * k), Math.max(a * k, b * k)];
  const { width, depth, height } = pos.bounds;
  const parts = pos.plan ? [span(0, 1, d.x), span(0, 1, d.z)]
    : [span(-width / 2, width / 2, d.x), span(0, height, d.y), span(-depth / 2, depth / 2, d.z)];
  return [parts.reduce((sum, [lo]) => sum + lo, 0), parts.reduce((sum, [, hi]) => sum + hi, 0)];
}

/** The centre of the space: the room's middle, or the middle of the plot. */
export function centreOf(pos: Positions): Point {
  return pos.plan ? { x: 0.5, y: 0.5, z: 0.5 } : { x: 0, y: pos.bounds.height / 2, z: 0 };
}

/** Distance between a unit and a point: 3D in the room, across the plot's plane on the plan. */
export function distanceTo(pos: Positions, i: number, p: Point): number {
  return pos.plan ? Math.hypot(pos.x[i] - p.x, pos.z[i] - p.z) : Math.hypot(pos.x[i] - p.x, pos.y[i] - p.y, pos.z[i] - p.z);
}

/** The farthest corner of the room box (or plot square) from a point. */
export function farthestCorner(pos: Positions, p: Point): number {
  const { width, depth, height } = pos.bounds;
  const xs = pos.plan ? [0, 1] : [-width / 2, width / 2], zs = pos.plan ? [0, 1] : [-depth / 2, depth / 2], ys = pos.plan ? [p.y] : [0, height];
  let far = 0;
  for (const x of xs) for (const y of ys) for (const z of zs) far = Math.max(far, Math.hypot(x - p.x, y - p.y, z - p.z));
  return far;
}

/** Azimuth of a unit around a vertical axis through a point, in [0, 360). */
export function azimuthAround(pos: Positions, i: number, p: Point): number {
  const deg = (Math.atan2(pos.x[i] - p.x, -(pos.z[i] - p.z)) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

const nearestMemo = new WeakMap<Room, Map<string, Point>>();

/**
 * A room point (an anchor, a listener) in a space: itself in the room, or on the plot the plan position
 * of the unit nearest to it in the room, so a 2D form starts from the lamps beside it.
 */
export function pointIn(room: Room, pos: Positions, metres: Point | null | undefined): Point | null {
  if (!metres) return null;
  if (!pos.plan) return metres;
  const space = room.space;
  if (!space || !room.n) return null;
  const key = `${metres.x},${metres.y},${metres.z}`;
  let seen = nearestMemo.get(room);
  if (!seen) { seen = new Map(); nearestMemo.set(room, seen); }
  let found = seen.get(key);
  if (!found) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < room.n; i++) {
      const d = Math.hypot(space.x[i] - metres.x, space.y[i] - metres.y, space.z[i] - metres.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    found = { x: pos.x[best], y: pos.y[best], z: pos.z[best] };
    seen.set(key, found);
  }
  return found;
}
