import { PixelInputs } from './pixel-input.ts';
import { state } from './state.ts';
import { getProfile } from './profiles.ts';
import { isArmed, onDisarm } from './armed.ts';
import { settings } from './settings.ts';

export const pixelInputs = new PixelInputs({
  armed: isArmed,
  acknowledged: () => settings.get('safety.photosensitivityAcknowledged'),
  target: (id) => {
    const fixture = state.fixtures.find((f) => f.id === id);
    return fixture?.output?.protocol === 'ddp' ? { profile: getProfile(fixture), outputKey: JSON.stringify(fixture.output) } : null;
  },
});
onDisarm(() => pixelInputs.clear());
