import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { registerKind } from '../registry.ts';
import { accentStrobes, intervalAge, paint, triggerLevel, v2CommonSchema } from './common.ts';

export const washSchema = v2CommonSchema.extend({
  shape: z.enum(['steady', 'breathe', 'envelope']).default('steady'),
  cycleBeats: z.number().min(0.25).max(64).default(8),
  depth: z.number().min(0).max(1).default(1),
});
type WashParams = z.output<typeof washSchema>;

registerKind<WashParams, null>({
  kind: 'v2.wash', app: 'own', level: 'cell', schema: washSchema,
  defaults: { params: washSchema.parse({}), brightness: 1 },
  rapidFlashWhen: (p) => accentStrobes(p) || (p.shape === 'envelope' && p.cycleBeats <= 0.25),
  init: () => null,
  render(p, _state, room, f, out) {
    const t = Math.max(0, f.beatPos - f.anchorBeat);
    const phase = t / p.cycleBeats % 1;
    const shape = p.shape === 'steady' ? 1 : p.shape === 'breathe' ? (1 - Math.cos(phase * Math.PI * 2)) / 2
      : sampleEnvelope(intervalAge({ ...p, trigger: { ...p.trigger, beatInterval: p.cycleBeats } }, f), p.envelope);
    const level = (1 - p.depth + p.depth * shape) * triggerLevel(p, f);
    for (let i = 0; i < room.n; i++) paint(p, f, phase, level, out[i]);
  },
});
