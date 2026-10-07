// Temporarily acknowledge flashes in memory only; the returned callback restores settings.
import { settings } from '../../src/server/settings.ts';

/** Acknowledge until the returned function is called. */
export function acknowledgeFlashes() {
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings.save = () => {};
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: true } };
  return () => {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
  };
}
