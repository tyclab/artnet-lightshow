import { z } from 'zod';
import { registerKind } from '../registry.ts';
import { accentStrobes, centreOf, gapsWithoutFloor, lengthIn, paint, pointIn, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import { pathEndpoints } from './path.ts';
import { DEFAULT_BOUNDS } from '../../space.ts';
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
interface SoftProfile { width: number; frequency: number; spread: Float64Array; denominator: Float64Array }
interface ParticleState { cells: Map<string, number[]>; cellSize: number; levels: Float32Array; colours: Float32Array; winners: Int32Array; roundedDown: Uint8Array; profiles: Map<number, SoftProfile> }
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
    const explicitLaunch = pos.plan && p.fromPoint ? { x: 0.5 + p.fromPoint.x / (room.space?.bounds.width ?? DEFAULT_BOUNDS.width), y: 0,
      z: 1 - p.fromPoint.y / (room.space?.bounds.height ?? DEFAULT_BOUNDS.height) } : null;
    const origin = explicitLaunch ?? from ?? pointIn(room, pos, room.space?.anchors.speakerLeft) ?? { ...centre, y: 0, z: pos.plan ? 1 : centre.z };
    const originHeight = pos.plan ? 1 - origin.z : origin.y;
    let launch = Math.min(p.cycleBeats * 0.3, Math.sqrt(2 * height * 0.7 / gravity));
    const velocity = Math.max(p.speed * scale, height * 0.7 / launch + gravity * launch / 2);
    const remaining = height - originHeight, discriminant = velocity * velocity - 2 * gravity * remaining;
    // Burst at the first ceiling crossing; clamping only the burst position teleports a high launch back down.
    if (remaining >= 0 && discriminant >= 0) launch = Math.min(launch, 2 * remaining / (velocity + Math.sqrt(discriminant)));
    const apex = originHeight + velocity * launch - gravity * launch * launch / 2;
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
  return { cells, cellSize, levels: new Float32Array(room.n), colours: new Float32Array(room.n),
    winners: new Int32Array(room.n), roundedDown: new Uint8Array(room.n), profiles: new Map() };
}

function profileFor(radius: number, sizes: ArrayLike<number>, state: ParticleState): SoftProfile {
  let profile = state.profiles.get(radius);
  if (profile) return profile;
  const width = Math.max(0.001, radius), frequency = Math.PI / width;
  const spread = Float64Array.from({ length: sizes.length }, (_, i) => width / Math.PI * Math.sin(frequency * Math.min(width, sizes[i])));
  profile = { width, frequency, spread, denominator: Float64Array.from(spread, (value, i) => Math.min(width, sizes[i]) + value) };
  state.profiles.set(radius, profile);
  return profile;
}

function particleLevel(distance: number, size: number, profile: SoftProfile, i: number): number {
  if (size <= 1e-6 || distance + size >= profile.width) return soft(distance, profile.width, size);
  // The symmetric footprint integral simplifies to one cosine; its size-dependent terms are immutable.
  return (size + profile.spread[i] * Math.cos(profile.frequency * distance)) / profile.denominator[i];
}

function retainLevel(state: ParticleState, i: number, level: number, colour: number, index: number): void {
  const rounded = Math.fround(level), down = level > rounded;
  // Preserve the original Float32 accumulation tie order, independent of evaluation order.
  const wins = rounded > state.levels[i] || (level > 0 && rounded === state.levels[i]
    && (down ? !state.roundedDown[i] || index > state.winners[i] : !state.roundedDown[i] && index < state.winners[i]));
  if (wins) { state.levels[i] = rounded; state.colours[i] = colour; state.winners[i] = index; state.roundedDown[i] = Number(down); }
}

const roundedBuffer = new ArrayBuffer(4), roundedFloat = new Float32Array(roundedBuffer), roundedBits = new Uint32Array(roundedBuffer);
function lowerRoundingBoundary(value: number): number {
  if (!(value > 0)) return 0;
  roundedFloat[0] = value; roundedBits[0]--;
  return (value + roundedFloat[0]) / 2;
}

interface ParticleTree { particle: LightParticle; index: number; axis: 'x' | 'y' | 'z'; left: ParticleTree | null; right: ParticleTree | null; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
function particleTree(indices: number[], particles: LightParticle[], plan: boolean, depth = 0): ParticleTree | null {
  if (!indices.length) return null;
  const axis = (plan ? ['x', 'z'] : ['x', 'y', 'z'])[depth % (plan ? 2 : 3)] as ParticleTree['axis'];
  indices.sort((a, b) => particles[a][axis] - particles[b][axis]);
  const middle = indices.length >> 1, index = indices[middle], particle = particles[index];
  const left = particleTree(indices.slice(0, middle), particles, plan, depth + 1);
  const right = particleTree(indices.slice(middle + 1), particles, plan, depth + 1);
  return { particle, index, axis, left, right,
    minX: Math.min(particle.x, left?.minX ?? Infinity, right?.minX ?? Infinity),
    maxX: Math.max(particle.x, left?.maxX ?? -Infinity, right?.maxX ?? -Infinity),
    minY: Math.min(particle.y, left?.minY ?? Infinity, right?.minY ?? Infinity),
    maxY: Math.max(particle.y, left?.maxY ?? -Infinity, right?.maxY ?? -Infinity),
    minZ: Math.min(particle.z, left?.minZ ?? Infinity, right?.minZ ?? Infinity),
    maxZ: Math.max(particle.z, left?.maxZ ?? -Infinity, right?.maxZ ?? -Infinity) };
}
function outsideTree(node: ParticleTree, x: number, y: number, z: number, reach: number): boolean {
  const dx = Math.max(0, node.minX - x, x - node.maxX);
  const dy = Math.max(0, node.minY - y, y - node.maxY);
  const dz = Math.max(0, node.minZ - z, z - node.maxZ);
  return dx * dx + dy * dy + dz * dz > reach;
}
function nearestSquared(node: ParticleTree | null, x: number, y: number, z: number, best: number): number {
  if (!node || outsideTree(node, x, y, z, best)) return best;
  const dx = x - node.particle.x, dy = y - node.particle.y, dz = z - node.particle.z;
  best = Math.min(best, dx * dx + dy * dy + dz * dz);
  const delta = node.axis === 'x' ? dx : node.axis === 'y' ? dy : dz;
  best = nearestSquared(delta < 0 ? node.left : node.right, x, y, z, best);
  if (delta * delta <= best) best = nearestSquared(delta < 0 ? node.right : node.left, x, y, z, best);
  return best;
}
function retainNearby(node: ParticleTree | null, x: number, y: number, z: number, reach: number, size: number,
  profile: SoftProfile, state: ParticleState, unit: number): void {
  if (!node || outsideTree(node, x, y, z, reach)) return;
  const dx = x - node.particle.x, dy = y - node.particle.y, dz = z - node.particle.z;
  const squared = dx * dx + dy * dy + dz * dz;
  if (squared <= reach) retainLevel(state, unit, particleLevel(Math.sqrt(squared), size, profile, unit) * node.particle.level,
    node.particle.colour, node.index);
  const delta = node.axis === 'x' ? dx : node.axis === 'y' ? dy : dz;
  retainNearby(delta < 0 ? node.left : node.right, x, y, z, reach, size, profile, state, unit);
  if (delta * delta <= reach) retainNearby(delta < 0 ? node.right : node.left, x, y, z, reach, size, profile, state, unit);
}

function renderGroupedParticles(particles: LightParticle[], room: Room, p: ParticlesParams, state: ParticleState): number[] {
  const pos = positionsOf(room, p.space);
  const groups = new Map<string, { indices: number[]; profile: SoftProfile; level: number }>();
  for (let i = 0; i < particles.length; i++) {
    const particle = particles[i], key = `${particle.radius}/${particle.level}`;
    let group = groups.get(key);
    if (!group) { group = { indices: [], profile: profileFor(particle.radius, pos.size, state), level: particle.level }; groups.set(key, group); }
    group.indices.push(i);
  }
  const minimum = p.mode === 'rain' ? 24 : 8;
  const ungrouped = [...groups.values()].filter((group) => group.indices.length < minimum).flatMap((group) => group.indices);
  const sorted = [...groups.values()].filter((group) => group.indices.length >= minimum).sort((a, b) => b.level - a.level)
    .map((group) => ({ ...group, tree: particleTree(group.indices, particles, !!pos.plan) }));
  for (let i = 0; i < room.n; i++) for (const group of sorted) {
    if (Math.fround(group.level) < state.levels[i]) continue;
    const size = pos.size[i], profile = group.profile, support = profile.width + size;
    const x = pos.x[i], y = pos.plan ? 0 : pos.y[i], z = pos.z[i];
    const nearest = nearestSquared(group.tree, x, y, z, support * support);
    if (nearest >= support * support) continue;
    const maximum = particleLevel(Math.sqrt(nearest), size, profile, i) * group.level;
    const rounded = Math.fround(maximum);
    if (rounded < state.levels[i]) continue;
    const minimum = lowerRoundingBoundary(rounded) / group.level;
    let reach = support;
    const cosine = (minimum * profile.denominator[i] - size) / profile.spread[i];
    if (size > 1e-6 && cosine >= -1 && cosine <= 1) {
      const interior = Math.acos(cosine) / profile.frequency;
      if (interior + size < profile.width) reach = interior + 1e-9;
    }
    // Equal radius/level particles share a monotone profile: only the nearest Float32 bin can win.
    retainNearby(group.tree, x, y, z, reach * reach, size, profile, state, i);
  }
  return ungrouped;
}

registerKind<ParticlesParams, ParticleState>({
  kind: 'v2.particles', app: 'own', level: 'cell', schema: particlesSchema, gapsApply: gapsWithoutFloor,
  defaults: { params: particlesSchema.parse({}), brightness: 1 }, rapidFlashWhen: accentStrobes,
  init: spatialIndex,
  render(p, s, room, f, out) {
    const pos = positionsOf(room, p.space), trigger = triggerLevel(p, f), cell = s.cellSize;
    s.levels.fill(0); s.colours.fill(0); s.winners.fill(2147483647); s.roundedDown.fill(0);
    const particles = particleObjects(p, room, f);
    const order = p.count >= 8 ? renderGroupedParticles(particles, room, p, s) : particles.map((_, i) => i);
    order.sort((a, b) => particles[b].level - particles[a].level);
    for (const index of order) {
      const particle = particles[index];
      const profile = profileFor(particle.radius, pos.size, s);
      const reach = particle.radius + cell;
      const loX = Math.floor((particle.x - reach) / cell), hiX = Math.floor((particle.x + reach) / cell);
      const loY = pos.plan ? 0 : Math.floor((particle.y - reach) / cell), hiY = pos.plan ? 0 : Math.floor((particle.y + reach) / cell);
      const loZ = Math.floor((particle.z - reach) / cell), hiZ = Math.floor((particle.z + reach) / cell);
      for (let x = loX; x <= hiX; x++) for (let y = loY; y <= hiY; y++) for (let z = loZ; z <= hiZ; z++) {
        for (const i of s.cells.get(`${x},${y},${z}`) ?? []) {
          if (s.levels[i] > Math.fround(particle.level)) continue;
          const dx = pos.x[i] - particle.x, dy = pos.plan ? 0 : pos.y[i] - particle.y, dz = pos.z[i] - particle.z;
          const squared = dx * dx + dy * dy + dz * dz, support = particle.radius + pos.size[i];
          if (squared >= support * support) continue;
          const level = particleLevel(Math.sqrt(squared), pos.size[i], profile, i) * particle.level;
          retainLevel(s, i, level, particle.colour, index);
        }
      }
    }
    for (let i = 0; i < room.n; i++) paint(p, f, s.colours[i], s.levels[i] * trigger, out[i]);
  },
});
