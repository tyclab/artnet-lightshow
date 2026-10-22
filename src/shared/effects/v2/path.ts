import { pointIn } from './common.ts';
import { DEFAULT_BOUNDS } from '../../space.ts';
import type { Point, Positions } from './common.ts';
import type { Room } from '../../room.ts';

export interface PathEndpoints {
  fromAnchor: string | null; toAnchor: string | null;
  fromPoint: Point | null; toPoint: Point | null;
}

function endpoint(point: Point | null, anchor: Point | null | undefined, room: Room, pos: Positions): Point | null {
  if (!point) return pointIn(room, pos, anchor);
  if (!pos.plan) return point;
  const bounds = room.space?.bounds ?? DEFAULT_BOUNDS;
  // Inverse of the plot-to-room fallback: X across, Z down the plot; explicit points never snap to lamps.
  return { x: 0.5 + point.x / bounds.width, y: 0, z: 0.5 + point.z / bounds.depth };
}

export function pathEndpoints(p: PathEndpoints, room: Room, pos: Positions): { from: Point | null; to: Point | null } {
  const a = p.fromPoint ?? (p.fromAnchor ? room.space?.anchors[p.fromAnchor] : null);
  const b = p.toPoint ?? (p.toAnchor ? room.space?.anchors[p.toAnchor] : null);
  let from = endpoint(p.fromPoint, a, room, pos), to = endpoint(p.toPoint, b, room, pos);
  // Colocated plot endpoints keep their height gesture: floor is the bottom row, ceiling the top.
  if (pos.plan && a && b && from && to && Math.hypot(to.x - from.x, to.z - from.z) < 1e-6 && Math.abs(b.y - a.y) > 1e-6) {
    const height = Math.max(0.001, room.space?.bounds.height ?? DEFAULT_BOUNDS.height);
    from = { x: from.x, y: 0, z: 1 - a.y / height };
    to = { x: to.x, y: 0, z: 1 - b.y / height };
  }
  return { from, to };
}
