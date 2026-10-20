import { z } from 'zod';
import { ACHROMATIC, fromLch, toLch } from './color.ts';

// The room picture's grade, before the masters: raw visualizer frames paint the room pale and too bright.
export interface PictureGrade {
  enabled: boolean;
  /** Fraction of the white component (the smallest channel) taken out. */
  whiteLimit: number;
  /** OKLCh chroma factor; 1 keeps it. */
  saturation: number;
  /** Highest channel level, of full; Hue lamps have their own, as they mix in white LEDs when bright. */
  ceiling: number;
  hueCeiling: number;
}

export const PICTURE_GRADE_DEFAULTS: Readonly<PictureGrade> = Object.freeze({
  enabled: true, whiteLimit: 0.6, saturation: 1.25, ceiling: 0.7, hueCeiling: 0.5,
});

const ceiling = z.number().min(0.1).max(1);
export const pictureGradeSchema = z.object({
  enabled: z.boolean(),
  whiteLimit: z.number().min(0).max(1),
  saturation: z.number().min(0).max(2),
  ceiling,
  hueCeiling: ceiling,
}).strict();

export type Rgb = [number, number, number];

/**
 * One unit's 0..255 colour through the grade. The white limit keeps hue and channel spread and returns
 * the lost level in proportion to what stays coloured: a pastel turns vivid, white only dims. OKLCh then
 * takes the original hue and the saturation, and the ceiling scales the channels together.
 */
export function gradeColour(r: number, g: number, b: number, grade: PictureGrade | null | undefined, hue = false): Rgb {
  if (!grade || !grade.enabled) return [r, g, b];
  const cap = (hue ? grade.hueCeiling : grade.ceiling) * 255;
  const top = Math.max(r, g, b), white = Math.min(r, g, b) * grade.whiteLimit;
  if (top <= 0) return [0, 0, 0];
  let rgb: Rgb = [r, g, b];
  if (white > 0 || grade.saturation !== 1) {
    const kept = top - white;
    if (kept <= 0) return [0, 0, 0];
    const gain = 1 + ((top - Math.min(r, g, b)) / kept) * (white / kept);
    const limited = { r: (r - white) * gain, g: (g - white) * gain, b: (b - white) * gain };
    const before = toLch({ r, g, b }), after = toLch(limited);
    const h = before.C < ACHROMATIC ? after.h : before.h;
    rgb = fromLch(after.L, after.C * grade.saturation, h).map((v) => Math.max(0, Math.min(1, v)) * 255) as Rgb;
  }
  const peak = Math.max(...rgb);
  const scale = peak > cap ? cap / peak : 1;
  if (scale === 1 && rgb[0] === r && rgb[1] === g && rgb[2] === b) return rgb;
  return rgb.map((v) => Math.round(v * scale)) as Rgb;
}
