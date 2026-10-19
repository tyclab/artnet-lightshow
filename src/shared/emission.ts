import type { Emission, Profile, StageFixture } from '../types/rig.ts';

// Explicit physical properties take precedence over legacy display defaults.
export function emissionOf(fixture: StageFixture, profile?: Profile | null, cells = !!profile?.cells): Emission {
  if (fixture.emission) return fixture.emission;
  const bulb = fixture.group === 'room' || fixture.output?.protocol === 'hue' || !!profile?.hue
    || /^generic-hue-/.test(profile?.id ?? '');
  return { kind: cells ? 'strip' : bulb ? 'bulb' : 'beam' };
}

// Degrees: pan 0 faces +z; tilt 0 is horizontal and +90 points upward.
export function beamDirection(emission: Emission, floor = false): { x: number; y: number; z: number } {
  const pan = (emission.pan ?? (floor ? 180 : 0)) * Math.PI / 180;
  const tilt = (emission.tilt ?? (floor ? 78 : -68)) * Math.PI / 180;
  return { x: Math.sin(pan) * Math.cos(tilt), y: Math.sin(tilt), z: Math.cos(pan) * Math.cos(tilt) };
}
