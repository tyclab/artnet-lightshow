import { buildRig, rigSignature } from '../../src/shared/rig.ts';
import { placeRig, roomRig } from './world.js';

// The rig and its placement last built, kept with the pooled scene (scene-pool.js): a return to
// the view with the patch and the room unchanged hands the scene what it already shows (scene.js setRig).
const kept = { rig: { deps: null }, placed: { deps: null } };
function keep(slot, deps, make) {
  const held = kept[slot];
  if (!held.deps || deps.some((value, i) => !Object.is(value, held.deps[i]))) {
    held.value = make();
    held.deps = deps;
  }
  return held.value;
}

/** `{ rig, placed }` for this patch and room: the same objects while nothing they are built from changed. */
export function keptRig(fixtures, profiles, room) {
  // A profile refresh can change cells under one ID; room bindings resolve through the ids (space.ts).
  const ids = fixtures.map((f) => f.id).join(',');
  const rig = keep('rig', [rigSignature(fixtures), ids, profiles], () => buildRig(fixtures, (f) => profiles[f.profileId] || null));
  const placed = keep('placed', [rig, room, fixtures, profiles], () => (room ? roomRig(fixtures, rig, room, profiles) : placeRig(fixtures, profiles, rig)));
  return { rig, placed };
}
