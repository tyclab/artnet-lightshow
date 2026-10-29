import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { registerKind } from '../registry.ts';
import { accentStrobes, azimuthAround, centreOf, distanceTo, gapsWithoutFloor, isFlashEnvelope, paint, pointIn, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import type { EffectFrame } from '../types.ts';
import type { Room } from '../../room.ts';
import type { Positions } from './common.ts';

export const zonesSchema = v2CommonSchema.extend({
  partition: z.enum(['leftRight', 'frontBack', 'floorCeiling', 'nearFar', 'surround', 'technology', 'role', 'stems']).default('leftRight'),
  mode: z.enum(['alternate', 'fill', 'rotate']).default('alternate'),
  stepBeats: z.number().min(0.125).max(16).default(1),
  reverse: z.boolean().default(false),
  softness: z.number().min(0).max(1).default(0.15),
  radiusM: z.number().min(0.1).max(20).default(2),
});
type ZonesParams = z.output<typeof zonesSchema>;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const frac = (x: number) => x - Math.floor(x);

function partitionOf(p: ZonesParams, room: Room, f: EffectFrame): { order: Float32Array; count: number } {
  const pos = positionsOf(room, p.space), centre = pos.plan ? centreOf(pos) : room.space?.listener ?? centreOf(pos);
  const facing = pos.plan ? 0 : room.space?.listener.facingDeg ?? 0;
  const groups = [...new Set(room.group ?? [])];
  const count = p.partition === 'surround' || p.partition === 'technology' ? 4 : p.partition === 'role' ? Math.max(1, groups.length) : 2;
  const order = Float32Array.from({ length: room.n }, (_, i) => {
    const angle = frac((azimuthAround(pos, i, centre) - facing + 45) / 360);
    switch (p.partition) {
      case 'surround': return angle;
      case 'technology': return ['dmx', 'ddp', 'openrgb', 'hue'].indexOf(f.hardware?.[i]?.technology ?? (room.hue[i] ? 'hue' : 'dmx')) / 4;
      case 'role': return Math.max(0, groups.indexOf(room.group?.[i] ?? null)) / count;
      case 'floorCeiling': return clamp(pos.plan ? 1 - pos.z[i] : pos.y[i] / pos.bounds.height);
      case 'nearFar': return clamp(distanceTo(pos, i, centre) / Math.max(0.001, p.radiusM / (pos.plan ? 4 : 1) * 2));
      case 'frontBack': return angle < 0.25 || angle >= 0.75 ? 0 : 0.75;
      default: return clamp(pos.plan ? pos.x[i] : (pos.x[i] + pos.bounds.width / 2) / pos.bounds.width);
    }
  });
  return { order, count };
}

function renderStems(p: ZonesParams, room: Room, pos: Positions, f: EffectFrame, i: number): { level: number; colour: number } {
  const bands = f.audioMode === 'reactive' ? f.audio?.party : null, stems = f.modulation?.stems;
  const t = Math.max(0, f.beatPos - f.anchorBeat), height = clamp(pos.plan ? 1 - pos.z[i] : pos.y[i] / pos.bounds.height);
  const bass = stems?.bass ?? bands?.bass ?? (0.55 + Math.cos(t * Math.PI * 2) * 0.35);
  const drums = stems?.drums ?? bands?.bass ?? Math.max(0, 1 - (t % 1) * 3);
  const vocals = stems?.vocals ?? bands?.mid ?? 0.6, hats = stems?.hats ?? bands?.high ?? 0.4;
  const speaker = pointIn(room, pos, room.space?.anchors.speakerLeft) ?? centreOf(pos);
  const other = pointIn(room, pos, room.space?.anchors.speakerRight) ?? speaker;
  const d = Math.min(distanceTo(pos, i, speaker), distanceTo(pos, i, other));
  const scale = pos.plan ? 0.25 : 1;
  const floor = Math.max(soft(height, 0.35, 0), soft(d, 1.1 * scale, pos.size[i]));
  const wave = soft(d - (t % 2) * 3 * scale, 0.45 * scale, pos.size[i]);
  const listener = pos.plan ? centreOf(pos) : room.space?.listener ?? centreOf(pos);
  const facing = pos.plan ? 0 : room.space?.listener.facingDeg ?? 0;
  const turn = (azimuthAround(pos, i, listener) - facing) * Math.PI / 180;
  const front = Math.max(0, Math.cos(turn)) * soft(height - 0.55, 0.45, 0);
  const sparkle = Math.sin(i * 2.399963 + Math.floor(t * 2)) > 0.25 ? 1 : 0;
  const levels = [clamp(bass) * floor, clamp(drums) * wave, clamp(vocals) * front, clamp(hats) * soft(1 - height, 0.35, 0) * sparkle];
  const level = Math.max(...levels);
  return { level, colour: levels.indexOf(level) / 3 };
}

registerKind<ZonesParams, ReturnType<typeof partitionOf>>({
  kind: 'v2.zones', app: 'own', level: 'cell', schema: zonesSchema, gapsApply: gapsWithoutFloor,
  defaults: { params: zonesSchema.parse({}), brightness: 1 },
  rapidFlashWhen: (p) => accentStrobes(p) || (p.stepBeats <= 0.25 && isFlashEnvelope(p.envelope)),
  init: partitionOf,
  render(p, state, room, f, out) {
    const pos = positionsOf(room, p.space), tick = Math.max(0, f.beatPos - f.anchorBeat) / p.stepBeats;
    const step = Math.floor(tick) % state.count, active = p.reverse ? state.count - 1 - step : step;
    const envelope = sampleEnvelope((tick % 1) * p.stepBeats, p.envelope), trigger = triggerLevel(p, f);
    for (let i = 0; i < room.n; i++) {
      if (p.partition === 'stems') {
        const stem = renderStems(p, room, pos, f, i);
        paint(p, f, stem.colour, stem.level * trigger, out[i]);
        continue;
      }
      const zone = Math.min(state.count - 1, Math.floor(state.order[i] * state.count));
      const selected = p.mode === 'fill' ? zone <= active : zone === active;
      const edge = p.softness > 0 && p.partition === 'floorCeiling'
        ? clamp(Math.abs(state.order[i] - 0.5) / p.softness) : 1;
      const level = selected ? envelope * edge : 0;
      paint(p, f, p.mode === 'rotate' ? frac(state.order[i] + step / state.count) : state.order[i], level * trigger, out[i]);
    }
  },
});
