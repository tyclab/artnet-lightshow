import { ambient, composeBackground } from './background.ts';
import type { BackgroundSettings } from './background.ts';
import { drawnByTheShow, strobeLevel } from './strobe-fx.ts';
import { outputEmitters } from './emitter-capability.ts';
import { hueEmitterColour } from './hue-colour.ts';
import { isHueProfile } from './hue-lamp.ts';
import { HardwareClock } from './hardware-clock.ts';
import { hueLightMeasure } from './hue-light.ts';
import { OutputGuard } from './output-guard.ts';
import { fixtureLuminance, limitRoomFlashes } from './room-flash.ts';
import { hardwareStrobe } from './hardware-strobe.ts';
import { hardwareOf } from './hardware.ts';
import type { UnitSpace } from './space.ts';
import type { HardwareCaps, HardwareSettings } from './hardware.ts';
import type { Profile } from '../types/rig.ts';
import { fixedColours, colourSlots, resolveGradient } from './palette-model.ts';
import type { PaletteBody } from './palette-model.ts';
import { PATTERN_FUNCS, paletteOf } from './patterns.ts';
import { renderLayer } from './layer.ts';
import { buildRig, rigSignature, isHueLamp } from './rig.ts';
import { EXPRESSION_REST, resolveEnergyOverride, blendExpression, blendFixture, HOLD_STROBE } from './look-math.ts';
import { gridFromAnalysis, beatPositionAt, localBpm, anchorStep, stepAt, motionAdvance } from './beat-clock.ts';
import { canonical, effectContentKey, handOverStrobes, relaunchEffect, renderEffectLayer, renderVoices, voiceAnchor, voiceLaunchKey, voiceLayout } from './effects/layer.ts';
import { energyEffectSpec } from './effects/catalogue.ts';
import { requiresAcknowledgement, ridesLevel, validateSpec } from './effects/registry.ts';
import { EffectStepper } from './effects/stepper.ts';
import { seedFrom } from './effects/hash.ts';
import { STROBE_FRAME_MS } from './effects/strobe.ts';
import { HD_MASTER_DEFAULTS } from './effects/types.ts';
import { copySequenceRun, newSequenceRun, renderSequenceLayer, transportOf } from './effects/sequence.ts';
import { parseHex } from './effects/palette.ts';
import type { AudioFrame } from './effects/audio-frame.ts';
import type { GridSource } from './beat-clock.ts';
import type { Layout, Rig } from './rig.ts';
import type { UnitLight } from './look-math.ts';
import type { VoiceFrame, VoiceRecord } from './effects/layer.ts';
import type { EffectInstance } from './effects/stepper.ts';
import type { SequenceRun, SequenceTable, SequenceTransport } from './effects/sequence.ts';
import type { EffectSlot, EffectSpec, FrameBase, Seed } from './effects/types.ts';
import type { ChannelMap, Colour, Expression, ShowDynamics, StageFixture } from '../types/rig.ts';

/** The look as a planned timeline builds it up, patch by patch. */
export interface PreviewLook {
  background?: BackgroundSettings;
  basePalette?: PaletteBody | null;
  baseSlotEdits?: Partial<Record<'colorA' | 'colorB' | 'colorC' | 'colorD', number>>;
  pattern: string;
  colorA: number;
  colorB: number;
  colorC: number;
  colorD: number;
  bpm: number;
  beatDivision: number;
  split?: number | null;
  pixelMap?: string | null;
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  panelPattern?: string | null;
  showDynamics?: ShowDynamics | null;
  [key: string]: unknown;
}

/** What a patch event carries: look keys, and how it arrives. */
export type PreviewPatch = Partial<PreviewLook> & {
  fadeMs?: number;
  id?: string;
  durationMs?: number;
};

export interface PreviewVoice {
  id: string;
  effect: EffectSpec;
  targets: 'shared' | number[];
  tier: 'strobe' | 'voice';
  launchSeq: number;
  /** Ends this long after its launch (half-open); absent runs until its `voice-end`. */
  durationMs?: number;
  seed?: Seed;
}

/** A `voice-end` event's data: the voice of this id stops. */
export interface PreviewVoiceEnd {
  id: string;
}

export interface PreviewEvent {
  timeMs: number;
  action?: string;
  id?: string;
  durationMs?: number;
  data?: PreviewPatch | PreviewVoice | PreviewVoiceEnd | null;
}

/** A fixture as the preview needs it: where it stands, how bright it may go, and its id for the voices. */
export interface PreviewFixture extends StageFixture {
  id?: number;
  maxBrightness?: number;
}

/** The rig's lights at a moment: one colour per unit, emitter values 0–255. */
export type PreviewSample = (
  positionMs: number,
  fixtures: readonly PreviewFixture[],
  presets: readonly Colour[] | null | undefined,
  rig?: Rig,
) => Colour[];

/** The settings' safety, as the renderer reads it. */
export interface PreviewSafety {
  hdFlashIntervalMs: number;
  acknowledged: boolean;
}

export interface PreviewAudioSource {
  /** Pure, seekable samples in timeline milliseconds; never reads the live audio input. */
  frameAt(positionMs: number): AudioFrame | null;
  modulationAt?(positionMs: number): FrameBase['modulation'];
  pictureAt?(positionMs: number): FrameBase['pictureFeatures'];
}

export interface PreviewOptions {
  background?: BackgroundSettings;
  audioSource?: PreviewAudioSource;
  hardware?: HardwareSettings;
  profiles?: Record<string, Profile>;
  resolveEffect?: ((id: string) => EffectSpec | null | undefined) | null;
  /** How Hue lamps take a flash. Absent is 'pulse', as for a renderer input without it. */
  hueStrobe?: 'flash' | 'pulse';
  safety?: Partial<PreviewSafety> | null;
  sequence?: { table: SequenceTable; transport: SequenceTransport } | null;
  paletteOverride?: readonly string[] | null;
  basePalette?: PaletteBody | null;
  overridePalette?: PaletteBody | null;
  /** Room metres per unit of the rig being sampled, as the renderer's setSpace; absent is plan-only. */
  space?: UnitSpace | null;
}

/** The override's colours, parsed once; anything that is not a list of hex colours is none. */
function overrideOf(hex: PreviewOptions['paletteOverride']): Colour[] | null {
  if (!Array.isArray(hex) || !hex.length) return null;
  try {
    return hex.map((entry) => parseHex(entry));
  } catch {
    return null;
  }
}

interface Frame {
  timeMs: number;
  beatPos: number;
  look: PreviewLook;
  anchor: number;
  /** The beat the scene the pattern counts from was scheduled on, or null before any. */
  anchorBeat: number | null;
  burst: { id: string | undefined; end: number } | null;
  expression: Expression;
  motionPhase: number;
  fade: { from: number; start: number; ms: number } | null;
}

interface LayerEntry {
  strobe?: number;
  color: Colour;
  dim: number;
}

const LOOK_KEYS = ['basePalette', 'pattern', 'palette', 'split', 'pixelMap', 'pixelPattern', 'panelPattern', 'colorA', 'colorB', 'colorC', 'colorD'];
const COLOUR_KEYS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;

const OPENING: PreviewLook = {
  pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120, beatDivision: 1,
};

// The engine's frame (server/frame-clock.ts), which the browser cannot import.
const FRAME_MS = STROBE_FRAME_MS;
// Float rounding of grid times: an event at 500 ms is due on the frame at 22 × 1000/44.
const SLACK_MS = 1e-6;
const gridTime = (k: number): number => k * FRAME_MS;
/** The last frame of the grid at or before `ms`. */
const frameAt = (ms: number): number => Math.floor((ms + SLACK_MS) / FRAME_MS);
const CHECKPOINT_FRAMES = 44;
const CHECKPOINTS = 16;
// A copy costs about five frames' stepping: a walk moves to one ahead of it only when that saves more.
const COPY_FRAMES = 8;

/** What a stepped frame does with an event once it is due. */
type EventOp = { kind: 'voice'; voice: VoiceFrame } | { kind: 'end'; id: string } | { kind: 'seek' } | null;

/** A `voice` event's voice, checked once; null for one that is not well formed. */
function voiceOf(event: PreviewEvent, beatPos: number): VoiceFrame | null {
  const d = event.data as Partial<PreviewVoice> | null | undefined;
  if (!d || typeof d.id !== 'string' || !d.id) return null;
  if (d.tier !== 'strobe' && d.tier !== 'voice') return null;
  if (!Number.isSafeInteger(d.launchSeq)) return null;
  let targets: number[] | null;
  if (d.targets === 'shared') targets = null;
  else if (Array.isArray(d.targets) && d.targets.every((id) => Number.isSafeInteger(id))) targets = Object.freeze([...d.targets]) as number[];
  else return null;
  let untilMs: number | null = null;
  if (d.durationMs !== undefined) {
    untilMs = event.timeMs + d.durationMs;
    if (!(Number.isFinite(d.durationMs) && d.durationMs > 0 && Number.isFinite(untilMs))) return null;
  }
  let seed: Seed;
  if (d.seed === undefined) seed = seedFrom(d.id);
  else if (Array.isArray(d.seed) && d.seed.length === 4 && d.seed.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff)) {
    seed = [d.seed[0], d.seed[1], d.seed[2], d.seed[3]];
  } else return null;
  let spec: EffectSpec;
  // Voices come from the server, which alone builds internal kinds.
  try { spec = validateSpec(d.effect, { internal: true }); } catch { return null; }
  // Never changed after this: checkpoints share it.
  return Object.freeze({ id: d.id, spec, targets, tier: d.tier, launchSeq: d.launchSeq as number, startedAtMs: event.timeMs,
    untilMs, anchorBeat: beatPos, seed });
}

/** An object's JSON: read afresh each time, as a caller may change an object it hands over again. */
const contentOf = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

/** Everything a rig built by buildRig draws from its patch and profiles. */
function rigContent(rig: Rig): string {
  // The bars of one profile share their cells' maps: each read once per call.
  const seen = new Map<object, string>();
  const mapOf = (map: ChannelMap) => {
    let text = seen.get(map);
    if (text === undefined) { text = contentOf(map); seen.set(map, text); }
    return text;
  };
  let key = rigSignature(rig.fixtures);
  for (let i = 0; i < rig.fixtures.length; i++) {
    const maps = rig.cellMaps[i];
    key += `#${rig.ranges[i].count};${maps ? maps.map(mapOf).join(',') : ''};${contentOf(rig.grids[i])};${rig.zoned[i] ? 'z' : ''}`;
  }
  return key;
}

/** What the preview reads of each fixture: its id, its trim and whether it is a Hue lamp. */
function fixturesContent(fixtures: readonly PreviewFixture[]): string {
  let key = `${fixtures.length}`;
  for (const f of fixtures) key += JSON.stringify([f.hardware, f.productId, f.admission, f.output?.protocol]) + `|${f.id ?? ''};${f.maxBrightness ?? 255};${isHueLamp(f) ? 'h' : ''}`;
  return key;
}

/** Specs checked once per content: the resolver may hand over the same effect as a new object each time. */
const checked = new Map<string, EffectSpec | null>();
function checkedSpec(raw: unknown): { spec: EffectSpec | null; key: string } {
  if (!raw || typeof raw !== 'object') return { spec: null, key: 'null' };
  const key = canonical(raw);
  if (!checked.has(key)) {
    if (checked.size >= 512) checked.clear();
    let spec: EffectSpec | null;
    try { spec = validateSpec(raw); } catch { spec = null; }
    checked.set(key, spec);
  }
  return { spec: checked.get(key)!, key };
}

/** The cells of a layout with each cell's fixture id and Hue flag, as the renderer's effects read them. */
interface Cells {
  hardware?: HardwareCaps[];
  key: string;
  layout: Layout;
  ids: (number | string)[];
}

interface Env {
  hardware?: HardwareCaps[];
  key: string;
  stepped: boolean;
  fixtures: readonly PreviewFixture[];
  presets: readonly Colour[];
  rig: Rig;
  specs: Map<string, EffectSpec | null>;
  hue: boolean[];
  cells: Map<string, Cells>;
}

// ── The stepped history ─────────────────────────────────────────────────────

/** Everything a frame of the grid leaves for the next: a checkpoint is a copy of one. */
interface Walk {
  /** The last frame rendered (its index on the grid), or the one before the first. */
  k: number;
  /** How many timeline events have been applied. */
  cursor: number;
  stepper: EffectStepper;
  outputGuard: OutputGuard;
  /** The strobe's permit per lamp, as the renderer keeps it. */
  hardwareClock: HardwareClock;
  expression: Expression;
  phase: number;
  lastBeat: number | null;
  lastEpoch: number;
  lastNow: number | null;
  lastSweep: number;
  /** Seek markers so far: the rig's clock epoch. */
  epoch: number;
  base: { key: string; id: string; kind: string; seed: Seed; startedAtMs: number } | null;
  /** The voices launched and not ended, in launch order. */
  voices: Map<string, VoiceFrame>;
  records: Map<string, VoiceRecord>;
  /** The strobe voices whose state the stepper holds, as the renderer keeps them. */
  strobes: Set<string>;
  /** The energy burst lane as a voice of its own. */
  compat: { energy: string; voice: VoiceFrame } | null;
  /** The fade in progress: which of the timeline's fades, and the base it froze. */
  fadeOf: Frame['fade'];
  fade: { start: number; ms: number; from: UnitLight[] } | null;
  /** The base layer as it went out on the last frame, per light: what a fade starts from. */
  shown: UnitLight[];
  /** The last frame's lights. */
  output: Colour[] | null;
  /** The sequence's laps playing and the last moment it played. */
  seq: SequenceRun;
}

/** A checkpoint's own copy: nothing in it is shared with the walk it came from but what is never changed. */
function copyWalk(w: Walk): Walk {
  return {
    ...w,
    stepper: w.stepper.clone(),
    outputGuard: w.outputGuard.clone(),
    hardwareClock: w.hardwareClock.clone(),
    expression: { ...w.expression },
    base: w.base && { ...w.base },
    // Voice frames, fade sources, shown lights and outputs are made afresh and never changed.
    voices: new Map(w.voices),
    records: new Map([...w.records].map(([id, rec]) => [id, { ...rec }])),
    strobes: new Set(w.strobes),
    compat: w.compat && { ...w.compat },
    fade: w.fade && { ...w.fade },
    shown: [...w.shown],
    seq: copySequenceRun(w.seq),
  };
}

/** A copy of the walk to start from again: a scene's or a seek's for good, a periodic one while it is used. */
interface Checkpoint { walk: Walk; periodic: boolean; used: number }

const emptyWalk = (k: number, intervalMs: number): Walk => ({
  k, cursor: 0, stepper: new EffectStepper(), outputGuard: new OutputGuard(intervalMs), hardwareClock: new HardwareClock(), expression: { ...EXPRESSION_REST }, phase: 0,
  lastBeat: null, lastEpoch: 0, lastNow: null, lastSweep: -Infinity, epoch: 0, base: null, voices: new Map(), records: new Map(), strobes: new Set(),
  compat: null, fadeOf: null, fade: null, shown: [], output: null, seq: newSequenceRun(),
});

/** A light of the layer, as the renderer keeps one (its setUnitColor). */
const unitLight = (c: Colour, dim: number, strobe = 0): UnitLight => ({
  r: c.r, g: c.g, b: c.b, w: c.w || 0, a: c.a || 0, uv: c.uv || 0, dim, strobe,
});

function previewOutput(colour: Colour, scale: number, map: ChannelMap | undefined, profile: Profile | undefined): Colour {
  const emitters = outputEmitters(colour, scale, map);
  if (!map || !isHueProfile(profile)) return emitters;
  const dimmer = Math.round(Math.max(0, Math.min(255, 255 * scale)));
  return { ...hueEmitterColour(emitters, dimmer, map, profile.hue), w: 0, a: 0, uv: 0 };
}

function createPreviewSampler(events: readonly PreviewEvent[] = [], grid: GridSource | null = null,
  options: PreviewOptions = {}): PreviewSample {
  const beatGrid = gridFromAnalysis(grid);
  const hueStrobe = options.hueStrobe === 'flash' ? 'flash' : 'pulse';
  const safetyGiven = options.safety != null;
  const givenInterval = options.safety?.hdFlashIntervalMs;
  const intervalMs = typeof givenInterval === 'number' && Number.isFinite(givenInterval) && givenInterval >= 0 ? givenInterval : 350;
  const acknowledged = options.safety?.acknowledged === true;
  const sequence = sequenceOf(options.sequence);
  const paletteOverride = options.overridePalette ? fixedColours(options.overridePalette, []) : overrideOf(options.paletteOverride);

  // In time order, ties in the order given, on a copy: an event with no time is ignored.
  const timeline = events.filter((e) => Number.isFinite(e.timeMs)).sort((a, b) => a.timeMs - b.timeMs);
  const strobeBursts = timeline.some((event) => event.action === 'energy'
    && energyEffectSpec(String((event.data as PreviewPatch | undefined)?.id ?? event.id ?? ''))?.kind === 'strobe');

  let look: PreviewLook = { ...OPENING, ...(options.background ? { background: options.background } : {}), ...(options.basePalette ? { basePalette: options.basePalette } : {}) };
  let anchor = 0;
  let anchorBeat: number | null = null;
  let burst: Frame['burst'] = null;
  let expression: Expression = { ...EXPRESSION_REST };
  let motionPhase = 0;
  // The crossfade in progress, as the engine keeps it: which frame was on
  // stage when it began, and when. A new look without a fade cuts it short.
  let fade: Frame['fade'] = null;
  let lastMs = events.length && Number.isFinite(events[0].timeMs) && timeline.length ? timeline[0].timeMs : 0;
  // Without a grid, the beat count the free clock would have reached: each
  // stretch between events at the tempo in force across it.
  let freeBeats = 0;

  const frames: Frame[] = [];
  const ops: EventOp[] = [];
  /** Where the music is at `timeMs`, in beats, within frame `f` (or the walk so far). */
  const beatAt = (timeMs: number, f: Pick<Frame, 'timeMs' | 'beatPos' | 'look'>): number => (beatGrid
    ? beatPositionAt(beatGrid, timeMs)
    : f.beatPos + ((timeMs - f.timeMs) / 60000) * Math.max(20, f.look.bpm || 120));

  for (const event of timeline) {
    const dt = Math.max(0, (event.timeMs - lastMs) / 1000);
    const walked = { timeMs: lastMs, beatPos: freeBeats, look };
    const beatsBefore = beatAt(lastMs, walked);
    const beatPos = beatAt(event.timeMs, walked);
    freeBeats = beatPos;
    motionPhase = (motionPhase + motionAdvance(beatPos - beatsBefore, expression.motion)) % 1;
    expression = blendExpression(expression, look.showDynamics || null, dt);
    lastMs = event.timeMs;

    let op: EventOp = null;
    if (event.action === 'patch') {
      const patch = (event.data || {}) as PreviewPatch;
      const dynamics = patch.showDynamics && { ...look.showDynamics, ...patch.showDynamics };
      const edits = Object.fromEntries(COLOUR_KEYS.filter((key) => patch[key] !== undefined).map((key) => [key, patch[key]]));
      const reset = patch.basePalette !== undefined || patch.palette !== undefined;
      look = { ...look, ...(patch.palette !== undefined ? { basePalette: null } : {}), ...patch,
        baseSlotEdits: reset ? {} : { ...look.baseSlotEdits, ...edits } };
      if (dynamics) look.showDynamics = dynamics;
      // As the rig anchors a scheduled scene (server/patch.js): on the step
      // grid, at the beat the scene was due.
      if (patch.pattern !== undefined || patch.pixelPattern !== undefined || patch.panelPattern !== undefined
        || patch.beatDivision !== undefined) {
        anchor = anchorStep(beatPos, look.beatDivision || 1);
        anchorBeat = beatPos;
      }
      if ('energyOverride' in patch) burst = null;
      // As the engine: a fade asked for starts one, and a new look or a fade of 0 cuts any in progress.
      if (patch.fadeMs && patch.fadeMs > 0) fade = { from: frames.length - 1, start: event.timeMs, ms: patch.fadeMs };
      else if (patch.fadeMs !== undefined || LOOK_KEYS.some((k) => patch[k] !== undefined)) fade = null;
    } else if (event.action === 'energy') {
      const patch = (event.data || {}) as PreviewPatch;
      burst = { id: patch.id || event.id, end: event.timeMs + (patch.durationMs || event.durationMs || 200) };
    } else if (event.action === 'voice') {
      const voice = voiceOf(event, beatPos);
      if (voice) op = { kind: 'voice', voice };
    } else if (event.action === 'voice-end') {
      const id = (event.data as Partial<PreviewVoiceEnd> | null | undefined)?.id;
      if (typeof id === 'string') op = { kind: 'end', id };
    } else if (event.action === 'seek') {
      op = { kind: 'seek' };
    }
    frames.push({ timeMs: event.timeMs, beatPos, look, anchor, anchorBeat, burst, expression, motionPhase, fade });
    ops.push(op);
  }

  // A voice event anywhere means the timeline owns its voices, as a renderer input with `voices` does.
  const explicitVoices = timeline.some((e) => e.action === 'voice' || e.action === 'voice-end');
  const patterns = [...new Set(frames.map((f) => f.look.pattern))];
  // An event that launches the base again (a seek, or a new pattern or anchor step: the base's id): a copy is kept before it.
  const keyframe = timeline.map((e, i) => {
    const before = frames[i - 1] ?? { look: OPENING, anchor: 0 };
    return ops[i]?.kind === 'seek' || (e.action === 'patch' && (frames[i].look.pattern !== before.look.pattern || frames[i].anchor !== before.anchor));
  });

  /** The look's four colours, resolved against the colour table. */
  const coloursOf = (s: PreviewLook, presets: readonly Colour[]): Colour[] => {
    const colours = fixedColours(s.basePalette, COLOUR_KEYS.map((key) => presets[s[key]] || presets[0]));
    if (!s.basePalette || !Object.keys(s.baseSlotEdits ?? {}).length) return colours;
    const slots = colourSlots(colours);
    COLOUR_KEYS.forEach((key, i) => { if (s.baseSlotEdits?.[key] !== undefined) slots[i] = presets[s.baseSlotEdits[key]]; });
    return slots;
  };

  function drawPattern(f: Frame, positionMs: number, rig: Rig, colors: Colour[], expr: Expression, phase: number, bpm: number, hardware?: HardwareCaps[], hardwareClock?: HardwareClock): LayerEntry[] {
    const s = f.look;
    const division = Math.max(1, s.beatDivision || 1);
    const beatPos = beatAt(positionMs, f);
    const step = stepAt(beatPos, f.anchor, division);
    colors = colourSlots(paletteOverride ?? colors);
    const layer: LayerEntry[] = rig.units.map(() => ({ color: colors[0], dim: 0 }));
    renderLayer(rig, {
      pattern: PATTERN_FUNCS[s.pattern] ? s.pattern : 'solid',
      colors,
      gradient: resolveGradient(paletteOverride ? options.overridePalette : s.basePalette, colors),
      split: s.split,
      pixelMap: s.pixelMap,
      pixelPattern: s.pixelPattern && PATTERN_FUNCS[s.pixelPattern] ? s.pixelPattern : null,
      pixelSpan: s.pixelSpan ?? null,
      pixelFrom: s.pixelFrom ?? null,
      panelPattern: s.panelPattern && PATTERN_FUNCS[s.panelPattern] ? s.panelPattern : null,
    }, {
      beatPos,
      step,
      anchor: f.anchor,
      division,
      phase,
      expression: expr,
      dynamicsOn: !!s.showDynamics,
      bpm,
      hueStrobe, hardware, hardwareClock,
      fixtureCount: rig.fixtures.length,
      twinkle: rig.units.map(() => 0),
      pixelTwinkle: rig.units.map(() => 0),
      panelTwinkle: rig.units.map(() => 0),
    }, (u, color, dim, strobe, background) => {
      const resolved = composeBackground(color, dim / 255, background, s.background);
      layer[u] = { color: resolved.colour, dim: resolved.level * 255, strobe };
    });
    return layer;
  }

  function patternLayer(index: number, positionMs: number, rig: Rig, presets: readonly Colour[]): {
    layer: LayerEntry[];
    colors: Colour[];
    expr: Expression;
    dyn: ShowDynamics | null;
  } {
    const frame = frames[index];
    const s = frame.look;
    const dyn = s.showDynamics || null;
    const since = Math.max(0, positionMs - frame.timeMs) / 1000;
    const expr = blendExpression(frame.expression, dyn, since);
    const beatPos = beatAt(positionMs, frame);
    const phase = (frame.motionPhase + motionAdvance(beatPos - frame.beatPos, expr.motion)) % 1;
    const colors = coloursOf(s, presets);
    const layer = drawPattern(frame, positionMs, rig, colors, expr, phase, s.bpm);

    // A crossfade starts from the look as it stood when the fade began, frozen
    // there, exactly as the engine snapshots it.
    const f = frame.fade;
    if (f && f.from >= 0 && positionMs < f.start + f.ms) {
      const from = patternLayer(f.from, f.start, rig, presets).layer;
      const t = Math.max(0, positionMs - f.start) / f.ms;
      return {
        layer: layer.map((to, u) => {
          const mixed = blendFixture({ ...from[u].color, dim: from[u].dim, strobe: 0 }, { ...to.color, dim: to.dim, strobe: 0 }, t);
          return { color: mixed, dim: mixed.dim };
        }),
        colors, expr, dyn,
      };
    }
    return { layer, colors, expr, dyn };
  }

  /** The last event at or before `positionMs`, or -1. */
  function frameIndex(positionMs: number): number {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].timeMs <= positionMs) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  function sampleLegacy(positionMs: number, env: Pick<Env, 'fixtures' | 'presets' | 'rig' | 'hue'>): Colour[] {
    const { fixtures, presets, rig } = env;
    const index = frameIndex(positionMs);
    const frame = frames[index];
    if (!frame) return dark(rig);

    const { layer, colors, expr, dyn } = patternLayer(index, positionMs, rig, presets);
    let burstId = frame.burst && positionMs < frame.burst.end ? frame.burst.id : null;
    if (burstId && safetyGiven && !acknowledged) {
      const spec = energyEffectSpec(burstId);
      if (spec && requiresAcknowledgement(spec)) burstId = null;
    }
    const energy = burstId ? resolveEnergyOverride(burstId, paletteOverride?.[0] ?? colors[0], expr.level) : null;
    return layer.map(({ color, dim, strobe }, u) => {
      const { fixture: i, cell } = rig.units[u];
      const fixture = fixtures[i];
      const burst = energy;
      if (burst) {
        color = burst.col;
        dim = burst.dim;
      } else {
        dim *= expr.level;
        if (dyn && dyn.level === 0) dim = 0;
      }
      const fn = String(frame.look.strobeFunction ?? 'standard');
      const raw = frame.look.pattern === 'strobe' ? Number(frame.look.strobeSpeed) || 0 : strobe ?? 0;
      if (!burst && raw > 0 && drawnByTheShow(fn)) {
        const caps = hardwareOf(fixture, options.profiles?.[fixture.profileId ?? ''], options.hardware);
        const maxHz = Math.min(caps.maxFlashHz, frame.look.flashLimit ? 3 : Infinity);
        dim *= strobeLevel(fn, raw, beatAt(positionMs, frame), frame.look.bpm, u, 1000 / maxHz);
      }
      const scale = (dim / 255) * ((fixture.maxBrightness ?? 255) / 255);
      const profile = options.profiles?.[fixture.profileId ?? ''];
      return previewOutput(color, scale, rig.cellMaps[i]?.[cell] ?? profile?.channelMap, profile);
    });
  }

  // ── The stepped timeline ──────────────────────────────────────────────────

  let env: Env | null = null;
  let walk: Walk | null = null;
  let checkpoints: Checkpoint[] = [];
  let periodicCount = 0;
  let uses = 0;
  let tail: { positionMs: number; output: Colour[] } | null = null;
  const firstFrame = timeline.length ? Math.ceil((timeline[0].timeMs - SLACK_MS) / FRAME_MS) : 0;

  /** The environment of this sample: the same one while its content is the same. */
  function environment(fixtures: readonly PreviewFixture[], presets: readonly Colour[], rig: Rig): Env {
    const specs = new Map<string, EffectSpec | null>();
    let effectsKey = '';
    let anyEffect = false;
    for (const id of patterns) {
      const { spec, key } = options.resolveEffect ? checkedSpec(options.resolveEffect(id)) : { spec: null, key: 'null' };
      specs.set(id, spec);
      if (spec) anyEffect = true;
      effectsKey += `${JSON.stringify(id)}=${key};`;
    }
    if (!(explicitVoices || strobeBursts || anyEffect || sequence || options.hardware || options.audioSource || frames.some((frame) => frame.look.flashLimit))) {
      // Nothing steps: answered straight from the timeline, nothing kept.
      if (env) { env = null; forgetHistory(); }
      return { key: '', stepped: false, fixtures, presets, rig, specs, hue: rig.hue, cells: new Map() };
    }
    const key = `${effectsKey}\n${fixturesContent(fixtures)}\n${rigContent(rig)}\n${presets.map(contentOf).join(',')}`;
    if (env && env.key === key) {
      // The same content: keep the history, but read this call's objects.
      env.fixtures = fixtures; env.presets = presets; env.rig = rig;
      return env;
    }
    env = { key, stepped: true, fixtures, presets, rig, specs, hue: rig.hue, cells: new Map(),
      hardware: options.hardware ? fixtures.map((f) => hardwareOf(f, options.profiles?.[f.profileId ?? ''], options.hardware)) : undefined };
    forgetHistory();
    return env;
  }

  function forgetHistory(): void {
    walk = null;
    checkpoints = [];
    periodicCount = 0;
    tail = null;
  }

  /** A layout's cells with their current fixture ids and Hue flags, as renderer.ts effectCells. */
  function cellsOf(e: Env, key: string, layout: () => Layout): Cells {
    let cells = e.cells.get(key);
    if (!cells) {
      const base = layout();
      const { list } = base.units;
      const ids = list.map((u) => { const i = e.rig.units[u].fixture; return e.fixtures[i]?.id ?? `#${i}`; });
      const flags = list.map((u) => e.hue[e.rig.units[u].fixture]);
      const noFlash = flags.some(Boolean) ? flags : null;
      cells = { key, layout: { ...base, units: { ...base.units, noFlash } }, ids,
        hardware: e.hardware && list.map((u) => e.hardware![e.rig.units[u].fixture]) };
      e.cells.set(key, cells);
    }
    return cells;
  }

  /** Apply every event due by `t` to the walk. */
  function advance(w: Walk, t: number): void {
    while (w.cursor < timeline.length && timeline[w.cursor].timeMs <= t + SLACK_MS) {
      const op = ops[w.cursor++];
      if (!op) continue;
      if (op.kind === 'voice') {
        // A relaunch under an id goes to the end of the table, as a new launch.
        w.voices.delete(op.voice.id);
        w.voices.set(op.voice.id, op.voice);
      } else if (op.kind === 'end') w.voices.delete(op.id);
      else w.epoch++;
    }
  }

  // The timeline's voice frames never change, so each one's launch key is read once.
  const launchKeys = new WeakMap<VoiceFrame, string>();
  function launchOf(v: VoiceFrame): string {
    let launch = launchKeys.get(v);
    if (launch === undefined) {
      launch = voiceLaunchKey(v);
      launchKeys.set(v, launch);
    }
    return launch;
  }

  function playingVoices(w: Walk, t: number, beatPos: number, f: Frame): { voices: VoiceFrame[]; admitted: Set<VoiceFrame> } {
    const energy = f.burst && t < f.burst.end ? f.burst.id ?? null : null;
    if (!energy) w.compat = null;
    else if (!w.compat || w.compat.energy !== energy) {
      const spec = energyEffectSpec(energy);
      const id = `energy:${energy}`;
      // The hold strobe stays on the global beat grid (anchor 0), as it always flashed.
      w.compat = spec ? { energy, voice: Object.freeze({ id, spec, targets: null, tier: energy === HOLD_STROBE ? 'strobe' : 'voice',
        launchSeq: 0, startedAtMs: t, untilMs: null, anchorBeat: 0, seed: seedFrom(id) }) } : null;
    }
    const compat = w.compat?.voice ?? null;
    const source = compat ? [...w.voices.values(), compat] : [...w.voices.values()];
    const admitted = new Set<VoiceFrame>();
    const seen = new Set<string>();
    const voices: VoiceFrame[] = [];
    for (const v of source) {
      if (!(t >= v.startedAtMs)) continue;
      if (v.untilMs != null && !(t < v.untilMs)) {
        // Time only runs forward on a walk: an ended voice never plays again.
        if (v !== compat) w.voices.delete(v.id);
        continue;
      }
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      const holdsGrid = v === compat || v.holdsGrid === true;
      const played: VoiceFrame = { ...v, anchorBeat: voiceAnchor(w.records, w.stepper, v, launchOf(v), w.epoch, f.anchorBeat ?? beatPos, holdsGrid) };
      if (v === compat && !safetyGiven) admitted.add(played);
      voices.push(played);
    }
    for (const id of w.records.keys()) if (!seen.has(id)) w.records.delete(id);
    handOverStrobes(w.stepper, w.strobes, voices);
    return { voices, admitted };
  }

  function render(w: Walk, t: number, e: Env, lights: boolean): Colour[] | null {
    const { fixtures, presets, rig } = e;
    const f = frames[w.cursor - 1];
    const s = f.look;
    const dt = w.lastNow === null ? 0 : Math.max(0, t - w.lastNow);
    w.lastNow = t;
    const target = s.showDynamics || null;
    w.expression = blendExpression(w.expression, target, Math.min(0.25, dt / 1000));
    const beatPos = beatAt(t, f);
    const dBeats = w.lastBeat !== null && w.lastEpoch === w.epoch ? Math.min(4, Math.max(0, beatPos - w.lastBeat)) : 0;
    w.lastBeat = beatPos;
    w.lastEpoch = w.epoch;
    w.phase = (w.phase + motionAdvance(dBeats, w.expression.motion)) % 1;
    const bpm = beatGrid ? localBpm(beatGrid, t) : Math.max(20, s.bpm || 120);
    if (t - w.lastSweep >= 1000 || t < w.lastSweep) {
      w.stepper.sweep(t);
      w.lastSweep = t;
    }
    w.outputGuard.setInterval(intervalMs);
    // A fade asked for since the last frame starts from what that frame showed.
    if (f.fade !== w.fadeOf) {
      w.fadeOf = f.fade;
      w.fade = f.fade ? { start: f.fade.start, ms: f.fade.ms, from: [...w.shown] } : null;
    }

    const colors = coloursOf(s, presets);
    const spec = e.specs.get(s.pattern) ?? null;
    const { voices, admitted } = playingVoices(w, t, beatPos, f);
    const n = rig.units.length;
    const units: UnitLight[] = new Array<UnitLight>(n);
    const baseKind: (string | null)[] = new Array<string | null>(n).fill(null);
    const baseOwner: (string | undefined)[] = new Array(n);
    let fb: FrameBase | null = null;
    let voiceCells: Cells | null = null;
    if (spec || voices.length || sequence) {
      voiceCells = cellsOf(e, 'voices', () => voiceLayout(rig));
      const ids = voiceCells.ids;
      // Disco's automatic strobe stands down for any manual strobe playing.
      const manualStrobeActive = voices.some((v) => v.spec.kind === 'strobe' && (v.targets === null || v.targets.some((id) => ids.includes(id))));
      fb = {
        beatPos, bpm, nowMs: t, dtMs: dt, anchorBeat: 0, lookPalette: s.basePalette?.gradients?.length ? colors : paletteOf({ colors }), paletteOverride,
        lookGradient: s.basePalette, overrideGradient: options.overridePalette,
        audio: options.audioSource?.frameAt(t) ?? null, audioMode: options.audioSource ? 'reactive' : 'tempo',
        modulation: {
          ...options.audioSource?.modulationAt?.(t),
          ...(s.pixelSpan ? { sectionProgress: Math.max(0, Math.min(1, (s.pixelFrom ?? 0)
            + (beatPos - f.anchor / Math.max(1, s.beatDivision)) / s.pixelSpan)) } : {}),
        },
        pictureFeatures: options.audioSource?.pictureAt?.(t), master: { ...HD_MASTER_DEFAULTS }, seed: [0, 0, 0, 0], acknowledged, hueStrobe,
        manualStrobeActive, expressionLevel: w.expression.level,
        unitSpace: options.space && options.space.n === n ? options.space : null,
      };
    }

    if (spec && fb) {
      // The base effect over the look's split cells, launched as the
      // renderer launches it, the split look's wash holding colour B.
      const split = s.split ?? null;
      const pixelMap = s.pixelMap ?? 'stage';
      const cells = cellsOf(e, `${split}|${pixelMap}`, () => rig.layout(split, pixelMap));
      const division = Math.max(1, s.beatDivision || 1);
      const id = `base:${s.pattern}:${f.anchor}`;
      // Keyed as the renderer keys it: a new id (pattern or anchor step), content, layout or seek
      // launches it again; a scene sending the same pattern on the same step does not.
      const key = canonical([id, effectContentKey(spec), cells.key, w.epoch]);
      if (!w.base || w.base.key !== key) {
        relaunchEffect(w.stepper, w.base, id, spec.kind);
        w.base = { key, id, kind: spec.kind, seed: seedFrom(id), startedAtMs: t };
      }
      const instance: EffectInstance = { id, spec, seed: w.base.seed, anchorBeat: f.anchor / division, startedAtMs: w.base.startedAtMs, targets: null };
      const modulation = s.pixelSpan ? { ...fb.modulation, spanProgress: fb.modulation?.sectionProgress } : fb.modulation;
      renderEffectLayer(rig, cells.layout, { ...fb, modulation, fixtureIds: cells.ids, hardware: cells.hardware }, instance, w.stepper, (u, colour, dim, strobe, kind, owner, background) => {
        const resolved = composeBackground(colour, dim / 255, background, s.background);
        units[u] = unitLight(resolved.colour, resolved.level * 255, strobe);
        baseKind[u] = kind;
        baseOwner[u] = owner;
      });
      for (const i of cells.layout.wash) {
        const { start, count } = rig.ranges[i];
        for (let u = start; u < start + count; u++) {
          const colour = colourSlots(paletteOverride ?? colors)[1];
          const resolved = composeBackground(colour, 1, ambient(colour, 1), s.background);
          units[u] = unitLight(resolved.colour, resolved.level * 255); baseKind[u] = null;
        }
      }
    } else {
      const layer = drawPattern(f, t, rig, colors, w.expression, w.phase, bpm, e.hardware, w.hardwareClock);
      for (let u = 0; u < n; u++) units[u] = unitLight(layer[u].color, layer[u].dim, layer[u].strobe);
    }

    // The sequence's clip on top of each light it covers, over the look, as renderer.ts renderSequence.
    let clips: (UnitLight | null)[] | null = null;
    const clipKind: (string | null)[] = new Array<string | null>(n).fill(null);
    const clipOwner: (string | undefined)[] = new Array(n);
    if (sequence && fb && voiceCells) {
      const lights = new Array<UnitLight | null>(n).fill(null);
      const covered = renderSequenceLayer(rig, voiceCells.layout, { ...fb, fixtureIds: voiceCells.ids, hardware: voiceCells.hardware }, sequence.table, sequence.transport, w.seq, w.stepper,
        (u, colour, dim, strobe, kind, owner, background) => {
          const resolved = composeBackground(colour, dim / 255, background, s.background);
          lights[u] = unitLight(resolved.colour, resolved.level * 255, strobe); clipKind[u] = kind; clipOwner[u] = owner;
        });
      if (covered) clips = lights;
    }

    // The voice on top of each light, or null where the base shows.
    let voiceTop: (EffectSlot | null)[] | null = null;
    if (voices.length && fb && voiceCells) {
      const winners = renderVoices(rig, voiceCells.layout, { ...fb, fixtureIds: voiceCells.ids, hardware: voiceCells.hardware }, voices, w.stepper, { admit: admitted });
      voiceTop = new Array<EffectSlot | null>(n).fill(null);
      const { list } = voiceCells.layout.units;
      for (let k = 0; k < list.length; k++) voiceTop[list[k]] = winners[k];
    }

    let fadeT = 1;
    if (w.fade) {
      fadeT = (t - w.fade.start) / w.fade.ms;
      if (fadeT >= 1) w.fade = null;
    }
    const shown: UnitLight[] = new Array<UnitLight>(n);
    const cols: Colour[] = new Array<Colour>(n);
    const dims: number[] = new Array<number>(n);
    const flashes: number[] = new Array(n);
    const tops: (string | null)[] = new Array<string | null>(n);
    for (let u = 0; u < n; u++) {
      // The base as it goes out, partway through any fade: what the next fade starts from.
      const layer = w.fade && w.fade.from[u] ? blendFixture(w.fade.from[u], units[u], fadeT) : units[u];
      shown[u] = layer;
      // A clip stands in for the look on its fixture; a fade of the look goes on under it.
      const clip = clips ? clips[u] : null;
      const below = clip ?? layer;
      const voice = voiceTop ? voiceTop[u] : null;
      if (voice) {
        // A voice stands where the energy burst always stood, at its own level.
        const resolved = composeBackground(voice.colour, voice.level, voice.background, s.background);
        cols[u] = resolved.colour;
        dims[u] = 255 * resolved.level;
      } else {
        cols[u] = below;
        // Glow rides the level on its own curve (renderer.ts lightOf): not multiplied again.
        const rides = ridesLevel(clip ? clipKind[u] : baseKind[u]);
        dims[u] = target?.level === 0 ? 0 : below.dim * (rides ? 1 : w.expression.level);
      }
      flashes[u] = voice ? voice.strobe ?? 0 : clip ? clip.strobe : s.pattern === 'strobe' ? Number(s.strobeSpeed) || 0 : below.strobe;
      tops[u] = voice ? voice.kind ?? null : clip ? clipKind[u] : baseKind[u];
    }
    w.shown = shown;
    const programs = new Array<boolean>(n).fill(false);
    for (let u = 0; u < n; u++) {
      const fixture = rig.units[u].fixture;
      const fn = String(s.strobeFunction ?? 'standard');
      if (voiceTop?.[u] || clips?.[u] || !drawnByTheShow(fn) || !(flashes[u] > 0)) continue;
      programs[u] = true;
      const caps = e.hardware?.[fixture] ?? hardwareOf(fixtures[fixture], options.profiles?.[fixtures[fixture]?.profileId ?? ''], options.hardware);
      const maxHz = Math.min(caps.maxFlashHz, s.flashLimit ? 3 : Infinity);
      dims[u] *= strobeLevel(fn, flashes[u], beatPos, bpm, u, maxHz > 0 ? 1000 / maxHz : Infinity);
    }
    if (e.hardware) for (let u = 0; u < n; u++) {
      const { fixture: i, cell } = rig.units[u];
      const voice = voiceTop?.[u], clip = clips?.[u];
      const owner = voice?.owner ?? (clip ? clipOwner[u] ?? 'sequence:black' : spec ? baseOwner[u] ?? 'base:excluded' : `legacy:${s.pattern}`);
      const cut = tops[u] === 'energy.kill' || !voice && (target?.level === 0 || !!clip && sequence?.transport.stop?.mode === 'black');
      const guardedLight = w.outputGuard.light(`${fixtures[i]?.id ?? i}:${cell}`, cols[u], dims[u], t, e.hardware[i], owner, cut);
      cols[u] = guardedLight.colour; dims[u] = guardedLight.dim;
      if (e.hardware[i].technology !== 'hue' && !programs[u]) {
        const planned = hardwareStrobe(flashes[u], e.hardware[i], t, s.flashLimit ? 3 : undefined);
        if (w.outputGuard.nativeLevel(String(fixtures[i]?.id ?? i), planned.previewLevel, t,
          { ...e.hardware[i], maxFlashHz: Math.min(e.hardware[i].maxFlashHz, s.flashLimit ? 3 : Infinity), minTransitionMs: 0 }, planned.cycle) === 0) dims[u] = 0;
      }
    }
    for (let u = 0; u < n; u++) {
      const trim = (fixtures[rig.units[u].fixture]?.maxBrightness ?? 255) / 255;
      dims[u] = w.outputGuard.effectLevel(u, dims[u], trim, tops[u], t);
    }

    if (s.flashLimit) {
      const all = rig.ranges.map(({ start, count }) => Array.from({ length: count }, (_, c) => ({ col: cols[start + c], dim: dims[start + c] })));
      const measure = (gain = 1) => all.reduce((sum, lights, i) => sum + fixtureLuminance(lights,
        options.profiles?.[fixtures[i]?.profileId ?? ''] ?? { channelMap: { red: 0, green: 1, blue: 2 } },
        rig.cellMaps[i], (fixtures[i]?.maxBrightness ?? 255) / 255, gain), 0) / Math.max(1, all.length);
      limitRoomFlashes(w.outputGuard, measure, (gain) => {
        for (let i = 0; i < all.length; i++) for (let c = 0; c < all[i].length; c++) {
          const dim = Math.min(255, all[i][c].dim * gain);
          all[i][c].dim = dim; dims[rig.ranges[i].start + c] = dim;
        }
      }, t);
    } else w.outputGuard.resetRoom();

    if (e.hardware) for (let u = 0; u < n; u++) {
      const { fixture: i, cell } = rig.units[u], fixture = fixtures[i], caps = e.hardware[i];
      const profile = options.profiles?.[fixture?.profileId ?? ''];
      if (caps.technology !== 'hue' || !profile) continue;
      const voice = voiceTop?.[u], clip = clips?.[u];
      const owner = voice?.owner ?? (clip ? clipOwner[u] ?? 'sequence:black' : spec ? baseOwner[u] ?? 'base:excluded' : `legacy:${s.pattern}`);
      const cut = tops[u] === 'energy.kill' || !voice && (target?.level === 0 || !!clip && sequence?.transport.stop?.mode === 'black');
      const map = rig.cellMaps[i]?.[cell] ?? profile.channelMap;
      if (!programs[u]) {
        const planned = hardwareStrobe(flashes[u], caps, t, s.flashLimit ? 3 : undefined);
        if (w.outputGuard.nativeLevel(String(fixture.id), planned.previewLevel, t,
          { ...caps, maxFlashHz: Math.min(caps.maxFlashHz, s.flashLimit ? 3 : Infinity), minTransitionMs: 0 }, planned.cycle) === 0) dims[u] = 0;
      }
      const guardedLight = w.outputGuard.measuredLight(`${fixture?.id ?? i}:${cell}`, cols[u], dims[u], t, caps, owner, cut,
        hueLightMeasure(profile, map), (fixture.maxBrightness ?? 255) / 255);
      cols[u] = guardedLight.colour; dims[u] = guardedLight.dim;
    }
    if (!lights) return null;
    const out = new Array<Colour>(n);
    for (let u = 0; u < n; u++) {
      const { fixture: i, cell } = rig.units[u];
      const scale = (dims[u] / 255) * ((fixtures[i]?.maxBrightness ?? 255) / 255);
      const profile = options.profiles?.[fixtures[i]?.profileId ?? ''];
      out[u] = previewOutput(cols[u], scale, rig.cellMaps[i]?.[cell] ?? profile?.channelMap, profile);
    }
    return out;
  }

  /** Where the checkpoint of frame `k` is, or would go: the first index past every one at or before it. */
  function checkpointIndex(k: number): number {
    let lo = 0, hi = checkpoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (checkpoints[mid].walk.k <= k) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function checkpointBefore(k: number, lights: boolean): Checkpoint {
    let i = checkpointIndex(k) - 1;
    const c = checkpoints[i];
    if (c.walk.k === k && lights && !c.walk.output) i--;
    return checkpoints[i];
  }

  /** Keep a copy of the walk as it stands, unless one of its frame is kept already (which counts as used). */
  function keep(w: Walk, periodic: boolean): void {
    const at = checkpointIndex(w.k);
    const kept = checkpoints[at - 1];
    if (kept?.walk.k === w.k) { kept.used = ++uses; return; }
    checkpoints.splice(at, 0, { walk: copyWalk(w), periodic, used: ++uses });
    if (!periodic || ++periodicCount <= CHECKPOINTS) return;
    // Too many kept every second: the one used longest ago goes.
    let oldest = -1;
    for (let i = 0; i < checkpoints.length; i++) {
      if (checkpoints[i].periodic && (oldest < 0 || checkpoints[i].used < checkpoints[oldest].used)) oldest = i;
    }
    checkpoints.splice(oldest, 1);
    periodicCount--;
  }

  function walkTo(k: number, e: Env, lights: boolean): Walk {
    if (!checkpoints.length) checkpoints.push({ walk: emptyWalk(firstFrame - 1, intervalMs), periodic: false, used: 0 });
    if (walk && walk.k === k && (walk.output || !lights)) return walk;
    // A copy is the state after its frame: to see a frame it has no lights for, start before it.
    const from = checkpointBefore(k, lights);
    // Back in time, or a copy far enough ahead of the walk: start from the copy.
    if (!walk || walk.k > k || (walk.k === k && lights) || from.walk.k > walk.k + COPY_FRAMES) {
      walk = copyWalk(from.walk);
      from.used = ++uses;
    }
    while (walk.k < k) {
      const next = walk.k + 1;
      const t = gridTime(next);
      // Before a frame that launches the base again, keep a copy to come back to.
      for (let i = walk.cursor; i < timeline.length && timeline[i].timeMs <= t + SLACK_MS; i++) {
        if (keyframe[i]) { keep(walk, false); break; }
      }
      advance(walk, t);
      // A second's frame is kept with its lights, so that frame can be shown from it.
      const periodic = next % CHECKPOINT_FRAMES === 0 && k - next < CHECKPOINTS * CHECKPOINT_FRAMES;
      walk.output = render(walk, t, e, next === k || periodic);
      walk.k = next;
      if (periodic) keep(walk, true);
    }
    return walk;
  }

  /** The stepped timeline at `positionMs`. */
  function sampleStepped(positionMs: number, e: Env): Colour[] {
    const k = frameAt(positionMs);
    // A frame of the grid, from the first on; anything else renders on a copy.
    if (k >= firstFrame && Math.abs(positionMs - gridTime(k)) <= SLACK_MS) return copyOut(walkTo(k, e, true).output!);
    if (tail && tail.positionMs === positionMs) return copyOut(tail.output);
    // Between two frames: the frame before, then this moment on a copy that is thrown away.
    const copy = copyWalk(walkTo(Math.max(k, firstFrame - 1), e, false));
    advance(copy, positionMs);
    const output = render(copy, positionMs, e, true)!;
    tail = { positionMs, output };
    return copyOut(output);
  }

  return (positionMs, fixtures, presets, rig = buildRig(fixtures, () => null)) => {
    // Nothing due yet (or no colours to show): nothing plays.
    if (!presets?.length || !timeline.length || !(timeline[0].timeMs <= positionMs + SLACK_MS)) return dark(rig);
    const e = environment(fixtures, presets, rig);
    if (!e.stepped) return sampleLegacy(positionMs, e);
    return sampleStepped(positionMs, e);
  };
}

// What a clip whose effect does not validate plays: no kind, so where it wins it is black, as an unknown kind is on the rig.
const NO_EFFECT: EffectSpec = Object.freeze({ kind: '', params: {} });

function sequenceOf(given: PreviewOptions['sequence']): { table: SequenceTable; transport: SequenceTransport } | null {
  const table = given?.table;
  const transport = given?.transport;
  if (!table || !Array.isArray(table.lanes) || !Array.isArray(table.clips) || !transport || !Number.isFinite(transport.startBeat)) return null;
  const clips = table.clips.map((c) => (c && typeof c === 'object' ? { ...c, spec: checkedSpec(c.spec).spec ?? NO_EFFECT } : c));
  return { table: { ...table, clips }, transport: transportOf(transport) };
}

/** Every light dark, before the timeline begins. */
const dark = (rig: Rig): Colour[] => rig.units.map(() => ({ r: 0, g: 0, b: 0 }));

/** The caller's own copy of a frame's lights. */
const copyOut = (lights: readonly Colour[]): Colour[] => lights.map((c) => ({ ...c }));


export {
  createPreviewSampler,
};
