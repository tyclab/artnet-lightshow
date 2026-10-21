import { z } from 'zod';
import { ACHROMATIC, SRGB_DECODE, fromLch, toLch } from './color.ts';

// Below what peak, of full, a picture unit stays dark: a screen's near-black pixels still light a lamp in colour.
export const PICTURE_BLACK_POINT_DEFAULT = 0.12;
export const pictureBlackPointSchema = z.number().min(0).max(0.5);

/**
 * The gain one unit takes from its peak channel (0..255, decoded or not): 0 at and below the black point, 1 at
 * full, the ramp between. All three channels take it, so the hue holds. Exact at both ends: 255 stays 255.
 */
export function blackPointGain(peak: number, blackPoint: number): number {
  const m = peak / 255;
  if (m <= blackPoint) return 0;
  return (m - blackPoint) / (1 - blackPoint) / m;
}

const BYTES: Readonly<Float64Array> = Float64Array.from({ length: 256 }, (_, i) => i);

/** What a picture byte drives for one pair of settings: built when they change, read per unit, nothing per frame. */
export interface PictureLift {
  decode: boolean;
  blackPoint: number;
  /** Byte to level: the byte itself, or its linear light with the decode on. */
  levels: Readonly<Float64Array>;
  /** Peak byte to the unit's gain: `blackPointGain` of its level (the decode is monotonic, so the peak byte is the peak). */
  gains: Readonly<Float64Array>;
}

export function pictureLift(decode: boolean, blackPoint: number): PictureLift {
  const levels = decode ? SRGB_DECODE : BYTES;
  const gains = new Float64Array(256);
  for (let v = 0; v < 256; v++) gains[v] = blackPointGain(levels[v], blackPoint);
  return { decode, blackPoint, levels, gains };
}

// An optional taste grade on the room picture, after the lift and before the masters; off by default.
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
  enabled: false, whiteLimit: 0, saturation: 1, ceiling: 1, hueCeiling: 1,
});

/** The first defaults, guesses that made up for the missing decode; a stored copy of them was never tuned. */
export const PICTURE_GRADE_GUESSED: Readonly<PictureGrade> = Object.freeze({
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
