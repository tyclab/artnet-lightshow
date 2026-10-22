import { z } from 'zod';
import type { ZodType } from 'zod';
import type { Colour } from '../../types/rig.ts';
import type { Room } from '../room.ts';
import { HOLD_BLACK_MS, HOLD_FLASH_MS, HOLD_STROBE_MAX_HZ, HUE_PULSE_FLOOR, HUE_PULSE_MS, holdStrobeDivision, holdStrobeFlash, huePulseLevel } from '../look-math.ts';
import { DRAWN_STROBE_FUNCTIONS, strobeLevel } from '../strobe-fx.ts';
import { hash01 } from './hash.ts';
import { positionsOf } from './v2/common.ts';
import { pickSegments, selectionOf as segmentsOf } from './v2/selection.ts';
import { registerKind } from './registry.ts';
import type { EffectFrame, EffectSlot } from './types.ts';

export { hdAutoStrobeFlash } from './disco.ts';

export const STROBE_FUNCTION_IDS = ['palette', ...DRAWN_STROBE_FUNCTIONS] as [
    string,
    ...string[]
];

export interface StrobeParams {
  colourMode: 'palette' | 'white' | 'first';
  selection: 'all' | 'step' | 'scatter' | 'zone';
  space: 'room' | 'plan';
  density: number;
  segmentM: number;
  placeM: number;
  zone: 'width' | 'depth' | 'height';
  function: string;
  speed: number;
  flashesPerSecond: number;
  continueBetween: boolean;
  clock: 'wall' | 'beat';
  brightness: number;
  onMs: typeof HOLD_FLASH_MS;
  blackMs: typeof HOLD_BLACK_MS;
}

export const STROBE_DEFAULTS: StrobeParams = { colourMode: 'palette', selection: 'all', space: 'plan', density: 0.25, segmentM: 0.5, placeM: 1.5, zone: 'width', function: 'palette', speed: 128, flashesPerSecond: 2, continueBetween: true, clock: 'beat', brightness: 1, onMs: HOLD_FLASH_MS, blackMs: HOLD_BLACK_MS };

export const STROBE_FRAME_MS = 1000 / 44;
const CLOCK_SLACK_MS = 1e-6;
// Allow one frame of timing slack when converting the maximum flash rate to frame gaps.
export const GAP_FRAMES = Math.ceil((1000 / HOLD_STROBE_MAX_HZ - STROBE_FRAME_MS) / STROBE_FRAME_MS);
// A rolling second of frames must contain no more than MAX_LAMP_FLASH_HZ rises.
export const WINDOW_FRAMES = Math.round(1000 / STROBE_FRAME_MS);

export const strobeFrameOf = (nowMs: number): number => Math.round(nowMs / STROBE_FRAME_MS);

export const STROBE_PARAMS_SCHEMA = z.object({
  colourMode: z.enum(['palette', 'white', 'first']).default('palette'),
  selection: z.enum(['all', 'step', 'scatter', 'zone']).default('all'),
  space: z.enum(['room', 'plan']).default('plan'),
  density: z.number().min(0.01).max(1).default(0.25),
  segmentM: z.number().min(0).max(10).default(0.5),
  placeM: z.number().min(0.1).max(20).default(1.5),
  zone: z.enum(['width', 'depth', 'height']).default('width'),
  function: z.enum(STROBE_FUNCTION_IDS).default('palette'),
  speed: z.number().int().min(1).max(255).default(128),
  flashesPerSecond: z.number().int().min(1).max(HOLD_STROBE_MAX_HZ),
  continueBetween: z.boolean(),
  clock: z.enum(['wall', 'beat']),
  brightness: z.number().min(0).max(1),
  onMs: z.literal(HOLD_FLASH_MS),
  blackMs: z.literal(HOLD_BLACK_MS),
}).strict();
export const STROBE_PARAMS_EDIT_SCHEMA = z.object({
  colourMode: z.enum(['palette', 'white', 'first']),
  selection: z.enum(['all', 'step', 'scatter', 'zone']),
  space: z.enum(['room', 'plan']),
  density: z.number().min(0.01).max(1),
  segmentM: z.number().min(0).max(10),
  placeM: z.number().min(0.1).max(20),
  zone: z.enum(['width', 'depth', 'height']),
  function: z.enum(STROBE_FUNCTION_IDS),
  speed: z.number().int().min(1).max(255),
  flashesPerSecond: z.number().int().min(1).max(HOLD_STROBE_MAX_HZ),
  continueBetween: z.boolean(),
  clock: z.enum(['wall', 'beat']),
  brightness: z.number().min(0).max(1),
  onMs: z.literal(HOLD_FLASH_MS),
  blackMs: z.literal(HOLD_BLACK_MS),
}).partial().strict();

const schema: ZodType<StrobeParams> = STROBE_PARAMS_SCHEMA;

const BLACK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const WHITE: Colour = { ...BLACK, r: 255, g: 255, b: 255 };

interface Flash { id: string; startMs: number; colour: Colour }

// Remember refused flashes as seen so later renders cannot replay them.
interface StrobeState { originMs: number; rises: number[]; seen: string | null; shown: Flash | null; ceiling: number[]; selected: Set<number> | null; selectionCycle: number }

const rateOf = (fps: number) => Number.isFinite(fps) ? Math.max(1, Math.min(HOLD_STROBE_MAX_HZ, fps)) : 1;

// Require both grid spacing and per-lamp frame permits so tempo changes cannot accelerate flashes.
function permits(s: StrobeState, dueMs: number, frameIndex: number, fps: number): boolean {
  if (s.shown && !(dueMs - s.shown.startMs >= 1000 / fps - CLOCK_SLACK_MS)) return false;
  const last = s.rises[s.rises.length - 1];
  if (last !== undefined && !(frameIndex - last >= GAP_FRAMES)) return false;
  const fifth = s.rises.length >= HOLD_STROBE_MAX_HZ ? s.rises[s.rises.length - HOLD_STROBE_MAX_HZ] : undefined;
  return fifth === undefined || frameIndex - fifth >= WINDOW_FRAMES;
}

function gridFlash(p: StrobeParams, s: StrobeState, frame: EffectFrame, fps: number, atMs: number): Flash | null {
  const palette = p.colourMode === 'white' ? [{ ...WHITE, w: 255 }] : !frame.palette.length ? [WHITE]
    : p.colourMode === 'first' ? [frame.palette[0]] : frame.palette;
  if (p.clock === 'wall') {
    const periodMs = Math.ceil(1000 / fps);
    const originMs = Number.isFinite(frame.startedAtMs) ? frame.startedAtMs! : s.originMs;
    const index = Math.floor((atMs - originMs + CLOCK_SLACK_MS) / periodMs);
    if (!Number.isFinite(index)) return null;
    const colour = palette[Math.floor(hash01(frame.seed, 0, index) * palette.length)];
    return { id: `wall:${originMs}:${periodMs}:${index}`, startMs: originMs + index * periodMs, colour };
  }
  const shift = frame.bpm > 0 ? (atMs - frame.nowMs + CLOCK_SLACK_MS) * frame.bpm / 60000 : 0;
  const pos = frame.beatPos + shift - frame.anchorBeat;
  if (!Number.isFinite(pos)) return null;
  const flash = holdStrobeFlash(pos, frame.bpm, fps);
  const n = palette.length;
  return { id: `beat:${frame.anchorBeat}:${holdStrobeDivision(frame.bpm, fps)}:${flash.index}`, startMs: atMs - flash.sinceMs,
    colour: palette[((flash.index % n) + n) % n] };
}

export const STROBE_PROGRAM_KIND = 'strobe.program';

const PROGRAM_MIN_MS = 1000 / HOLD_STROBE_MAX_HZ;

function renderProgram(p: StrobeParams, s: StrobeState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  if (!Number.isFinite(frame.beatPos))
    return;
  const palette = p.colourMode === 'white' ? [{ ...WHITE, w: 255 }] : !frame.palette.length ? [WHITE]
    : p.colourMode === 'first' ? [frame.palette[0]] : frame.palette;
  const cycle = Math.floor((frame.nowMs - s.originMs) * rateOf(p.flashesPerSecond) / 1000);
  const selected = selectionOf(p, room, frame, cycle);
  for (let i = 0; i < room.n; i++) {
    if (selected && !selected.has(i)) {
      if (!p.continueBetween) out[i] = { colour: { ...BLACK }, level: 0, strength: 1, kind: STROBE_PROGRAM_KIND };
      continue;
    }
    const lamp = p.selection === 'all' ? i : room.lamps?.lampOf[i] ?? i;
    const level = strobeLevel(p.function, p.speed, frame.beatPos, frame.bpm, lamp, PROGRAM_MIN_MS) * p.brightness;
    if (level > 0)
      out[i] = { colour: { ...palette[lamp % palette.length] }, level, strength: 1, kind: STROBE_PROGRAM_KIND };
    else if (!p.continueBetween)
      out[i] = { colour: { ...BLACK }, level: 0, strength: 1, kind: STROBE_PROGRAM_KIND };
  }
}

function selectionOf(p: StrobeParams, room: Room, frame: EffectFrame, cycle: number): Set<number> | null {
  if (p.selection === 'all') return null;
  if (p.selection === 'scatter') return new Set(pickSegments(segmentsOf(room, p.space, p.segmentM, p.placeM), frame.seed, cycle, p.density).units);
  const lamps = room.lamps ?? room, positions = positionsOf(lamps, p.space);
  const count = Math.max(1, Math.ceil(lamps.n * p.density));
  let chosen: number[];
  if (p.selection === 'zone') {
    const axis = p.zone === 'width' ? positions.x : p.zone === 'depth' ? positions.z : positions.y;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < lamps.n; i++) { lo = Math.min(lo, axis[i]); hi = Math.max(hi, axis[i]); }
    chosen = Array.from({ length: lamps.n }, (_, i) => i).filter((i) => Number(axis[i] >= (lo + hi) / 2) === ((cycle % 2) + 2) % 2);
  } else {
    let x = 0, z = 0;
    for (let i = 0; i < lamps.n; i++) { x += positions.x[i] / lamps.n; z += positions.z[i] / lamps.n; }
    const order = Array.from({ length: lamps.n }, (_, i) => i).sort((a, b) =>
      Math.atan2(positions.z[a] - z, positions.x[a] - x) - Math.atan2(positions.z[b] - z, positions.x[b] - x) || a - b);
    chosen = Array.from({ length: Math.min(count, lamps.n) }, (_, k) => order[((cycle + k) % lamps.n + lamps.n) % lamps.n]);
  }
  return new Set(room.lamps ? chosen.flatMap((i) => [...room.lamps!.slots[i]]) : chosen);
}

function renderStrobe(p: StrobeParams, s: StrobeState, room: Room, frame: EffectFrame, out: EffectSlot[]): void {
  if (!Number.isFinite(frame.nowMs)) return;
  if (p.function !== 'palette') {
    renderProgram(p, s, room, frame, out);
    return;
  }
  const fps = rateOf(p.flashesPerSecond);
  const pulse = frame.hueStrobe === 'pulse';
  const frameIndex = strobeFrameOf(frame.nowMs), atMs = frameIndex * STROBE_FRAME_MS;
  const candidate = gridFlash(p, s, frame, fps, atMs);
  if (!candidate) return;
  let rose = false;
  if (candidate.id !== s.seen) {
    s.seen = candidate.id;
    // Mixed rooms use the longer Hue pulse lifetime even when targets select only pars.
    const window = pulse && room.hue.some(Boolean) ? HUE_PULSE_MS : p.onMs;
    if (atMs - candidate.startMs < window && permits(s, candidate.startMs, frameIndex, fps)) {
      s.rises = [...s.rises.slice(1 - HOLD_STROBE_MAX_HZ), frameIndex];
      s.shown = { ...candidate, colour: { ...candidate.colour } };
      s.selected = selectionOf(p, room, frame, s.selectionCycle++);
      rose = true;
    }
  }
  // A refused flash must not truncate the last admitted flash.
  const flash = s.shown ?? candidate;
  // Microsecond rounding keeps float slack from changing a level at a byte boundary.
  const age = Math.round((frame.nowMs - flash.startMs) * 1000) / 1000;
  if (s.ceiling.length > room.n) s.ceiling.length = room.n;
  for (let i = 0; i < room.n; i++) {
    if (s.selected && !s.selected.has(i)) {
      s.ceiling[i] = 0;
      if (!p.continueBetween) out[i] = { colour: { ...BLACK }, level: 0, strength: 1 };
      continue;
    }
    const hue = pulse && room.hue[i];
    const want = hue ? huePulseLevel(age) / 255 * p.brightness
      : age < p.onMs ? p.brightness
        : age < p.onMs + p.blackMs || !p.continueBetween ? 0 : null;
    // Between admissions each lamp may only dim, so edits cannot create extra rises.
    const floor = hue ? HUE_PULSE_FLOOR / 255 * p.brightness : 0;
    const level = want === null ? null : rose ? want : Math.min(want, Math.max(s.ceiling[i] ?? 0, floor));
    s.ceiling[i] = level ?? 0;
    if (level !== null) out[i] = { colour: level > 0 ? { ...flash.colour } : { ...BLACK }, level, strength: 1 };
  }
}

registerKind<StrobeParams, StrobeState>({
  kind: 'strobe', app: 'own', schema, defaults: { params: STROBE_DEFAULTS, palette: ['#FFFFFF'], brightness: 1 },
  rapidFlash: true, stateful: true,
  pacesOwnFlashes: () => true,
  init: (_params, _room, frame) => ({ originMs: Number.isFinite(frame.nowMs) ? frame.nowMs : 0, rises: [], seen: null, shown: null, ceiling: [], selected: null, selectionCycle: 0 }),
  render: renderStrobe,
});
