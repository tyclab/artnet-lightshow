import { outputEmitters } from './emitter-capability.ts';
import { hueEmitterColour } from './hue-colour.ts';
import type { LightMeasure } from './hardware-guard.ts';
import type { ChannelMap, Profile } from '../types/rig.ts';

const measures = new WeakMap<Profile, WeakMap<ChannelMap, LightMeasure>>();

// Measure the final, quantized Hue RGB; mixing RGB and white can exceed a single die's peak.
export function hueLightMeasure(profile: Profile, map: ChannelMap): LightMeasure {
  let maps = measures.get(profile);
  if (!maps) { maps = new WeakMap(); measures.set(profile, maps); }
  let measure = maps.get(map);
  if (!measure) {
    const traits = profile.hue && !profile.hue.legacy ? profile.hue : null;
    measure = (colour, dim, scale) => {
      const rgb = hueEmitterColour(outputEmitters(colour, dim / 255 * scale, map), Math.round(dim * scale), map, traits);
      return Math.max(rgb.r, rgb.g, rgb.b) / 255;
    };
    maps.set(map, measure);
  }
  return measure;
}
