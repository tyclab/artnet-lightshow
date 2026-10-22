import { parseHex, toHex } from './palette-model.ts';

export interface Hsv { hue: number; saturation: number; brightness: number }
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0));

export function colourHsv(hex: string): Hsv {
  const c = parseHex(hex), r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const h = !delta ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: ((h * 60) % 360 + 360) % 360, saturation: max ? delta / max * 100 : 0, brightness: max * 100 };
}

export function hsvColour(value: Hsv, previous = '#000000'): string {
  const h = ((value.hue % 360) + 360) % 360 / 60;
  const s = clamp(value.saturation, 100) / 100, v = clamp(value.brightness, 100) / 100;
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const [r, g, b] = rgb.map((n) => Math.round((n + m) * 255));
  return toHex({ ...parseHex(previous), r, g, b });
}

export function huePair(hue = 210, separation = 180, saturation = 90, brightness = 100): string[] {
  return [hue, hue + separation].map((h) => hsvColour({ hue: h, saturation, brightness }));
}

export const CURATED_PALETTE_IDS = Object.freeze(['solarPunch', 'orangeBlue', 'redCyan', 'yellowPurple', 'greenPink', 'blueDream', 'electricSummer', 'rainbow', 'whiteOff']);
