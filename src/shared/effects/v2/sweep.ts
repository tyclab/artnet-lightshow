import { z } from 'zod';
import { hash01 } from '../hash.ts';
import { registerKind } from '../registry.ts';
import { accentStrobes, bandGate, directionOf, extentAlong, lengthIn, paint, planDirectionOf, positionsOf, project, soft, triggerLevel, v2CommonSchema } from './common.ts';
import { pathEndpoints } from './path.ts';
import type { Point, Positions } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// A plane moving through the room: its normal is an azimuth and an elevation (90 runs floor to ceiling).
export const sweepSchema = v2CommonSchema.extend({
  azimuthDeg: z.number().min(-720).max(720).default(0),
  elevationDeg: z.number().min(-90).max(90).default(0),
  profile: z.enum(['crest', 'line', 'comet', 'gradient', 'stripe', 'fill']).default('crest'),
  // Metres (plot fractions of a nominal 4 m plot in plan space) and metres per beat.
  width: z.number().min(0.01).max(20).default(0.6),
  speed: z.number().min(0).max(40).default(1.5),
  motion: z.enum(['loop', 'bounce', 'random']).default('loop'),
  // Degrees the plane turns per lap, continuously.
  turnPerLap: z.number().min(-720).max(720).default(0),
  fillSource: z.enum(['cycle', 'once', 'section', 'volume']).default('cycle'),
  lengthBeats: z.number().min(1).max(256).default(16),
  falling: z.boolean().default(false),
  fromAnchor: z.string().min(1).max(120).nullable().default(null),
  toAnchor: z.string().min(1).max(120).nullable().default(null),
  fromPoint: z.object({ x: z.number().min(-100).max(100), y: z.number().min(0).max(100), z: z.number().min(-100).max(100) }).nullable().default(null),
  toPoint: z.object({ x: z.number().min(-100).max(100), y: z.number().min(0).max(100), z: z.number().min(-100).max(100) }).nullable().default(null),
});
export type SweepParams = z.output<typeof sweepSchema>;

const COMET_TAIL = 4;

/** How lit a unit is at signed distance `delta` from the crest, moving toward +delta. */
function profileLevel(profile: SweepParams['profile'], delta: number, width: number, size: number): number {
  switch (profile) {
    case 'line': {
      const half = width / 2, edge = Math.max(1e-3, width * 0.15);
      return Math.abs(delta) <= half ? 1 : soft(Math.abs(delta) - half, edge, size);
    }
    case 'comet': {
      const head = soft(delta, width, size);
      if (delta >= 0) return head;
      const tail = 1 + delta / (COMET_TAIL * width);
      return Math.max(head, tail > 0 ? tail * tail : 0);
    }
    case 'stripe': {
      const period = 2 * width, folded = delta - Math.round(delta / period) * period;
      return soft(folded, width, size);
    }
    case 'gradient': return 1;
    default: return soft(delta, width, size);
  }
}

interface Pass { d: Point; lo: number; hi: number; crest: number; heading: 1 | -1; lap: number }

function directionAt(p: SweepParams, pos: Positions, turns: number): Point {
  const az = p.azimuthDeg + p.turnPerLap * turns;
  return pos.plan ? planDirectionOf(az, p.elevationDeg) : directionOf(az, p.elevationDeg);
}

// Where the crest is along the plane's normal at `travel` metres from the start.
function passOf(p: SweepParams, pos: Positions, travel: number, width: number, seed: EffectFrame['seed']): Pass {
  const base = directionAt(p, pos, 0);
  const [lo0, hi0] = extentAlong(pos, base);
  const lap0 = hi0 - lo0 + 2 * width;
  if (p.motion === 'random') {
    // A lap of fixed length; each lap a fresh direction, entering and leaving the room whole.
    const diagonal = pos.plan ? Math.SQRT2 : Math.hypot(pos.bounds.width, pos.bounds.depth, pos.bounds.height);
    const length = diagonal + 2 * width, lap = Math.floor(travel / length), q = travel / length - lap;
    const d = pos.plan ? planDirectionOf(p.azimuthDeg + 360 * hash01(seed, 3, lap), p.elevationDeg)
      : directionOf(p.azimuthDeg + 360 * hash01(seed, 3, lap), p.elevationDeg);
    const [lo, hi] = extentAlong(pos, d);
    return { d, lo, hi, crest: lo - width + q * (hi - lo + 2 * width), heading: 1, lap };
  }
  // The phase runs on the base direction's lengths, so a turning plane never changes the crest's pace:
  // the crest sits at the same fraction of whatever span the plane has now.
  if (p.motion === 'bounce') {
    const span0 = Math.max(1e-6, hi0 - lo0), u = travel - Math.floor(travel / (2 * span0)) * 2 * span0;
    const d = directionAt(p, pos, travel / span0);
    const [lo, hi] = extentAlong(pos, d);
    return { d, lo, hi, crest: lo + (u < span0 ? u : 2 * span0 - u) * ((hi - lo) / span0), heading: u < span0 ? 1 : -1, lap: Math.floor(travel / span0) };
  }
  const lap = Math.floor(travel / lap0);
  const d = directionAt(p, pos, travel / lap0);
  const [lo, hi] = extentAlong(pos, d);
  return { d, lo, hi, crest: lo + (travel - lap * lap0) * ((hi - lo + 2 * width) / lap0), heading: 1, lap };
}

function renderSweep(p: SweepParams, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const pos = positionsOf(room, p.space);
  const space = pos.plan ? 'plan' : 'room';
  const width = lengthIn(space, p.width);
  const travel = lengthIn(space, p.speed) * (f.beatPos - f.anchorBeat);
  let pass = passOf(p, pos, Number.isFinite(travel) ? travel : 0, width, f.seed);
  const { from, to } = pathEndpoints(p, room, pos);
  if (from && to) {
    const dx = to.x - from.x, dy = pos.plan ? 0 : to.y - from.y, dz = to.z - from.z, distance = Math.hypot(dx, dy, dz);
    if (distance > 1e-6) {
      const d = { x: dx / distance, y: dy / distance, z: dz / distance };
      const lo = from.x * d.x + (pos.plan ? 0 : from.y * d.y) + from.z * d.z;
      const phase = travel / distance, lap = Math.floor(phase), q = phase - lap;
      const reversed = p.motion === 'bounce' && lap % 2 === 1;
      pass = { d, lo, hi: lo + distance, crest: lo + (reversed ? 1 - q : q) * distance, heading: reversed ? -1 : 1, lap };
    }
  }
  const span = Math.max(1e-6, pass.hi - pass.lo);
  // A loop also draws the crest a lap behind, so it re-enters at the start while it leaves at the end.
  const loopLength = p.motion === 'loop' ? span + 2 * width : 0;
  const trigger = triggerLevel(p, f);
  const age = Math.max(0, f.beatPos - f.anchorBeat);
  const progress = p.fillSource === 'volume' ? bandGate(p, f) ?? 1 : p.fillSource === 'once' ? Math.min(1, age / p.lengthBeats) : p.fillSource === 'section'
    ? f.modulation?.sectionProgress ?? Math.min(1, age / p.lengthBeats) : age / p.lengthBeats % 1;
  const fill = p.falling ? 1 - progress : progress;
  for (let i = 0; i < room.n; i++) {
    const at = project(pos, i, pass.d);
    const delta = (at - pass.crest) * pass.heading;
    const along = p.profile === 'gradient' ? (at - pass.crest) / (span + 2 * width) : (at - pass.lo) / span;
    let lit = p.profile === 'fill' ? (fill <= 0 ? 0 : Math.min(1, Math.max(0, (fill - along) * span / Math.max(width, pos.size[i]) + 0.5)))
      : profileLevel(p.profile, delta, width, pos.size[i]);
    if (p.profile === 'fill') lit *= 0.78 + 0.22 * (1 + Math.cos(age * Math.PI * 2 * (1 + 3 * progress))) / 2;
    if (loopLength && p.profile !== 'fill') lit = Math.max(lit, profileLevel(p.profile, delta + loopLength, width, pos.size[i]));
    paint(p, f, p.falling ? 1 - along : along, lit * trigger, out[i]);
  }
}

registerKind<SweepParams, Record<string, never>>({
  kind: 'v2.sweep', app: 'own', level: 'cell', schema: sweepSchema,
  defaults: { params: sweepSchema.parse({}), brightness: 1 },
  rapidFlashWhen: accentStrobes,
  init: () => ({}),
  render: (params, _state, room, frame, out) => renderSweep(params, room, frame, out),
});
