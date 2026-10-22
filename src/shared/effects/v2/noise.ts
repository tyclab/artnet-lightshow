import { z } from 'zod';
import { registerKind } from '../registry.ts';
import { accentStrobes, lengthIn, paint, positionsOf, triggerLevel, v2CommonSchema } from './common.ts';

export const noiseSchema = v2CommonSchema.extend({
  scaleM: z.number().min(0.1).max(20).default(1.8),
  speed: z.number().min(0).max(5).default(0.12),
  contrast: z.number().min(0.1).max(4).default(1.5),
  cutoff: z.number().min(0).max(0.95).default(0.25),
  octaves: z.number().int().min(1).max(3).default(2),
  shape: z.enum(['cloud', 'aurora', 'fire']).default('cloud'),
});
type NoiseParams = z.output<typeof noiseSchema>;
const smooth = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lattice(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967295;
}

export function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const u = smooth(x - ix), v = smooth(y - iy), w = smooth(z - iz);
  const row = (dy: number, dz: number) => lerp(lattice(ix, iy + dy, iz + dz, seed), lattice(ix + 1, iy + dy, iz + dz, seed), u);
  return lerp(lerp(row(0, 0), row(1, 0), v), lerp(row(0, 1), row(1, 1), v), w);
}

registerKind<NoiseParams, null>({
  kind: 'v2.noise', app: 'own', level: 'cell', schema: noiseSchema,
  defaults: { params: noiseSchema.parse({}), brightness: 1 }, rapidFlashWhen: accentStrobes,
  init: () => null,
  render(p, _state, room, f, out) {
    const pos = positionsOf(room, p.space), scale = lengthIn(pos.plan ? 'plan' : 'room', p.scaleM);
    const t = Math.max(0, f.beatPos - f.anchorBeat) * p.speed;
    const trigger = triggerLevel(p, f);
    for (let i = 0; i < room.n; i++) {
      const height = pos.plan ? 1 - pos.z[i] : pos.y[i] / pos.bounds.height;
      let value = 0, weight = 0;
      for (let octave = 0; octave < p.octaves; octave++) {
        const frequency = 2 ** octave, amplitude = 1 / frequency;
        value += noise3(pos.x[i] / scale * frequency + t * 0.2, (pos.plan ? 0 : pos.y[i] / scale) * frequency - t,
          pos.z[i] / scale * frequency + t * 0.37, f.seed[0] + octave * 7919) * amplitude;
        weight += amplitude;
      }
      value /= weight;
      if (p.shape === 'aurora') value *= 0.5 + 0.5 * Math.sin(height * 5 + t + value * 4);
      if (p.shape === 'fire') value = Math.max(0, value * 1.7 - height);
      const level = Math.min(1, Math.max(0, (value - p.cutoff) / (1 - p.cutoff)) ** p.contrast);
      paint(p, f, value, level * trigger, out[i]);
    }
  },
});
