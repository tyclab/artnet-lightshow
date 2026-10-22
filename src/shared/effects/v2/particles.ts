import { z } from 'zod';
import { registerKind } from '../registry.ts';
import { accentStrobes, centreOf, lengthIn, paint, pointIn, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import { pathEndpoints } from './path.ts';
import type { Point } from './common.ts';
import type { Room } from '../../room.ts';
import type { EffectFrame } from '../types.ts';

const point = z.object({ x: z.number().min(-100).max(100), y: z.number().min(0).max(100), z: z.number().min(-100).max(100) });
export const particlesSchema = v2CommonSchema.extend({
  mode: z.enum(['orbs', 'fireworks', 'rain']).default('orbs'),
  count: z.number().int().min(1).max(64).default(3),
  radiusM: z.number().min(0.05).max(5).default(0.8),
  pathRadiusM: z.number().min(0.1).max(20).default(2),
  cycleBeats: z.number().min(1).max(64).default(8),
  trail: z.number().int().min(0).max(8).default(4),
  gravity: z.number().min(0.05).max(10).default(0.8),
  speed: z.number().min(0.1).max(20).default(2),
  collide: z.boolean().default(false),
  fromAnchor: z.string().min(1).max(120).nullable().default(null),
  toAnchor: z.string().min(1).max(120).nullable().default(null),
  fromPoint: point.nullable().default(null),
  toPoint: point.nullable().default(null),
});
export type ParticlesParams = z.output<typeof particlesSchema>;
export interface LightParticle extends Point { radius: number; level: number; colour: number }
interface ParticleState { cells: Map<string, number[]>; cellSize: number; levels: Float32Array; colours: Float32Array }
const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function random(seed: number, key: number): number {
  let h = Math.imul(seed ^ key, 1597334677);
  h = Math.imul(h ^ h >>> 16, 2246822507);
  return ((h ^ h >>> 13) >>> 0) / 4294967295;
}

// Positions are solved from beat time, so seeking and preview replay need no particle simulation history.
export function particleObjects(p: ParticlesParams, room: Room, f: EffectFrame): LightParticle[] {
  const pos = positionsOf(room, p.space), scale = pos.plan ? 0.25 : 1;
  const { from, to } = pathEndpoints(p, room, pos);
  const centre = from && to ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }
    : pos.plan ? centreOf(pos) : room.space?.listener ?? centreOf(pos);
  const radius = p.radiusM * scale, path = p.pathRadiusM * scale, gravity = p.gravity * scale;
  const t = Math.max(0, f.beatPos - f.anchorBeat), objects: LightParticle[] = [];
  const height = pos.plan ? 1 : pos.bounds.height;
  const add = (x: number, y: number, z: number, r: number, level: number, colour: number) => {
    if (level > 0 && y >= -r) objects.push({ x, y: pos.plan ? 0 : y, z, radius: r, level, colour });
  };
  const place = (x: number, h: number, z: number, r: number, level: number, colour: number) => {
    add(x, pos.plan ? 0 : h, pos.plan ? 1 - h : z, r, level, colour);
  };
  if (p.mode === 'orbs') {
    const cycle = t / p.cycleBeats, phase = frac(cycle + (p.collide && f.modulation?.section === 'drop' ? 0.8 : 0));
    const collision = p.collide && (f.modulation?.section === 'drop' || phase > 0.8);
    const meet = collision ? Math.min(1, Math.max(0, 1 - (phase - 0.8) / 0.08)) : 1;
    if (collision && phase >= 0.88) {
      const age = (phase - 0.88) * p.cycleBeats, seed = f.seed[0] ^ Math.floor(cycle);
      for (let k = 0; k < Math.min(64, p.count * 8); k++) {
        const angle = TAU * random(seed, k * 3), lift = 2 * random(seed, k * 3 + 1) - 1;
        const speed = p.speed * scale;
        add(centre.x + Math.cos(angle) * speed * age, centre.y + lift * speed * age - gravity * age * age / 2,
          centre.z + Math.sin(angle) * speed * age, radius * 0.6, Math.max(0, 1 - age / (p.cycleBeats * 0.12)), k / Math.max(1, p.count * 8 - 1));
      }
      return objects;
    }
    for (let k = 0; k < p.count; k++) for (let tail = 0; tail <= p.trail; tail++) {
      const angle = TAU * (phase + k / p.count - tail * 0.0125);
      const along = (1 - Math.cos(angle)) / 2;
      const x = from && to ? lerp(centre.x, lerp(from.x, to.x, along), meet) : centre.x + Math.cos(angle) * path * meet;
      const y = from && to ? lerp(centre.y, lerp(from.y, to.y, along), meet) : centre.y + Math.sin(angle * 2) * height * 0.2 * meet;
      const z = from && to ? lerp(centre.z, lerp(from.z, to.z, along), meet) : centre.z + Math.sin(angle) * path * meet;
      add(x, y, z, radius * (1 - tail * 0.035), (1 - tail / (p.trail + 1)) ** 2, k / Math.max(1, p.count - 1));
    }
    return objects;
  }
  if (p.mode === 'fireworks') {
    const age = t % p.cycleBeats, seed = f.seed[0] ^ Math.floor(t / p.cycleBeats);
    const origin = from ?? pointIn(room, pos, room.space?.anchors.speakerLeft) ?? { ...centre, y: 0, z: pos.plan ? 1 : centre.z };
    const originHeight = pos.plan ? 1 - origin.z : origin.y;
    const launch = Math.min(p.cycleBeats * 0.3, Math.sqrt(2 * height * 0.7 / gravity));
    const velocity = Math.max(p.speed * scale, height * 0.7 / launch + gravity * launch / 2);
    const apex = Math.min(height, originHeight + velocity * launch - gravity * launch * launch / 2);
    if (age < launch) {
      for (let tail = 0; tail <= p.trail; tail++) {
        const a = Math.max(0, age - tail * 0.08);
        place(origin.x, originHeight + velocity * a - gravity * a * a / 2, origin.z, radius * 0.5, 1 - tail / (p.trail + 1), 0.15);
      }
    } else {
      const a = age - launch, life = Math.max(0.25, p.cycleBeats - launch);
      for (let k = 0; k < p.count; k++) {
        const angle = TAU * k / p.count + random(seed, k) * 0.3;
        const lift = 2 * random(seed, k + 64) - 1, speed = p.speed * scale;
        place(origin.x + Math.cos(angle) * speed * a, apex + lift * speed * a - gravity * a * a / 2,
          origin.z + Math.sin(angle) * speed * a, radius * 0.6, (1 - a / life) ** 2, k / Math.max(1, p.count - 1));
      }
    }
    return objects;
  }
  for (let k = 0; k < p.count; k++) {
    const q = t / p.cycleBeats + k / p.count, age = frac(q) * p.cycleBeats;
    const seed = f.seed[0] ^ Math.floor(q) * 7919;
    const x = pos.plan ? random(seed, k * 2) : (random(seed, k * 2) - 0.5) * pos.bounds.width;
    const z = pos.plan ? 0 : (random(seed, k * 2 + 1) - 0.5) * pos.bounds.depth;
    const speed = p.speed * scale, fall = (-speed + Math.sqrt(speed * speed + 2 * gravity * height)) / gravity;
    if (age < fall) {
      for (let tail = 0; tail <= p.trail; tail++) {
        const a = Math.max(0, age - tail * 0.04);
        place(x, height - speed * a - gravity * a * a / 2, z, radius * 0.45, 1 - tail / (p.trail + 1), k / p.count);
      }
    } else if (age < fall + 0.65) {
      const a = age - fall;
      for (let splash = 0; splash < 4; splash++) {
        const angle = splash * TAU / 4;
        place(x + Math.cos(angle) * a * scale, Math.max(0, 0.25 * scale * Math.sin(a / 0.65 * Math.PI)),
          z + Math.sin(angle) * a * scale, radius * 0.7, 1 - a / 0.65, k / p.count);
      }
    }
  }
  return objects;
}

function spatialIndex(p: ParticlesParams, room: Room): ParticleState {
  const pos = positionsOf(room, p.space), maxSize = Array.from(pos.size).reduce((a, b) => Math.max(a, b), 0);
  const cellSize = Math.max(lengthIn(pos.plan ? 'plan' : 'room', p.radiusM), maxSize, 0.02);
  const cells = new Map<string, number[]>();
  for (let i = 0; i < room.n; i++) {
    const key = `${Math.floor(pos.x[i] / cellSize)},${pos.plan ? 0 : Math.floor(pos.y[i] / cellSize)},${Math.floor(pos.z[i] / cellSize)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(i); else cells.set(key, [i]);
  }
  return { cells, cellSize, levels: new Float32Array(room.n), colours: new Float32Array(room.n) };
}

registerKind<ParticlesParams, ParticleState>({
  kind: 'v2.particles', app: 'own', level: 'cell', schema: particlesSchema,
  defaults: { params: particlesSchema.parse({}), brightness: 1 }, rapidFlashWhen: accentStrobes,
  init: spatialIndex,
  render(p, s, room, f, out) {
    const pos = positionsOf(room, p.space), trigger = triggerLevel(p, f), cell = s.cellSize;
    s.levels.fill(0); s.colours.fill(0);
    for (const particle of particleObjects(p, room, f)) {
      const reach = particle.radius + cell;
      const loX = Math.floor((particle.x - reach) / cell), hiX = Math.floor((particle.x + reach) / cell);
      const loY = pos.plan ? 0 : Math.floor((particle.y - reach) / cell), hiY = pos.plan ? 0 : Math.floor((particle.y + reach) / cell);
      const loZ = Math.floor((particle.z - reach) / cell), hiZ = Math.floor((particle.z + reach) / cell);
      for (let x = loX; x <= hiX; x++) for (let y = loY; y <= hiY; y++) for (let z = loZ; z <= hiZ; z++) {
        for (const i of s.cells.get(`${x},${y},${z}`) ?? []) {
          const d = Math.hypot(pos.x[i] - particle.x, pos.plan ? 0 : pos.y[i] - particle.y, pos.z[i] - particle.z);
          const level = soft(d, particle.radius, pos.size[i]) * particle.level;
          if (level > s.levels[i]) { s.levels[i] = level; s.colours[i] = particle.colour; }
        }
      }
    }
    for (let i = 0; i < room.n; i++) paint(p, f, s.colours[i], s.levels[i] * trigger, out[i]);
  },
});
