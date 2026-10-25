import { emissionOf, beamDirection } from '../../src/shared/emission.ts';
import { stagePositions } from '../../src/shared/stage.ts';
import { lineOf } from '../../src/shared/rig.ts';
import { bindingSources, resolveBindings } from '../../src/shared/space.ts';


export const STAGE_W = 12;
export const STAGE_D = 8;
export const TRUSS_H = 4.6;
export const FLOOR_H = 0.18;
export const ROOM_H = 2.2;
export const BEAM_HALF_ANGLE = (11 * Math.PI) / 180;
const MAX_BEAM = 14;
const ROW_GAP = 0.5;

export function planToWorld(p) {
  return { x: (p.x / 100 - 0.5) * STAGE_W, z: (p.y / 100 - 0.5) * STAGE_D };
}

/** Haze shows only in a beam: a room of bulbs and strips has nothing for the slider to thicken. */
export const hasBeams = (placed) => placed.lamps.some((lamp) => lamp.kind === 'par');

const EPS = 1e-6;
// The generic venue has no walls; its roof sits this far above the truss.
const ROOF = TRUSS_H + 2.5;
// A pool lies just off its surface so it does not fight the floor or a wall for depth.
const POOL_LIFT = 0.006;
// The cone's footprint stretches by 1/cos of the angle it strikes at; this cos caps a grazing hit.
const GRAZE = 0.35;

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scaled = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const unit = (v) => scaled(v, 1 / Math.hypot(v.x, v.y, v.z));
const turn = (v, axis, angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 'x') return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
  if (axis === 'y') return { x: c * v.x + s * v.z, y: v.y, z: c * v.z - s * v.x };
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
};

/** A room's box walls with their axes in world space (three.js Euler XYZ); other shapes leave the room box to stop beams. */
export function boxWalls(objects = []) {
  return objects.filter((object) => object.role === 'wall' && object.kind === 'box').map(({ position, size, rotation }) => {
    const r = rotation || { x: 0, y: 0, z: 0 };
    const axes = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }].map((v) => turn(turn(turn(v, 'z', r.z), 'y', r.y), 'x', r.x));
    return { centre: position, half: [size.x / 2, size.y / 2, size.z / 2], axes };
  });
}

function wallHit(from, aim, wall) {
  const offset = { x: from.x - wall.centre.x, y: from.y - wall.centre.y, z: from.z - wall.centre.z };
  let enter = -Infinity, exit = Infinity, normal = null;
  for (let i = 0; i < 3; i++) {
    const axis = wall.axes[i], at = dot(offset, axis), along = dot(aim, axis), half = wall.half[i];
    if (Math.abs(along) < EPS) { if (Math.abs(at) > half) return null; continue; }
    const a = (-half - at) / along, b = (half - at) / along;
    if (Math.min(a, b) > enter) { enter = Math.min(a, b); normal = scaled(axis, -Math.sign(along)); }
    exit = Math.min(exit, Math.max(a, b));
  }
  // A lamp set into the wall (enter behind it) shines out of it rather than stopping at its far face.
  return enter <= exit && enter > EPS ? { length: enter, normal } : null;
}

/** The first surface a beam meets within its range: the room box (generic venue: floor and roof) or a box wall. */
export function surfaceHit(from, aim, bounds = null, walls = []) {
  let best = null;
  const meet = (length, normal) => { if (length <= MAX_BEAM && (!best || length < best.length)) best = { length, normal }; };
  if (aim.y < -EPS) meet(Math.max(0, from.y / -aim.y), { x: 0, y: 1, z: 0 });
  if (aim.y > EPS) meet(Math.max(0, ((bounds?.height ?? ROOF) - from.y) / aim.y), { x: 0, y: -1, z: 0 });
  if (bounds) for (const [axis, size] of [['x', bounds.width], ['z', bounds.depth]]) {
    const side = Math.sign(aim[axis]);
    if (Math.abs(aim[axis]) > EPS) meet(Math.max(0, (side * size / 2 - from[axis]) / aim[axis]), { x: 0, y: 0, z: 0, [axis]: -side });
  }
  for (const wall of walls) { const hit = wallHit(from, aim, wall); if (hit) meet(hit.length, hit.normal); }
  return best;
}

/** Where a cone of `radius` lands on a surface: an ellipse, `along` the beam's slant on it and `across` that. */
export function poolOn(end, normal, aim, radius) {
  const into = dot(aim, normal), cos = Math.abs(into);
  const slant = { x: aim.x - normal.x * into, y: aim.y - normal.y * into, z: aim.z - normal.z * into };
  // Square on, any line in the surface will do: the pool is round.
  const along = Math.hypot(slant.x, slant.y, slant.z) > EPS ? unit(slant)
    : unit(cross(normal, Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }));
  const minor = radius * 1.35;
  return { at: { x: end.x + normal.x * POOL_LIFT, y: end.y + normal.y * POOL_LIFT, z: end.z + normal.z * POOL_LIFT },
    normal, along, across: cross(along, normal), major: minor / Math.max(GRAZE, cos), minor };
}

function beamLight(light, emission, floor = false, bounds = null, walls = []) {
  const from = light.position, aim = beamDirection(emission, floor);
  const hit = surfaceHit(from, aim, bounds, walls);
  const length = hit ? hit.length : MAX_BEAM;
  const end = { x: from.x + aim.x * length, y: from.y + aim.y * length, z: from.z + aim.z * length };
  const radius = Math.tan((emission.beamAngle ?? 22) * Math.PI / 360) * length;
  return { ...light, kind: 'par', aim, length, end, radius, pool: hit && radius > 0 ? poolOn(end, hit.normal, aim, radius) : null };
}

export function placeRig(fixtures, profiles, rig) {
  const centres = stagePositions(fixtures);
  const unplaced = fixtures.filter((f) => !f.position).length;
  const lamps = [];
  const cells = [];
  // What hangs from the truss, so the truss can be drawn where it is.
  const hung = [];

  fixtures.forEach((fixture, i) => {
    const profile = profiles[fixture.profileId] || null;
    const { start, count } = rig.ranges[i];
    const emission = emissionOf(fixture, profile, !!rig.cellMaps[i]);
    const floor = fixture.group === 'floor';
    const height = Number.isFinite(fixture.position?.height)
      ? Math.max(0, Math.min(100, fixture.position.height)) * TRUSS_H / 100
      : floor ? FLOOR_H : fixture.group === 'room' ? ROOM_H : TRUSS_H;

    if (fixture.geometry?.points?.length === count) {
      for (let u = start; u < start + count; u++) {
        const point = rig.points[u], at = planToWorld(point);
        cells.push({ unit: u, fixture: fixture.id, size: 0.04,
          position: { x: at.x, y: Number.isFinite(point.height) ? point.height * TRUSS_H / 100 : height, z: at.z } });
      }
      return;
    }

    if (!rig.cellMaps[i]) {
      const at = planToWorld(centres[i]);
      const from = { x: at.x, y: height, z: at.z };
      if (emission.kind === 'bulb') {
        lamps.push({ unit: start, fixture: fixture.id, kind: 'bulb', position: from, aim: null, length: 0 });
        return;
      }
      if (height === TRUSS_H) hung.push(at);
      if (emission.kind === 'strip') {
        const line = lineOf(fixture, Math.max(2, count), fixture.position ? 0 : unplaced), rad = line.angle * Math.PI / 180;
        for (let k = 0; k < 16; k++) {
          const offset = ((k + 0.5) / 16 - 0.5) * line.length / 100;
          cells.push({ unit: start, fixture: fixture.id, size: 0.08,
            position: { x: from.x + offset * Math.cos(rad) * STAGE_W, y: height, z: from.z + offset * Math.sin(rad) * STAGE_D } });
        }
      } else lamps.push(beamLight({ unit: start, fixture: fixture.id, position: from }, emission, floor));
      return;
    }

    const grid = rig.grids[i];
    if (grid && profile && Array.isArray(profile.cells)) {
      // Project panel rows downward so the 3D preview matches their physical mounting.
      const line = lineOf(fixture, grid.columns, fixture.position ? 0 : unplaced);
      const rad = (line.angle * Math.PI) / 180;
      const across = { x: Math.cos(rad) * STAGE_W / 100, z: Math.sin(rad) * STAGE_D / 100 };
      const width = line.length * Math.hypot(across.x, across.z);
      const cellSize = width / grid.columns;
      const centre = planToWorld(centres[i]);
      const top = floor ? FLOOR_H + grid.rows * cellSize : height;
      if (!floor) hung.push(centre);
      for (let c = 0; c < count; c++) {
        const cell = profile.cells[c] || {};
        const atGrid = cell.at || { x: c % grid.columns, y: Math.floor(c / grid.columns) };
        const u = (atGrid.x + 0.5) / grid.columns - 0.5;
        cells.push({
          unit: start + c, fixture: fixture.id, size: cellSize,
          position: { x: centre.x + u * line.length * across.x, y: top - (atGrid.y + 0.5) * cellSize, z: centre.z + u * line.length * across.z },
        });
      }
      return;
    }

    const lineCells = count;
    const line = lineOf(fixture, lineCells, fixture.position ? 0 : unplaced);
    const rad = (line.angle * Math.PI) / 180;
    const spacing = (line.length / lineCells) * Math.hypot(Math.cos(rad) * STAGE_W / 100, Math.sin(rad) * STAGE_D / 100);
    for (let u = start; u < start + count; u++) {
      const at = planToWorld(rig.points[u]);
      if (height === TRUSS_H) hung.push(at);
      cells.push({ unit: u, fixture: fixture.id, size: Math.max(0.03, Math.min(0.12, spacing * 0.7)), position: { x: at.x, y: height, z: at.z } });
    }
  });

  const physical = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const stripCells = [];
  for (const cell of cells) {
    const fixture = physical.get(cell.fixture);
    if (!fixture?.emission || fixture.emission.kind === 'strip') { stripCells.push(cell); continue; }
    lamps.push(fixture.emission.kind === 'beam' ? beamLight(cell, fixture.emission, fixture.group === 'floor')
      : { ...cell, kind: 'bulb', aim: null, length: 0 });
  }
  return { lamps, cells: stripCells, trusses: trussesFor(hung) };
}

export { bindingSources };

export function roomRig(fixtures, rig, model) {
  const lamps = [];
  const cells = [];
  const unresolved = [];
  const incomplete = [];
  const objectLights = [];
  const lightObjects = new Map();
  for (const object of model.objects || []) {
    if (!object.lightBindingId) continue;
    if (!lightObjects.has(object.lightBindingId)) lightObjects.set(object.lightBindingId, []);
    lightObjects.get(object.lightBindingId).push(object.id);
  }
  const indices = new Map(fixtures.map((fixture, index) => [fixture.id, index]));
  const walls = boxWalls(model.objects);
  const { resolved, mapped, outputs } = resolveBindings(fixtures, rig, model.bindings);
  let estimated = 0;
  for (const { binding, sources, missingSources } of resolved) {
    if (missingSources === sources.length) { unresolved.push(binding); continue; }
    if (missingSources) incomplete.push({ binding, missingSources });
    if (binding.confidence !== 'measured') estimated++;
    const light = { unit: sources[0].unit, fixture: binding.fixtureId, position: binding.position,
      ...(binding.sources ? { sources } : {}) };
    if (lightObjects.has(binding.id)) {
      for (const objectId of lightObjects.get(binding.id)) objectLights.push({ objectId, sources });
      continue;
    }
    const fixture = fixtures[indices.get(binding.fixtureId ?? binding.sources?.[0]?.fixtureId)];
    if (binding.path) {
      for (let index = 1; index < binding.path.length; index++) {
        const from = binding.path[index - 1], to = binding.path[index];
        const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
        if (length > 1e-6) cells.push({ ...light, size: 0.025, length, from, to,
          position: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 } });
      }
    } else if (fixture?.emission?.kind === 'beam') lamps.push(beamLight(light, fixture.emission, fixture.group === 'floor', model.bounds, walls));
    else if (fixture?.emission?.kind === 'strip' || !fixture?.emission && !binding.sources && rig.cellMaps[indices.get(binding.fixtureId)]) cells.push({ ...light, size: 0.08 });
    else lamps.push({ ...light, kind: 'bulb', aim: null, length: 0 });
  }
  const missing = fixtures.filter((fixture) => !mapped.has(fixture.id));
  const partial = fixtures.filter((fixture, index) => mapped.has(fixture.id) && mapped.get(fixture.id).size < rig.ranges[index].count);
  const shared = [...outputs.values()].filter((output) => output.bindings.length > 1);
  return { lamps, cells, objectLights, trusses: [], missing, partial, unresolved, incomplete, shared, estimated };
}

export function meanLightRGB(sources, frame, out, scratch = new Float32Array(3)) {
  const total = sources.reduce((sum, source) => sum + source.weight, 0);
  out[0] = out[1] = out[2] = 0;
  for (const source of sources) {
    lightRGB(source.unit === null ? null : frame[source.unit], scratch);
    const weight = source.weight / total;
    for (let channel = 0; channel < 3; channel++) out[channel] += scratch[channel] * weight;
  }
}

export const STAGE_FOV = 48;
export function roomViews({ width, depth, height }, aspect = 1) {
  const target = [0, height / 2, 0];
  const vertical = Math.tan(STAGE_FOV * Math.PI / 360);
  const horizontal = vertical * Math.max(0.1, aspect);
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const unit = (vector) => vector.map((value) => value / Math.hypot(...vector));
  const fitted = (direction) => {
    const forward = unit(direction);
    const right = unit([forward[2], 0, -forward[0]]);
    const up = [forward[1] * right[2], forward[2] * right[0] - forward[0] * right[2], -forward[1] * right[0]];
    let distance = 2;
    for (const x of [-width / 2, width / 2]) for (const y of [-height / 2, height / 2]) for (const z of [-depth / 2, depth / 2]) {
      const corner = [x, y, z];
      distance = Math.max(distance, Math.abs(dot(corner, right)) / horizontal + dot(corner, forward),
        Math.abs(dot(corner, up)) / vertical + dot(corner, forward));
    }
    return { target, position: target.map((value, index) => value + forward[index] * distance * 1.08) };
  };
  return { audience: fitted([0.55, 0.65, 1]), above: fitted([0, 1, 0.001]), side: fitted([1, 0.45, 0]) };
}

export function trussesFor(points) {
  const rows = [];
  for (const p of [...points].sort((a, b) => a.z - b.z)) {
    const row = rows[rows.length - 1];
    if (row && p.z - row.last <= ROW_GAP) {
      row.zs.push(p.z); row.last = p.z;
      row.from = Math.min(row.from, p.x); row.to = Math.max(row.to, p.x);
    } else {
      rows.push({ zs: [p.z], last: p.z, from: p.x, to: p.x });
    }
  }
  return rows.map((row) => ({
    z: row.zs.reduce((sum, z) => sum + z, 0) / row.zs.length,
    from: row.from - 0.5,
    to: row.to + 0.5,
    y: TRUSS_H + 0.2,
  }));
}

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// Scale the whole RGB mix to preserve hue, then linearize for GPU lighting.
export function lightRGB(light, out, at = 0) {
  if (!light) { out[at] = 0; out[at + 1] = 0; out[at + 2] = 0; return 0; }
  const w = light.w || 0;
  const a = light.a || 0;
  const uv = light.uv || 0;
  let r = (light.r || 0) + w + a + uv * 0.2;
  let g = (light.g || 0) + w + a * 0.5;
  let b = (light.b || 0) + w + uv * 0.9;
  const peak = Math.max(r, g, b);
  if (peak > 255) { const k = 255 / peak; r *= k; g *= k; b *= k; }
  out[at] = toLinear(r / 255);
  out[at + 1] = toLinear(g / 255);
  out[at + 2] = toLinear(b / 255);
  return Math.min(1, peak / 255);
}
