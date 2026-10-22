// A test kind that shows whether its room carried the unit space: red with it, green without.
import { z } from 'zod';
import { registerKind } from '../../src/shared/effects/registry.ts';

registerKind({
  kind: 'test.space-lit', app: 'own', level: 'cell', schema: z.object({}).passthrough(), defaults: { params: {} },
  init: () => ({}),
  render(_params, _state, room, _frame, out) {
    const spaced = !!room.space && room.space.x.length === room.n;
    for (let i = 0; i < room.n; i++) out[i] = { colour: { r: spaced ? 255 : 0, g: spaced ? 0 : 255, b: 0, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
  },
});
