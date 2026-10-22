import type { Rig } from './rig.ts';
import type { RoomScene } from './room-scene.ts';

// Room metres: origin at the floor centre, x = width, y = height above the floor, z = depth.
export interface Vec3 { x: number; y: number; z: number }
export interface Listener extends Vec3 { facingDeg: number }

export interface UnitSpace {
  revision: string;
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  // Emitter radius in metres.
  size: Float32Array;
  // 1 for a unit a room binding placed, 0 for the plot fallback.
  bound: Uint8Array;
  bounds: { width: number; depth: number; height: number };
  anchors: Readonly<Record<string, Vec3>>;
  listeners: Readonly<Record<string, Listener>>;
}

export interface SpaceReport { unbound: number[]; shared: number[]; far: { unit: number; metres: number }[] }

export interface RoomSpace {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  size: Float32Array;
  bounds: UnitSpace['bounds'];
  listener: Listener;
  anchors: Readonly<Record<string, Vec3>>;
}

// Without an imported room, the generic Stage venue the 3D view draws.
export const DEFAULT_BOUNDS: UnitSpace['bounds'] = Object.freeze({ width: 12, depth: 8, height: 4.6 });
const SEATED = 1.2;
const PAR_SIZE = 0.1;
const LAMP_SIZE = 0.15;
const CELL_SIZE = 0.05;
const FAR_METRES = 1;

type Binding = RoomScene['bindings'][number];
type FixtureWithId = Rig['fixtures'][number] & { id?: number | string };
export interface BindingSource { fixtureId: number; unit: number; weight: number }
export interface ResolvedSource { unit: number | null; weight: number; fixtureId?: number; local?: number }
export interface ResolvedBinding { binding: Binding; sources: ResolvedSource[]; missingSources: number }
export interface OutputUse { fixtureId: number; unit: number; bindings: string[] }

export const bindingSources = (binding: Binding | Record<string, unknown>): BindingSource[] => {
  const b = binding as { sources?: BindingSource[]; fixtureId: number; unit?: number };
  return b.sources || [{ fixtureId: b.fixtureId, unit: b.unit ?? 0, weight: 1 }];
};

/** Each binding's sources as rig unit indices (null where the fixture or cell does not exist), as the Stage and the engine share them. */
export function resolveBindings(fixtures: readonly FixtureWithId[], rig: Pick<Rig, 'ranges'>, bindings: readonly Binding[]): {
  resolved: ResolvedBinding[]; mapped: Map<number, Set<number>>; outputs: Map<string, OutputUse>;
} {
  const indices = new Map(fixtures.map((fixture, index) => [fixture.id, index]));
  const mapped = new Map<number, Set<number>>();
  const outputs = new Map<string, OutputUse>();
  const resolved = bindings.map((binding) => {
    const sources: ResolvedSource[] = bindingSources(binding).map((source) => {
      const index = indices.get(source.fixtureId), local = source.unit ?? 0;
      if (index === undefined || !Number.isInteger(local) || local < 0 || local >= rig.ranges[index].count) return { ...source, unit: null };
      if (!mapped.has(source.fixtureId)) mapped.set(source.fixtureId, new Set());
      mapped.get(source.fixtureId)!.add(local);
      const key = `${source.fixtureId}:${local}`;
      if (!outputs.has(key)) outputs.set(key, { fixtureId: source.fixtureId, unit: local, bindings: [] });
      outputs.get(key)!.bindings.push(binding.label || binding.id);
      return { unit: rig.ranges[index].start + local, weight: source.weight };
    });
    return { binding, sources, missingSources: sources.filter((source) => source.unit === null).length };
  });
  return { resolved, mapped, outputs };
}

function fallback(rig: Rig, u: number, bounds: UnitSpace['bounds']): Vec3 {
  const p = rig.points[u], fixture = rig.fixtures[rig.units[u].fixture];
  const height = p.height ?? fixture.position?.height ?? 50;
  return { x: (p.x / 100 - 0.5) * bounds.width, y: (height / 100) * bounds.height, z: (p.y / 100 - 0.5) * bounds.depth };
}

// A strip path places a run of cells: from its own unit up to the next cell another binding names.
function pathPoints(path: readonly Vec3[], count: number): Vec3[] {
  const lengths = path.slice(1).map((to, k) => Math.hypot(to.x - path[k].x, to.y - path[k].y, to.z - path[k].z));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return Array.from({ length: count }, (_, c) => {
    let along = ((c + 0.5) / count) * total, k = 0;
    while (k < lengths.length - 1 && along > lengths[k]) along -= lengths[k++];
    const t = lengths[k] > 0 ? Math.min(1, along / lengths[k]) : 0, a = path[k], b = path[k + 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  });
}

function placements(rig: Rig, room: RoomScene): { sums: Vec3[]; counts: number[]; pitch: Map<number, number> } {
  const fixtures = rig.fixtures as readonly FixtureWithId[];
  const sums = rig.units.map(() => ({ x: 0, y: 0, z: 0 }));
  const counts = rig.units.map(() => 0);
  const pitch = new Map<number, number>();
  const add = (u: number, p: Vec3) => { sums[u].x += p.x; sums[u].y += p.y; sums[u].z += p.z; counts[u]++; };
  const { resolved, mapped } = resolveBindings(fixtures, rig, room.bindings);
  const index = new Map(fixtures.map((fixture, i) => [fixture.id, i]));
  for (const { binding, sources, missingSources } of resolved) {
    if (missingSources === sources.length) continue;
    if ('sources' in binding || !binding.path) {
      for (const source of sources) if (source.unit !== null) add(source.unit, binding.position);
      continue;
    }
    const i = index.get(binding.fixtureId)!, local = binding.unit ?? 0, { start, count } = rig.ranges[i];
    const named = [...(mapped.get(binding.fixtureId) ?? [])].filter((other) => other > local);
    const run = (named.length ? Math.min(...named) : count) - local;
    const points = pathPoints(binding.path, run);
    points.forEach((p, k) => add(start + local + k, p));
    if (run > 1) pitch.set(i, Math.min(pitch.get(i) ?? Infinity, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y, points[1].z - points[0].z)));
  }
  return { sums, counts, pitch };
}

// FNV-1a over the bytes, in two lanes so equal content always gives the same revision.
function hashBytes(parts: readonly Uint8Array[]): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (const bytes of parts) for (let k = 0; k < bytes.length; k++) {
    a = Math.imul(a ^ bytes[k], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[k], 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Every rig unit in room metres: a room binding where one names it, else its plot position scaled into the room. */
export function buildUnitSpace(rig: Rig, room: RoomScene | null): UnitSpace {
  const n = rig.units.length;
  const bounds = room ? { ...room.bounds } : { ...DEFAULT_BOUNDS };
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), size = new Float32Array(n);
  const bound = new Uint8Array(n);
  const placed = room ? placements(rig, room) : null;
  for (let u = 0; u < n; u++) {
    const count = placed?.counts[u] ?? 0;
    const p = count ? { x: placed!.sums[u].x / count, y: placed!.sums[u].y / count, z: placed!.sums[u].z / count } : fallback(rig, u, bounds);
    x[u] = p.x; y[u] = p.y; z[u] = p.z; bound[u] = count ? 1 : 0;
  }
  rig.fixtures.forEach((_, i) => {
    const { start, count } = rig.ranges[i];
    if (!rig.cellMaps[i]) { size[start] = rig.hue[i] ? LAMP_SIZE : PAR_SIZE; return; }
    let pitch = placed?.pitch.get(i) ?? Infinity;
    for (let u = start + 1; u < start + count; u++) {
      const d = Math.hypot(x[u] - x[u - 1], y[u] - y[u - 1], z[u] - z[u - 1]);
      if (d > 1e-6 && d < pitch) pitch = d;
    }
    for (let u = start; u < start + count; u++) size[u] = rig.hue[i] ? LAMP_SIZE : Number.isFinite(pitch) ? pitch / 2 : CELL_SIZE;
  });
  const anchors = Object.fromEntries((room?.anchors ?? []).map((a) => [a.id, { ...a.position }]));
  const listeners = Object.fromEntries((room?.listeners ?? []).map((l) => [l.id, { ...l.position, facingDeg: l.facingDeg }]));
  const meta = new TextEncoder().encode(JSON.stringify([bounds, anchors, listeners]));
  const revision = hashBytes([x, y, z, size].map((a) => new Uint8Array(a.buffer)).concat([bound, meta]));
  return { revision, n, x, y, z, size, bound, bounds, anchors, listeners };
}

/** Read-only disagreement report: unbound units, units several bindings share, and bound units far from their plot position. */
export function spaceReport(rig: Rig, room: RoomScene | null, space: UnitSpace): SpaceReport {
  const unbound: number[] = [], far: SpaceReport['far'] = [];
  const uses = new Map<number, number>();
  if (room) {
    for (const { sources } of resolveBindings(rig.fixtures as readonly FixtureWithId[], rig, room.bindings).resolved) {
      for (const source of sources) if (source.unit !== null) uses.set(source.unit, (uses.get(source.unit) ?? 0) + 1);
    }
  }
  for (let u = 0; u < space.n; u++) {
    if (!space.bound[u]) { unbound.push(u); continue; }
    const plot = fallback(rig, u, space.bounds);
    const metres = Math.hypot(space.x[u] - plot.x, space.y[u] - plot.y, space.z[u] - plot.z);
    if (metres > FAR_METRES) far.push({ unit: u, metres });
  }
  const shared = [...uses].filter(([, count]) => count > 1).map(([unit]) => unit).sort((a, b) => a - b);
  return { unbound, shared, far };
}

/** The space in an effect room's order; with `slots`, each entry averages a lamp's cells and grows to cover them. */
export function roomSpaceOf(list: readonly number[], space: UnitSpace, listenerId: string | null = null,
  slots: readonly (readonly number[])[] | null = null): RoomSpace {
  const groups = slots ?? list.map((_, k) => [k]);
  const n = groups.length;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), size = new Float32Array(n);
  groups.forEach((group, k) => {
    let sx = 0, sy = 0, sz = 0;
    for (const g of group) { const u = list[g]; sx += space.x[u]; sy += space.y[u]; sz += space.z[u]; }
    const m = Math.max(1, group.length);
    x[k] = sx / m; y[k] = sy / m; z[k] = sz / m;
    let r = 0;
    for (const g of group) { const u = list[g]; r = Math.max(r, Math.hypot(space.x[u] - x[k], space.y[u] - y[k], space.z[u] - z[k]) + space.size[u]); }
    size[k] = r;
  });
  const named = listenerId !== null ? space.listeners[listenerId] : undefined;
  const listener = named ?? Object.values(space.listeners)[0] ?? { x: 0, y: SEATED, z: 0, facingDeg: 0 };
  return { x, y, z, size, bounds: space.bounds, listener: { ...listener }, anchors: space.anchors };
}
