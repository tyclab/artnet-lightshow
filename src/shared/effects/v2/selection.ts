import { hash01 } from '../hash.ts';
import { positionsOf, PLAN_METRES } from './common.ts';
import type { Room } from '../../room.ts';
import type { Seed } from '../types.ts';
import type { V2Space } from './common.ts';

interface Segment { units: number[]; x: number; y: number; z: number }
interface Fixture { segments: Segment[]; x: number; y: number; z: number }
interface Selection { fixtures: Fixture[]; places: number[][] }
const cache = new WeakMap<Room, Map<string, Selection>>();
const picks = new WeakMap<Selection, Map<string, { units: Int32Array; colours: Float32Array }>>();

export function selectionOf(room: Room, space: V2Space, segmentM: number, placeM: number): Selection {
  const key = `${space}|${segmentM}|${placeM}`;
  let memo = cache.get(room);
  if (!memo) { memo = new Map(); cache.set(room, memo); }
  const known = memo.get(key);
  if (known) return known;
  const pos = positionsOf(room, space), scale = pos.plan ? PLAN_METRES : 1;
  const fixtures: Fixture[] = [];
  for (const slots of room.lamps?.slots ?? Array.from({ length: room.n }, (_, i) => [i])) {
    const byTile = new Map<string, number[]>();
    for (const i of slots) {
      const tile = segmentM > 0 ? `${Math.floor(pos.x[i] * scale / segmentM)},${pos.plan ? 0 : Math.floor(pos.y[i] / segmentM)},${Math.floor(pos.z[i] * scale / segmentM)}` : 'whole';
      const group = byTile.get(tile);
      if (group) group.push(i); else byTile.set(tile, [i]);
    }
    const centre = (units: readonly number[]) => {
      let x = 0, y = 0, z = 0;
      for (const i of units) { x += pos.x[i] * scale; y += pos.plan ? 0 : pos.y[i]; z += pos.z[i] * scale; }
      return { x: x / units.length, y: y / units.length, z: z / units.length };
    };
    if (slots.length) fixtures.push({ ...centre(slots), segments: [...byTile.values()].map((units) => ({ units, ...centre(units) })) });
  }
  const places = new Map<string, number[]>();
  fixtures.forEach((f, i) => {
    const tile = `${Math.floor(f.x / placeM)},${Math.floor(f.y / placeM)},${Math.floor(f.z / placeM)}`;
    const group = places.get(tile);
    if (group) group.push(i); else places.set(tile, [i]);
  });
  const value = { fixtures, places: [...places.values()] };
  if (memo.size >= 16) memo.clear();
  memo.set(key, value);
  return value;
}

// Each pass visits every occupied place before repeating. Pixel count never increases a fixture's chance.
export function pickSegments(selection: Selection, seed: Seed, step: number, density: number): { units: Int32Array; colours: Float32Array } {
  const key = `${seed.join(',')}|${step}|${density}`;
  let memo = picks.get(selection);
  if (!memo) { memo = new Map(); picks.set(selection, memo); }
  const known = memo.get(key);
  if (known) return known;
  const { fixtures, places } = selection;
  const count = density > 0 ? Math.min(fixtures.length, Math.max(1, Math.round(density * fixtures.length))) : 0;
  const order = places.map((_, i) => i).sort((a, b) => hash01(seed, a + 71, step) - hash01(seed, b + 71, step));
  const available = places.map((place, i) => [...place].sort((a, b) => hash01(seed, a + 137 + i, step) - hash01(seed, b + 137 + i, step)));
  const units: number[] = [], colours: number[] = [];
  let selected = 0;
  for (let lap = 0; selected < count && lap < fixtures.length; lap++) {
    for (const place of order) {
      const index = available[place].pop();
      if (index === undefined) continue;
      const fixture = fixtures[index];
      const segment = fixture.segments[Math.floor(hash01(seed, index + 251, step) * fixture.segments.length)];
      const colour = hash01(seed, index + 503, step);
      for (const unit of segment.units) { units.push(unit); colours.push(colour); }
      if (++selected >= count) break;
    }
  }
  const value = { units: Int32Array.from(units), colours: Float32Array.from(colours) };
  memo.set(key, value);
  if (memo.size > 64) memo.delete(memo.keys().next().value!);
  return value;
}
