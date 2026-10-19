import { hueChannels, isHueProfile } from '../shared/hue-lamp.ts';
import { hueProfile } from './hue-profile.ts';
import type { AreaLamp } from './hue.ts';
import type { Fixture, Profile } from '../types/rig.ts';

export function refreshHueFixtures(fixtures: readonly Fixture[], profiles: Record<string, Profile>, bridge: string, lamps: readonly AreaLamp[]) {
  const updates: { id: number; profile: Profile }[] = [];
  const skipped: { id: number; label: string; reason: string }[] = [];
  for (const fixture of fixtures) {
    if (fixture.output?.protocol !== 'hue' || fixture.output.bridge !== bridge) continue;
    const channels = hueChannels(fixture.output);
    const matches = lamps.filter((lamp) => channels.every((channel) => lamp.channels.includes(channel)));
    const lamp = matches.length === 1 ? matches[0] : null;
    if (!lamp || !lamp.capabilities) {
      skipped.push({ id: fixture.id, label: fixture.label, reason: lamp ? 'Bridge capabilities unavailable' : 'Saved sections no longer identify one lamp' });
      continue;
    }
    const old = profiles[fixture.profileId];
    const partial = isHueProfile(old) && (old.hue.legacy || old.hue.partial);
    if (!partial && lamp.channels.length !== channels.length) {
      skipped.push({ id: fixture.id, label: fixture.label, reason: 'The lamp section count changed; existing fixture preserved' });
      continue;
    }
    // Keep saved channel order and IDs: sequence, MIDI and room bindings refer to them.
    const profile = hueProfile({ ...lamp, channels: [...channels] }, bridge);
    if (!profile) continue;
    const suffix = `-fixture-${fixture.id}`;
    profile.id = `${profile.id.slice(0, 128 - suffix.length)}${suffix}`;
    if (old?.hardware) profile.hardware = { ...old.hardware };
    if (channels.length < lamp.channels.length) profile.hue = { ...profile.hue!, partial: true };
    updates.push({ id: fixture.id, profile });
  }
  return { updates, skipped };
}
