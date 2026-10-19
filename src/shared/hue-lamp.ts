import type { HueLampTraits } from '../types/rig.ts';
function isHueProfile(profile: {
    hue?: unknown;
} | null | undefined): profile is {
    hue: HueLampTraits;
} {
    return !!profile && !!profile.hue && typeof profile.hue === 'object';
}
function hueSections(profile: {
    cells?: readonly unknown[];
}): number {
    return profile.cells ? profile.cells.length : 1;
}
function hueChannelsLabel(channels: readonly number[]): string {
    if (channels.length === 1)
        return `channel #${channels[0]}`;
    const run = channels.every((ch, k) => k === 0 || ch === channels[k - 1] + 1);
    return run ? `channels #${channels[0]}–#${channels[channels.length - 1]}` : `channels ${channels.map((ch) => `#${ch}`).join(', ')}`;
}
function kelvinColour(kelvin: number): {
    r: number;
    g: number;
    b: number;
} {
    const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    const clamp = (v: number) => Math.max(0, Math.min(255, v)) / 255;
    const out = { r: clamp(r), g: clamp(g), b: clamp(b) };
    const peak = Math.max(out.r, out.g, out.b) || 1;
    return { r: out.r / peak, g: out.g / peak, b: out.b / peak };
}
export { isHueProfile, hueSections, hueChannelsLabel, kelvinColour };

// Read legacy channel-shaped outputs while saved shows migrate to ordered sections.
export function hueChannels(output: { channel?: number; channels?: readonly number[] }): readonly number[] {
  return output.channels ?? (output.channel === undefined ? [] : [output.channel]);
}
