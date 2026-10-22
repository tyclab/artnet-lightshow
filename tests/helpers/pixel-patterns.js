import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';

const DUO = [COLOR_PRESETS[0], COLOR_PRESETS[5], COLOR_PRESETS[0], COLOR_PRESETS[5]];

/** Run a pattern over `n` evenly spaced cells and return [colour, dim] per cell. */
export function draw(id, { n = 17, colors = DUO, ...ctx } = {}) {
  const out = [];
  PATTERN_FUNCS[id]({
    colors, fixtureCount: n, step: 0, hue: 0, twinkle: new Array(n).fill(0),
    write: (i, c, d) => { out[i] = [c, d]; }, ...ctx,
  });
  return out;
}
/** A W × H panel laid out per bar: x across it, y down it (0 its top row). */
export function panel(id, w, h, ctx = {}) {
  const n = w * h;
  const xs = []; const ys = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { xs.push(c / (w - 1)); ys.push(r / (h - 1)); }
  const out = draw(id, { n, xs, ys, ...ctx });
  return { at: (c, r) => out[r * w + c], out };
}

export const PULSE = { mix: 0.8, drums: 0.7, bass: 0.9, vocals: 0.2, other: 0.5, kick: 1, snare: 0, hats: 0 };

