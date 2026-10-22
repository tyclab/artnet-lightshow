import { z } from 'zod';
import { registerKind } from '../registry.ts';
import { accentStrobes, azimuthAround, centreOf, paint, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// A beam turning round a vertical axis through the listener (or the room centre), clockwise from the facing.
export const orbitSchema = v2CommonSchema.extend({
  axis: z.enum(['listener', 'centre']).default('listener'),
  profile: z.enum(['sectors', 'gradient', 'beacon']).default('beacon'),
  sectors: z.number().int().min(1).max(32).default(4),
  beamDeg: z.number().min(1).max(360).default(40),
  turnsPerBar: z.number().min(-16).max(16).default(1),
  // Degrees of lag per metre above the axis's height, so the beam climbs as it turns.
  heightTiltDeg: z.number().min(-720).max(720).default(0),
});
export type OrbitParams = z.output<typeof orbitSchema>;

const BEATS_PER_BAR = 4;
const wrap180 = (deg: number) => deg - 360 * Math.floor((deg + 180) / 360);
const frac = (v: number) => v - Math.floor(v);

function renderOrbit(p: OrbitParams, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const pos = positionsOf(room, p.space);
  const listener = !pos.plan && p.axis === 'listener' ? room.space?.listener : undefined;
  const axis = listener ?? centreOf(pos);
  const facing = listener?.facingDeg ?? 0;
  const t = f.beatPos - f.anchorBeat;
  const beam = facing + (360 * p.turnsPerBar * (Number.isFinite(t) ? t : 0)) / BEATS_PER_BAR;
  const trigger = triggerLevel(p, f);
  const palette = Math.max(1, f.gradient ? p.sectors : f.palette.length);
  for (let i = 0; i < room.n; i++) {
    const around = azimuthAround(pos, i, axis);
    const lift = pos.plan ? 0 : p.heightTiltDeg * (pos.y[i] - axis.y);
    const offset = wrap180(around + lift - beam);
    if (p.profile === 'beacon') {
      const reach = Math.hypot(pos.x[i] - axis.x, pos.z[i] - axis.z);
      const spread = reach > 1e-6 ? (Math.atan2(pos.size[i], reach) * 180) / Math.PI : 180;
      paint(p, f, around / 360, soft(offset, p.beamDeg, spread) * trigger, out[i]);
    } else if (p.profile === 'sectors') {
      // Sector k is centred k sectors round from the beam; its colour is palette entry k.
      const k = Math.round((wrap180(offset) / 360) * p.sectors + p.sectors) % p.sectors;
      paint(p, f, (k % palette) / palette, trigger, out[i]);
    } else {
      paint(p, f, frac(offset / 360), trigger, out[i]);
    }
  }
}

registerKind<OrbitParams, Record<string, never>>({
  kind: 'v2.orbit', app: 'own', level: 'cell', schema: orbitSchema,
  defaults: { params: orbitSchema.parse({}), brightness: 1 },
  rapidFlashWhen: accentStrobes,
  init: () => ({}),
  render: (params, _state, room, frame, out) => renderOrbit(params, room, frame, out),
});
