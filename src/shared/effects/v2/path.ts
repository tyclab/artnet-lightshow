import { pointIn } from './common.ts';
import type { Point, Positions } from './common.ts';
import type { Room } from '../../room.ts';

export interface PathEndpoints {
  fromAnchor: string | null; toAnchor: string | null;
  fromPoint: Point | null; toPoint: Point | null;
}

export function pathEndpoints(p: PathEndpoints, room: Room, pos: Positions): { from: Point | null; to: Point | null } {
  const a = p.fromPoint ?? (p.fromAnchor ? room.space?.anchors[p.fromAnchor] : null);
  const b = p.toPoint ?? (p.toAnchor ? room.space?.anchors[p.toAnchor] : null);
  let from = pointIn(room, pos, a), to = pointIn(room, pos, b);
  // Colocated plot endpoints keep their height gesture: floor is the bottom row, ceiling the top.
  if (pos.plan && a && b && from && to && Math.hypot(to.x - from.x, to.z - from.z) < 1e-6 && Math.abs(b.y - a.y) > 1e-6) {
    const height = Math.max(0.001, room.space?.bounds.height ?? 4);
    from = { x: from.x, y: 0, z: 1 - a.y / height };
    to = { x: to.x, y: 0, z: 1 - b.y / height };
  }
  return { from, to };
}
