import { z } from 'zod';
import { activeEvents, sampleEnvelope } from '../envelope.ts';
import { hash01 } from '../hash.ts';
import { registerKind } from '../registry.ts';
import { accentPeak, azimuthAround, centreOf, distanceTo, farthestCorner, lengthIn, paint, pointIn, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import type { Point, Positions } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// Rings launched from an origin on every trigger interval, expanding (or closing) at a speed in metres per beat.
const anchorId = z.string().min(1).max(120);
export const shellSchema = v2CommonSchema.extend({
  origin: z.enum(['listener', 'centre', 'anchor', 'random']).default('anchor'),
  anchor: anchorId.default('speakerLeft'),
  alsoAnchor: anchorId.nullable().default('speakerRight'),
  profile: z.enum(['ring', 'fill', 'ramp']).default('ring'),
  direction: z.enum(['out', 'in']).default('out'),
  width: z.number().min(0.01).max(20).default(0.5),
  speed: z.number().min(0.01).max(40).default(2),
  // Degrees of spiral per metre: a ring a quarter turn round arrives 90/twistDeg metres later.
  twistDeg: z.number().min(-720).max(720).default(0),
});
export type ShellParams = z.output<typeof shellSchema>;

// A beat accent keeps the band's strength from the moment its ring launched.
interface ShellState { launched: Map<number, number> }

const RAMP_TAIL = 4;
const KEEP_LAUNCHES = 64;

function originsOf(p: ShellParams, room: Room, pos: Positions, event: number, seed: EffectFrame['seed']): Point[] {
  const centre = centreOf(pos);
  switch (p.origin) {
    case 'centre': return [centre];
    case 'listener': return [pos.plan ? centre : room.space?.listener ?? centre];
    case 'random': {
      if (!room.n) return [centre];
      const i = Math.min(room.n - 1, Math.floor(hash01(seed, 5, event) * room.n));
      return [{ x: pos.x[i], y: pos.y[i], z: pos.z[i] }];
    }
    default: {
      const anchors = room.space?.anchors ?? {};
      const first = pointIn(room, pos, anchors[p.anchor]) ?? centre;
      const second = p.alsoAnchor ? pointIn(room, pos, anchors[p.alsoAnchor]) : null;
      return second ? [first, second] : [first];
    }
  }
}

function launchStrength(p: ShellParams, s: ShellState, f: EffectFrame, event: number): number {
  if (p.trigger.mode !== 'beatAccent') return p.trigger.mode === 'volumeGate' ? triggerLevel(p, f) : 1;
  let strength = s.launched.get(event);
  if (strength === undefined) {
    strength = accentPeak(p, f);
    s.launched.set(event, strength);
    if (s.launched.size > KEEP_LAUNCHES) s.launched.delete(s.launched.keys().next().value!);
  }
  return strength;
}

function renderShell(p: ShellParams, s: ShellState, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const pos = positionsOf(room, p.space);
  const space = pos.plan ? 'plan' : 'room';
  const width = lengthIn(space, p.width), speed = lengthIn(space, p.speed);
  const twist = p.twistDeg === 0 ? 0 : 1 / Math.abs(p.twistDeg);
  const spiral = twist * 360;
  const reach = Math.max(...originsOf(p, room, pos, 0, f.seed).map((o) => farthestCorner(pos, o)), farthestCorner(pos, centreOf(pos)));
  const life = (reach + spiral + 2 * width) / speed + (p.profile === 'fill' ? p.envelope.attack + p.envelope.hold + p.envelope.release : 0);
  const t = f.beatPos - f.anchorBeat;
  const events = activeEvents(Number.isFinite(t) ? t : 0, p.trigger.beatInterval, life, 0).filter((e) => e.age >= 0);
  const levels = new Float32Array(room.n), along = new Float32Array(room.n);
  for (const event of events) {
    const strength = launchStrength(p, s, f, event.index);
    if (!(strength > 0)) continue;
    for (const origin of originsOf(p, room, pos, event.index, f.seed)) {
      const far = farthestCorner(pos, origin);
      const front = p.direction === 'out' ? speed * event.age : far + width - speed * event.age;
      for (let i = 0; i < room.n; i++) {
        const turn = twist ? azimuthAround(pos, i, origin) : 0;
        const d = distanceTo(pos, i, origin) + (twist ? (p.twistDeg > 0 ? turn : 360 - turn) * twist : 0);
        // Positive behind the front: the side the ring has already passed.
        const behind = p.direction === 'out' ? front - d : d - front;
        let lit = soft(behind, width, pos.size[i]);
        if (p.profile === 'ramp' && behind > 0) lit = Math.max(lit, 1 - behind / (RAMP_TAIL * width));
        if (p.profile === 'fill' && behind > 0) lit = Math.max(lit, sampleEnvelope(behind / speed, p.envelope));
        lit *= strength;
        if (lit > levels[i]) { levels[i] = lit; along[i] = d / Math.max(1e-6, far); }
      }
    }
  }
  for (let i = 0; i < room.n; i++) paint(p, f, along[i], levels[i], out[i]);
}

registerKind<ShellParams, ShellState>({
  kind: 'v2.shell', app: 'own', level: 'cell', schema: shellSchema,
  defaults: { params: shellSchema.parse({}), brightness: 1 }, stateful: true,
  init: () => ({ launched: new Map() }),
  render: (params, state, room, frame, out) => renderShell(params, state, room, frame, out),
});
