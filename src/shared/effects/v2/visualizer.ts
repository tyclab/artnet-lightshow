import { z } from 'zod';
import { registerKind } from '../registry.ts';
import { accentStrobes, azimuthAround, centreOf, gapsWithoutFloor, lengthIn, paint, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

export const visualizerSchema = v2CommonSchema.extend({
  profile: z.enum(['sweep', 'orbit', 'noise']).default('orbit'),
  speed: z.number().min(0).max(8).default(1),
  width: z.number().min(0.05).max(10).default(0.6),
});
type Params = z.output<typeof visualizerSchema>;
interface Motion { phase: number; lastMs: number | null }

function render(p: Params, state: Motion, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const signal = f.pictureFeatures;
  const live = signal && signal.expiresAt > f.nowMs && signal.palette.length && signal.level > 0;
  const dt = state.lastMs === null ? 0 : Math.max(0, Math.min(0.25, (f.nowMs - state.lastMs) / 1000));
  state.lastMs = f.nowMs;
  if (live) state.phase = (state.phase + dt * signal.speed * p.speed) % 10000;
  const pos = positionsOf(room, p.space), centre = !pos.plan ? room.space?.listener ?? centreOf(pos) : centreOf(pos);
  const width = lengthIn(pos.plan ? 'plan' : 'room', p.width);
  const field = live ? { ...f, palette: signal.palette, gradient: null } : f;
  const gate = live ? triggerLevel(p, f) : 0;
  for (let i = 0; i < room.n; i++) {
    const x = pos.x[i], y = pos.plan ? 1 - pos.z[i] : pos.y[i], z = pos.z[i];
    let level: number, colour: number;
    if (p.profile === 'orbit') {
      const angle = azimuthAround(pos, i, centre) / 360 - state.phase / 4;
      colour = angle;
      level = Math.max(0, Math.cos(angle * Math.PI * 2));
    } else if (p.profile === 'sweep') {
      const span = pos.bounds.width + width * 2;
      const origin = pos.plan ? 0 : -pos.bounds.width / 2;
      const crest = origin - width + (state.phase / 4 % 1) * span;
      level = soft(x - crest, width, pos.size[i]); colour = (y / pos.bounds.height + state.phase / 8) % 1;
    } else {
      const scale = pos.plan ? 4 : 1;
      const wave = (Math.sin(x * scale - state.phase) + Math.sin(y * scale * 1.3 + state.phase * 0.7) + Math.sin(z * scale + state.phase * 0.4)) / 3;
      level = Math.max(0, wave); colour = (wave + 1) / 2;
    }
    paint(p, field, colour, level * gate, out[i]);
  }
}

registerKind<Params, Motion>({
  kind: 'v2.visualizer', app: 'own', level: 'cell', schema: visualizerSchema, gapsApply: gapsWithoutFloor,
  defaults: { params: visualizerSchema.parse({}), brightness: 1 }, stateful: true,
  rapidFlashWhen: accentStrobes, init: () => ({ phase: 0, lastMs: null }), render,
});
