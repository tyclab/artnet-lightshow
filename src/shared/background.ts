import { z } from 'zod';
import { colourMixer } from './color.ts';
import type { Colour } from '../types/rig.ts';

const channel = z.number().int().min(0).max(255);
export const BACKGROUND_FIXTURES = ['rig', 'wash', 'selected'] as const;
export type BackgroundFixtures = typeof BACKGROUND_FIXTURES[number];
const fixtureId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
// `fixtures` absent is the whole rig; `selected` is kept while another scope is chosen, so the picker remembers it.
export const backgroundSchema = z.object({
  version: z.literal(1), mode: z.enum(['follow', 'fixed', 'off']), level: z.number().min(0).max(1),
  colour: z.object({ r: channel, g: channel, b: channel, w: channel, a: channel, uv: channel }).strict(),
  fixtures: z.enum(BACKGROUND_FIXTURES).optional(),
  selected: z.array(fixtureId).max(1024).refine((ids) => new Set(ids).size === ids.length, 'a fixture is selected twice').optional(),
}).strict();
export type BackgroundSettings = z.infer<typeof backgroundSchema>;
export const DEFAULT_BACKGROUND: BackgroundSettings = {
  version: 1, mode: 'follow', level: 1, colour: { r: 255, g: 160, b: 70, w: 0, a: 0, uv: 0 },
};
/**
 * What an effect publishes under a slot's light. A bed (level or fullLevel above zero) is
 * ambient light it authors (writeFloor, FADE_FLOOR/HIT_FLOOR, V2 floors, LDJ baselines,
 * Disco idles): Follow keeps it, Fixed replaces it, Off removes it. A gap (no authored
 * level) is the share the foreground leaves uncovered, published only by an effect that
 * reveals its gaps (gapsOf): Fixed fills it. An explicit dark cue, a rapid flash's rest
 * (`dark`) or a black foreground at full opacity (coverage 0), takes nothing. Without a
 * field the slot is the effect's own black: owned, never the look beneath (bundle.ts).
 */
export interface BackgroundField { colour: Colour; level: number; fullLevel?: number; coverage: number; dark?: boolean }
export interface BackgroundLight { colour: Colour; level: number }
export const DARK_BACKGROUND: Colour = Object.freeze({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 });
export const ambient = (colour: Colour, level: number, coverage = 1, fullLevel = coverage > 0 ? level / coverage : 0): BackgroundField => ({ colour, level, fullLevel, coverage });
/** A revealed gap: the share of the slot a foreground of this opacity leaves uncovered, none when it covers all of it. */
export function gap(opacity: number): BackgroundField | undefined {
  const coverage = 1 - Math.max(0, Math.min(1, opacity));
  return coverage > 0 ? { colour: DARK_BACKGROUND, level: 0, fullLevel: 0, coverage } : undefined;
}

// The patched fixtures the setting reaches, by patch index (null: all). Wash fixtures are the single-light
// ones (no cells, the rig's 'pars'); the others keep the effect's own background, as Follow at 100 %.
export function backgroundScope(settings: BackgroundSettings | undefined, cellMaps: readonly (readonly unknown[] | null)[],
  idOf: (fixture: number) => number | string | undefined): Uint8Array | null {
  const fixtures = settings?.fixtures ?? 'rig';
  if (fixtures === 'rig') return null;
  const chosen = fixtures === 'selected' ? new Set<unknown>(settings!.selected ?? []) : null;
  return Uint8Array.from(cellMaps, (maps, i) => Number(chosen ? chosen.has(idOf(i)) : !maps));
}

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
