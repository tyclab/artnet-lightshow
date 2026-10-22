import { currentRig } from './rig.ts';
import { sharedRoomScene } from './room-scene-store.ts';
import { report } from './guard.ts';
import { buildUnitSpace } from '../shared/space.ts';
import type { Rig } from '../shared/rig.ts';
import type { UnitSpace } from '../shared/space.ts';

let cached: { rig: Rig; revision: string; space: UnitSpace | null } | null = null;

/** The patch's unit space, rebuilt only when the rig or the room revision changes; null (plan-only) if it cannot be built. */
export function currentSpace(): UnitSpace | null {
  const rig = currentRig();
  const { room, revision } = sharedRoomScene().peek();
  if (cached && cached.rig === rig && cached.revision === revision) return cached.space;
  let space: UnitSpace | null = null;
  try {
    space = buildUnitSpace(rig, room);
  } catch (err) {
    report('unit space', err);
  }
  cached = { rig, revision, space };
  return space;
}
