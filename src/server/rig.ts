// Key the cache on its inputs so every patching path automatically invalidates stale geometry.

import { state } from './state.ts';
import { getProfile, profilesRevision } from './profiles.ts';
import { buildRig, createRigSignature } from '../shared/rig.ts';
import type { Rig } from '../shared/rig.ts';
import type { Fixture } from '../types/rig.ts';

let cached: Rig<Fixture> | null = null;
let cachedKey = '';
let rigSignature = createRigSignature();

function currentRig(): Rig<Fixture> {
  const key = rigSignature(state.fixtures, profilesRevision());
  if (!cached || key !== cachedKey || cached.fixtures !== state.fixtures) {
    cached = buildRig(state.fixtures, getProfile);
    cachedKey = key;
  }
  return cached;
}

function invalidateRig(): void {
  cached = null;
  cachedKey = '';
  rigSignature = createRigSignature();
}

export {
  currentRig,
  invalidateRig,
};
