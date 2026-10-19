import { kelvinColour } from './hue-lamp.ts';
import { EMITTERS } from './rig.ts';
import type { ChannelMap, EmitterLevels, HueLampTraits } from '../types/rig.ts';

type ChannelReader = (offset: number | undefined) => number;
type RGB = { r: number; g: number; b: number };

const DEFAULT_WARM = { r: 1, g: 0.66, b: 0.34 };
const DEFAULT_COOL = { r: 1, g: 0.98, b: 0.99 };
const NEUTRAL = { r: 1, g: 1, b: 1 };
const UV_RED = 0.45;
const UV_BLUE = 0.85;
const LEGACY_TONES = { warm: DEFAULT_WARM, cool: DEFAULT_COOL, fixed: NEUTRAL };
const tones = new WeakMap<HueLampTraits, { warm: RGB; cool: RGB; fixed: RGB }>();

function tonesOf(traits: HueLampTraits | null) {
  if (!traits || traits.legacy || !traits.whites) return LEGACY_TONES;
  let cached = tones.get(traits);
  if (!cached) {
    const warm = kelvinColour(traits.whites.warm);
    const cool = traits.whites.cool === traits.whites.warm ? warm : kelvinColour(traits.whites.cool);
    cached = { warm, cool, fixed: warm };
    tones.set(traits, cached);
  }
  return cached;
}

function normalizeMix(r: number, g: number, b: number): RGB {
  const peak = Math.max(r, g, b);
  const scale = peak > 255 ? 255 / peak : 1;
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value * scale)));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

// Hue emitters already include dimmer, master and hardware limits in the rendered frame.
export function hueSectionColour(ch: ChannelMap, at: ChannelReader, traits: HueLampTraits | null): RGB {
  const { warm, cool, fixed } = tonesOf(traits);
  if (!EMITTERS.some((name) => ch[name] !== undefined)) {
    const level = at(ch.dimmer);
    return normalizeMix(level * fixed.r, level * fixed.g, level * fixed.b);
  }
  const ww = at(ch.warmWhite);
  const cw = at(ch.coolWhite);
  const uv = at(ch.uv);
  return normalizeMix(
    at(ch.red) + ww * warm.r + cw * cool.r + uv * UV_RED,
    at(ch.green) + ww * warm.g + cw * cool.g,
    at(ch.blue) + ww * warm.b + cw * cool.b + uv * UV_BLUE,
  );
}

export function hueEmitterColour(v: EmitterLevels, dimmer: number, ch: ChannelMap, traits: HueLampTraits | null): RGB {
  return hueSectionColour(ch, (offset) => {
    if (offset === undefined) return 0;
    if (offset === ch.dimmer) return dimmer;
    if (offset === ch.red) return v.r;
    if (offset === ch.green) return v.g;
    if (offset === ch.blue) return v.b;
    if (offset === ch.coolWhite || offset === ch.white) return v.w;
    if (offset === ch.warmWhite || offset === ch.amber) return v.a;
    if (offset === ch.uv) return v.uv;
    return 0;
  }, traits);
}
