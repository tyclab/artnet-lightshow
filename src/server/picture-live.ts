import { PictureInput } from './picture.ts';
import { state } from './state.ts';
import { profilesRevision } from './profiles.ts';
import { rigSignature } from '../shared/rig.ts';
import { currentRig } from './rig.ts';
import { isArmed, onDisarm } from './armed.ts';
import { settings } from './settings.ts';
import type { PictureRig } from './picture.ts';

/** The rig a picture sender samples: every unit's plan position, in the renderer's unit order. */
export function pictureUnits(): PictureRig & { units: number; list: { fixture: number; cell: number; x: number; y: number; grid: boolean }[] } {
  const rig = currentRig();
  const list = rig.units.map((unit, u) => ({
    fixture: state.fixtures[unit.fixture].id, cell: unit.cell, x: rig.points[u].x, y: rig.points[u].y, grid: !!rig.grids[unit.fixture],
  }));
  return { signature: rigSignature(state.fixtures, profilesRevision()), units: list.length, list };
}

export const pictureInput = new PictureInput({
  armed: isArmed,
  acknowledged: () => settings.get('safety.photosensitivityAcknowledged'),
  rig: () => {
    const rig = currentRig();
    return { signature: rigSignature(state.fixtures, profilesRevision()), units: rig.units.length };
  },
});
onDisarm(() => pictureInput.clear());
