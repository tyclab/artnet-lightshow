import { outputEmitters } from './emitter-capability.ts';
import { lightLuminance } from './flash-limit.ts';
import { cellDrive } from './look-math.ts';
import type { OutputGuard } from './output-guard.ts';
import type { ChannelMap, Colour, Profile } from '../types/rig.ts';

export interface RoomLight { col: Colour; dim: number }

// Fixtures have equal weight; more addressable cells do not make a surface count as more lamps.
export function fixtureLuminance(lights: readonly RoomLight[], profile: Pick<Profile, 'channelMap'>,
  cells: readonly ChannelMap[] | null | undefined, scale: number, gain = 1): number {
  const dimmer = (ch: ChannelMap, level: number) => ch.dimmer === undefined ? 255
    : ch.dimmerFine === undefined ? Math.round(level) : Math.round(level / 255 * 65535) >> 8;
  const levels = lights.map((light) => Math.min(255, light.dim * gain));
  const top = Math.max(...levels), fixtureDimmer = profile.channelMap.dimmer !== undefined;
  let sum = 0;
  for (let c = 0; c < lights.length; c++) {
    const map = cells?.[c] ?? profile.channelMap, dim = levels[c];
    const drive = cells ? cellDrive(dim, top, scale, fixtureDimmer, map.dimmer !== undefined) : null;
    const master = dimmer(profile.channelMap, (cells ? top : dim) * scale);
    const cell = drive ? dimmer(map, drive.cellDim) : 255;
    sum += lightLuminance(outputEmitters(lights[c].col, drive?.scale ?? scale * dim / 255, map), master * cell / 255);
  }
  return sum / Math.max(1, lights.length);
}

export function limitRoomFlashes(guard: OutputGuard, measure: (gain?: number) => number,
  apply: (gain: number) => void, now: number): void {
  const luminance = measure(), allowed = guard.targetRoom(luminance, now);
  if (luminance > 1e-6 && Math.abs(allowed - luminance) > 1e-4) {
    let lo = 0, hi = 1;
    if (allowed > luminance) {
      let previous = luminance;
      for (let k = 0; k < 16; k++) {
        hi *= 2;
        const brighter = measure(hi);
        if (brighter >= allowed || brighter - previous < 1e-6) break;
        previous = brighter;
      }
    }
    let gain = 1, error = Math.abs(allowed - luminance);
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2, actual = measure(mid);
      if (Math.abs(actual - allowed) < error) { gain = mid; error = Math.abs(actual - allowed); }
      if (error < .001) break;
      if (actual < allowed) lo = mid; else hi = mid;
    }
    apply(gain);
  }
  guard.commitRoom(measure(), now);
}
