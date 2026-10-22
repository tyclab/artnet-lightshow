import { z } from 'zod';
import { hash01 } from '../hash.ts';
import { registerKind } from '../registry.ts';
import { directionOf, extentAlong, lengthIn, paint, planDirectionOf, positionsOf, project, soft, triggerLevel, v2CommonSchema } from './common.ts';
import type { Point, Positions } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// A plane moving through the room: its normal is an azimuth and an elevation (90 runs floor to ceiling).
export const sweepSchema = v2CommonSchema.extend({
  azimuthDeg: z.number().min(-720).max(720).default(0),
  elevationDeg: z.number().min(-90).max(90).default(0),
  profile: z.enum(['crest', 'line', 'comet', 'gradient', 'stripe']).default('crest'),
  // Metres (plot fractions of a nominal 4 m plot in plan space) and metres per beat.
  width: z.number().min(0.01).max(20).default(0.6),
  speed: z.number().min(0).max(40).default(1.5),
  motion: z.enum(['loop', 'bounce', 'random']).default('loop'),
  // Degrees the plane turns per lap, continuously.
  turnPerLap: z.number().min(-720).max(720).default(0),
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
  const turns = lap0 > 0 ? travel / lap0 : 0;
  const d = directionAt(p, pos, turns);
  const [lo, hi] = extentAlong(pos, d);
  if (p.motion === 'bounce') {
    const span = Math.max(1e-6, hi - lo), u = travel - Math.floor(travel / (2 * span)) * 2 * span;
    return { d, lo, hi, crest: lo + (u < span ? u : 2 * span - u), heading: u < span ? 1 : -1, lap: Math.floor(travel / span) };
  }
  const length = hi - lo + 2 * width, lap = Math.floor(travel / length);
  return { d, lo, hi, crest: lo + (travel - lap * length), heading: 1, lap };
}

function renderSweep(p: SweepParams, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const pos = positionsOf(room, p.space);
  const space = pos.plan ? 'plan' : 'room';
  const width = lengthIn(space, p.width);
  const travel = lengthIn(space, p.speed) * (f.beatPos - f.anchorBeat);
  const pass = passOf(p, pos, Number.isFinite(travel) ? travel : 0, width, f.seed);
  const span = Math.max(1e-6, pass.hi - pass.lo);
  // A loop also draws the crest a lap behind, so it re-enters at the start while it leaves at the end.
  const loopLength = p.motion === 'loop' ? span + 2 * width : 0;
  const trigger = triggerLevel(p, f);
  for (let i = 0; i < room.n; i++) {
    const at = project(pos, i, pass.d);
    const delta = (at - pass.crest) * pass.heading;
    let lit = profileLevel(p.profile, delta, width, pos.size[i]);
    if (loopLength) lit = Math.max(lit, profileLevel(p.profile, delta + loopLength, width, pos.size[i]));
    const along = p.profile === 'gradient' ? (at - pass.crest) / (span + 2 * width) : (at - pass.lo) / span;
    paint(p, f, along, lit * trigger, out[i]);
  }
}

registerKind<SweepParams, Record<string, never>>({
  kind: 'v2.sweep', app: 'own', level: 'cell', schema: sweepSchema,
  defaults: { params: sweepSchema.parse({}), brightness: 1 },
  init: () => ({}),
  render: (params, _state, room, frame, out) => renderSweep(params, room, frame, out),
});
