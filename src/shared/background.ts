import { z } from 'zod';
import { colourMixer } from './color.ts';
import type { Colour } from '../types/rig.ts';

const channel = z.number().int().min(0).max(255);
export const backgroundSchema = z.object({
  version: z.literal(1), mode: z.enum(['follow', 'fixed', 'off']), level: z.number().min(0).max(1),
  colour: z.object({ r: channel, g: channel, b: channel, w: channel, a: channel, uv: channel }).strict(),
}).strict();
export type BackgroundSettings = z.infer<typeof backgroundSchema>;
export const DEFAULT_BACKGROUND: BackgroundSettings = {
  version: 1, mode: 'follow', level: 1, colour: { r: 255, g: 160, b: 70, w: 0, a: 0, uv: 0 },
};
export interface BackgroundField { colour: Colour; level: number; fullLevel?: number; coverage: number; dark?: boolean }
export interface BackgroundLight { colour: Colour; level: number }
export const DARK_BACKGROUND: Colour = Object.freeze({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 });
export const ambient = (colour: Colour, level: number, coverage = 1, fullLevel = coverage > 0 ? level / coverage : 0): BackgroundField => ({ colour, level, fullLevel, coverage });

export function backgroundLight(field: BackgroundField | undefined, settings = DEFAULT_BACKGROUND, stopped = false): BackgroundLight {
  if (settings.mode === 'off' || (field?.dark && !stopped)) return { colour: DARK_BACKGROUND, level: 0 };
  if (settings.mode === 'fixed') return { colour: settings.colour, level: settings.level * (stopped ? 1 : field?.coverage ?? 0) };
  return { colour: field?.colour ?? DARK_BACKGROUND, level: (stopped ? field?.fullLevel ?? field?.level ?? 0 : field?.level ?? 0) * settings.level };
}

export function composeBackground(colour: Colour, level: number, field?: BackgroundField,
  settings = DEFAULT_BACKGROUND, stopped = false): BackgroundLight {
  if (stopped) return backgroundLight(field, settings, true);
  if (!field || (settings.mode === 'follow' && settings.level === 1)) return { colour, level };
  const below = backgroundLight(field, settings);
  const combined = Math.max(0, level - field.level) + below.level;
  if (!(combined > 0)) return { colour: DARK_BACKGROUND, level: 0 };
  const mix = (channel: keyof Colour) => Math.max(0, Math.min(255,
    ((colour[channel] ?? 0) * level - (field.colour[channel] ?? 0) * field.level + (below.colour[channel] ?? 0) * below.level) / combined));
  return { colour: { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') }, level: combined };
}

export function blendBackground(from: BackgroundField | undefined, to: BackgroundField | undefined, t: number): BackgroundField | undefined {
  if (!from && !to) return undefined;
  const colour = colourMixer(from?.colour ?? DARK_BACKGROUND, to?.colour ?? DARK_BACKGROUND)(t);
  const level = Math.round(255 * ((from?.level ?? 0) * (1 - t) + (to?.level ?? 0) * t)) / 255;
  return { colour, level, fullLevel: (from?.fullLevel ?? from?.level ?? 0) * (1 - t) + (to?.fullLevel ?? to?.level ?? 0) * t, coverage: (from?.coverage ?? 0) * (1 - t) + (to?.coverage ?? 0) * t,
    dark: !!from?.dark && !!to?.dark };
}
