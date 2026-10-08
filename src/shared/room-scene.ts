import { z } from 'zod';

const name = z.string().trim().min(1).max(120)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127), 'Control characters are not allowed');
const id = z.string().min(1).max(120).regex(/^[\w.:-]+$/);
const coordinate = z.number().finite().min(-500).max(500);
const vector = z.object({ x: coordinate, y: coordinate, z: coordinate }).strict();
const dimension = z.number().finite().min(0.001).max(200);
const size = z.object({ x: dimension, y: dimension, z: dimension }).strict();
const angle = z.number().finite().min(-Math.PI * 2).max(Math.PI * 2);
const rotation = z.object({ x: angle, y: angle, z: angle }).strict();
const point = z.tuple([coordinate, coordinate]);
const polygon = z.array(point).min(3).max(128).refine((points) => {
  const area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0);
  return Math.abs(area) > 1e-8;
}, 'A polygon must enclose an area');
const color = z.string().regex(/^#[\da-f]{6}$/i);
const confidence = z.enum(['estimated', 'measured']);

// Metres: origin at the floor centre, x right, y up, z floor depth. Rotations are radians.
export const roomSceneSchema = z.object({
  version: z.literal(1),
  name,
  source: z.object({
    name,
    revision: z.union([z.string().min(1).max(120), z.number().int().nonnegative()]).transform(String),
    confidence,
  }).strict().optional(),
  bounds: z.object({ width: dimension, depth: dimension, height: dimension }).strict(),
  rooms: z.array(z.object({ id, label: name, polygon, color: color.optional() }).strict()).max(128).default([]),
  objects: z.array(z.object({
    id,
    label: name.optional(),
    kind: z.enum(['box', 'cylinder', 'prism']),
    role: z.enum(['wall', 'furniture']),
    position: vector,
    size,
    rotation: rotation.optional(),
    color: color.optional(),
    polygon: polygon.optional(),
  }).strict()).max(1500).default([]),
  bindings: z.array(z.object({
    id,
    fixtureId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
    unit: z.number().int().nonnegative().max(65535).default(0),
    position: vector,
    label: name.optional(),
    confidence,
  }).strict()).max(4096).default([]),
}).strict().superRefine((room, ctx) => {
  const withinFloor = (x: number, z: number) => Math.abs(x) <= room.bounds.width / 2 + 1
    && Math.abs(z) <= room.bounds.depth / 2 + 1;
  for (const collection of ['rooms', 'objects', 'bindings'] as const) {
    const ids = new Set<string>();
    room[collection].forEach((item, index) => {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: [collection, index, 'id'], message: 'Duplicate id' });
      ids.add(item.id);
      if ('position' in item && (!withinFloor(item.position.x, item.position.z)
        || item.position.y < -1 || item.position.y > room.bounds.height + 1)) {
        ctx.addIssue({ code: 'custom', path: [collection, index, 'position'], message: 'Position is outside the room bounds' });
      }
    });
  }
  room.rooms.forEach((area, index) => {
    if (area.polygon.some(([x, z]) => !withinFloor(x, z))) {
      ctx.addIssue({ code: 'custom', path: ['rooms', index, 'polygon'], message: 'Room polygon is outside the floor bounds' });
    }
  });
  room.objects.forEach((object, index) => {
    if (object.kind === 'prism' && !object.polygon) {
      ctx.addIssue({ code: 'custom', path: ['objects', index, 'polygon'], message: 'A prism needs its local x/z polygon' });
    } else if (object.kind !== 'prism' && object.polygon) {
      ctx.addIssue({ code: 'custom', path: ['objects', index, 'polygon'], message: 'Only prisms have a polygon' });
    }
    if (object.polygon?.some(([x, z]) => Math.abs(x) > object.size.x / 2 + 0.001 || Math.abs(z) > object.size.z / 2 + 0.001)) {
      ctx.addIssue({ code: 'custom', path: ['objects', index, 'polygon'], message: 'Prism polygon must fit its local size' });
    }
  });
});

export type RoomScene = z.output<typeof roomSceneSchema>;
