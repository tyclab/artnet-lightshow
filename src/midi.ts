// X-Touch Compact Standard mode, Layer A: EN 1–8 turn CC 10–17; push notes 0–7;
// BT 1–8 notes 16–23; BT 9–16 notes 24–31; FD 1–9 CC 1–9; all channel 1.
// LED Note On velocities: 0 off, 1 on, 127 bright; follow the learned binding map.

import { DEFAULT_MAP, ACTIONS, defaultTypeFor } from './server/midi-map.ts';
import { createRequire } from 'node:module';

import { COLOR_PRESETS, ENERGY_EFFECT_IDS, STROBE_FUNCTION_IDS, SYNC_OFFSET_LIMIT_MS } from './server/presets.ts';
import { messageOf } from './errors.ts';
import type { MidiBinding, MidiMap } from './server/midi-map.ts';
import type { ShowState } from './server/state.ts';
import type { Override } from './types/rig.ts';

interface NoteMessage { note: number; velocity: number; channel: number }
interface CcMessage { controller: number; value: number; channel: number }
interface PitchMessage { value: number; channel: number }

interface MidiInput {
  on(event: 'noteon' | 'noteoff', fn: (message: NoteMessage) => void): void;
  on(event: 'cc', fn: (message: CcMessage) => void): void;
  on(event: 'pitch', fn: (message: PitchMessage) => void): void;
  close(): void;
}

interface MidiOutput {
  send(type: 'cc', message: CcMessage): void;
  send(type: 'noteon', message: NoteMessage): void;
  send(type: 'clock' | 'start' | 'stop'): void;
  close(): void;
}

interface EasyMidi {
  getInputs(): string[];
  getOutputs(): string[];
  Input: new (name: string) => MidiInput;
  Output: new (name: string) => MidiOutput;
}

export interface MidiPortList {
  inputs: string[];
  outputs: string[];
}

export interface LearnCapture {
  kind: 'cc' | 'notes';
  number: number;
  channel: number;
  binding: MidiBinding;
  /** For an encoder: the kind it showed itself to be, as a binding type. */
  type?: 'relative' | 'absolute';
}

export type LearnEvent = { status: string; binding: MidiBinding } & Partial<LearnCapture>;

type RelMode = 'twos' | 'offset';

const require = createRequire(import.meta.url);

const SYNC_NUDGE_MS = 5;

let easymidi: EasyMidi | undefined;
try {
  easymidi = require('easymidi') as EasyMidi;
} catch (_) {
  console.warn('[MIDI] easymidi not available — run `npm install easymidi` to enable MIDI support.');
}

const ENERGY_IDS = ENERGY_EFFECT_IDS;
const PAD_RENEW_MS = 400;
export const MIDI_HOLD_MAX_MS = 5 * 60 * 1000;

interface MidiPads {
  press(bank: number, slot: number, owner: string, token: string): { mode?: string; spec?: { kind?: string } } | null | undefined;
  renew(bank: number, slot: number, owner: string, token: string): boolean;
  release(bank: number, slot: number, owner: string, token: string): unknown;
  strobeMaxMs?(): number;
}
interface HeldPad { bank: number; slot: number; owner: string; token: string; renew: ReturnType<typeof setInterval> | null }
const STROBE_FN_IDS = STROBE_FUNCTION_IDS;

const LEARN_TIMEOUT_MS = 30000;

const ECHO_SUPPRESS_MS = 400;

const TOUCH_PAIR_MS = 300;

const FADER_ACTIONS = new Set(ACTIONS.filter((a) => a.input === 'fader').map((a) => a.id));

// Relative encoders: two’s complement CW 1,2,… / CCW 127,126,…;
// binary offset CW 65,66,… / CCW 63,62,… (some devices send decrement 1).
// Infer encoding from the stream because MIDI carries no encoding flag.
const REL_TWOS: RelMode = 'twos';
const REL_OFFSET: RelMode = 'offset';

const REL_EVIDENCE_BAND = 7;

function relEvidence(value: number): RelMode | null {
  if (Math.abs(value - 64) <= REL_EVIDENCE_BAND) return REL_OFFSET;
  if (value <= REL_EVIDENCE_BAND || value >= 127 - REL_EVIDENCE_BAND) return REL_TWOS;
  return null;
}

function relDelta(value: number, mode: RelMode): number {
  if (value === 64) return 0;
  if (mode === REL_OFFSET) return value - 64;
  return value > 64 ? value - 128 : value;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const OWN_PORT = /^RtMidi (Input|Output) Client:/;
type EncoderMode = 'position' | 'steps';
const STEP_REACH = 15;
const fromLandmark = (value: number): number => Math.min(value, Math.abs(value - 64), 127 - value);
const ENCODER_ACTIONS = new Set(ACTIONS.filter((a) => a.input === 'encoder').map((a) => a.id));
const PROBE_HOLD_MS = 3000;
const LEARN_CONFIRM_MS = 2000;
const clearRing = (value: number): number => (value >= 64 ? 96 : 32);

export interface LookRow {
  id: string;
  pixel?: boolean;
  app?: string;
  party?: boolean;
  rapidFlash?: boolean;
}

export interface MidiBusk {
  looks(): readonly LookRow[];
  palettes(): readonly string[];
  acknowledged(): boolean;
  stopEffects(): unknown;
  strobeBurst(ms: number): unknown;
  strobeRate(): number;
  setStrobeRate(hz: number): unknown;
  strobeMaxRate: number;
  autoShowOn(): boolean;
  toggleAutoShow(): unknown;
}

const DIVISIONS = [1, 2, 4, 8, 16];

const FADE_STEP_MS = 250;

const FADE_MAX_MS = 4000;

const COLOR_SLOTS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;

type ColorSlot = typeof COLOR_SLOTS[number];

const slotOf = (value: unknown): ColorSlot | null => COLOR_SLOTS.find((slot) => slot === value) ?? null;

const LIT_COLORS = COLOR_PRESETS.map((c, i) => ({ c: c as Record<string, unknown>, i }))
  .filter(({ c }) => ['r', 'g', 'b', 'w', 'a', 'uv'].some((k) => Number(c[k]) > 0)).map(({ i }) => i);

const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

class MidiController {
  declare _positions: Map<string, number>;

  declare _encModes: Map<string, EncoderMode>;

  declare _probes: Map<string, number>;

  _encoderSteps(key: string, controller: number, channel: number, binding: MidiBinding, value: number): number {
    const at = this._positions.get(key);
    this._probes.delete(key);
    const evidence = this._encoderEvidence(at, value);
    if (evidence) this._encModes.set(key, evidence);
    this._positions.set(key, value);

    const steps = (): number => {
      const encoding = relEvidence(value);
      if (encoding) this._relModes.set(key, encoding);
      return relDelta(value, this._relModes.get(key) || REL_TWOS);
    };
    const mode = this._encModes.get(key);
    if (mode === 'position') return at === undefined ? 0 : value - at;
    if (mode === 'steps') return steps();

    // Not shown yet, so the value is next to a landmark: the binding's type is
    // the guess. With nothing to measure from, a position only says where it is.
    if (binding.type !== 'relative') return at === undefined ? 0 : value - at;
    if (at !== undefined) this._probe(key, controller, channel, value);
    return steps();
  }

  _encoderEvidence(at: number | undefined, value: number): EncoderMode | null {
    if (fromLandmark(value) > STEP_REACH) return 'position';
    if (at === undefined) return null;
    if (Math.abs(value - at) > STEP_REACH) return 'steps';
    if (value === at && value !== 0 && value !== 127) return 'steps';
    return null;
  }

  _encoderMode(key: string, binding: MidiBinding): EncoderMode {
    return this._encModes.get(key) ?? (binding.type === 'relative' ? 'steps' : 'position');
  }

  _probe(key: string, controller: number, channel: number, value: number): void {
    if (!this.output || !this.controlFeedback) return;
    const ring = clearRing(value);
    try {
      this.output.send('cc', { controller, value: ring, channel });
    } catch (_) { return; }
    this._lastCcOut.set(controller, ring);
    this._positions.set(key, ring);
    this._probes.set(key, Date.now());
  }

  _learnEncoder(learn: NonNullable<MidiController['_learn']>, number: number, channel: number, value: number): boolean {
    const key = `${channel}:${number}`;
    if (learn.encoder && learn.encoder.key !== key) return false;

    // Where the encoder was before is not to be trusted: it was not ours to follow.
    const first = !learn.encoder;
    const evidence = this._encoderEvidence(first ? undefined : this._positions.get(key), value);
    this._positions.set(key, value);
    if (first) {
      learn.encoder = { key, number, channel };
      clearTimeout(learn.timer);
      learn.timer = setTimeout(() => this._finishLearnEncoder(learn, null), LEARN_CONFIRM_MS);
      learn.timer.unref?.();
    }
    if (evidence) this._finishLearnEncoder(learn, evidence);
    else if (first) this._probe(key, number, channel, value);
    return true;
  }

  _finishLearnEncoder(learn: NonNullable<MidiController['_learn']>, mode: EncoderMode | null): void {
    const encoder = learn.encoder;
    if (!encoder) return;
    if (mode) this._encModes.set(encoder.key, mode);
    const type = mode === 'position' ? 'absolute'
      : mode === 'steps' ? 'relative'
        : learn.binding.type || defaultTypeFor(learn.binding.action);
    this._finishLearn(learn, { kind: 'cc', number: encoder.number, channel: encoder.channel, binding: learn.binding, type });
  }

  _finishLearn(learn: NonNullable<MidiController['_learn']>, captured: LearnCapture): void {
    // Cancelled or superseded meanwhile: that already answered.
    if (this._learn !== learn) return;
    this._learn = null;
    clearTimeout(learn.timer);
    learn.resolve(captured);
    this._emitLearn({ status: 'captured', ...captured });
  }

  declare setPaletteOverride: ((id: string | null) => unknown) | null;
  declare busk: MidiBusk | null;
  declare _fadeMs: number;
  declare _random: () => number;

  declare state: ShowState;
  declare apply: (patch: Record<string, unknown>) => unknown;
  declare tap: () => void;
  declare input: MidiInput | null;
  declare output: MidiOutput | null;
  declare map: MidiMap;
  declare enabled: boolean;
  declare recallCue: ((id: string) => unknown) | null;
  declare _learn: {
    binding: MidiBinding;
    resolve: (capture: LearnCapture | null) => void;
    timer: ReturnType<typeof setTimeout>;
    // An encoder caught, waiting for the message that says which kind it is.
    encoder?: { key: string; number: number; channel: number };
  } | null;
  declare _learnListeners: ((event: LearnEvent) => void)[];
  declare _lastCcOut: Map<number, number>;
  declare _lastCcIn: Map<number, number>;
  declare _relModes: Map<string, RelMode>;
  declare controlFeedback: boolean;
  declare _cachedPorts: MidiPortList | null;
  declare _energyEffect: string | undefined;
  declare _moved: Set<string>;
  declare _touchDown: Map<string, number>;
  declare _touchOf: Map<string, string>;
  declare _warnedSwitch: Set<string>;
  declare onRebind: ((from: number, to: number, binding: MidiBinding) => void) | null;
  declare pads: MidiPads | null;
  declare _heldPads: Map<string, HeldPad>;
  declare _inputName: string | null;

  constructor(stateRef: ShowState, applyFn: (patch: Record<string, unknown>) => unknown, tapFn: () => void) {
    this.state = stateRef;
    this.apply = applyFn;    // fn(patch) — same as socket 'set' event
    this.tap   = tapFn;       // fn() — trigger tap tempo
    this.pads = null;
    this._heldPads = new Map();
    this._inputName = null;

    this.input  = null;
    this.output = null;
    this.map    = DEFAULT_MAP;
    this.enabled = false;

    this.recallCue = null;
    this.setPaletteOverride = null;
    this.busk = null;
    this._fadeMs = 0;
    this._random = Math.random;

    this._learn = null;       // { binding, resolve, timer } while learn is armed
    this._learnListeners = [];

    this._lastCcOut = new Map();
    this._lastCcIn = new Map();
    this._relModes = new Map();
    this._positions = new Map();
    this._encModes = new Map();
    this._probes = new Map();
    this.controlFeedback = true;
    this._moved = new Set();
    this._touchDown = new Map();
    this._touchOf = new Map();
    this._warnedSwitch = new Set();
    this.onRebind = null;
  }

  setMap(map: MidiMap | null | undefined): void {
    this.map = map || DEFAULT_MAP;
    this._lastCcOut.clear();
    this.sendFeedback();
  }

  setControlFeedback(enabled: unknown): void {
    this.controlFeedback = !!enabled;
    this._lastCcOut.clear();
    if (this.controlFeedback) this.sendFeedback();
  }

  listPorts(): MidiPortList {
    if (!easymidi) return { inputs: [], outputs: [] };
    // Cache the result — enumerate once, refresh only on explicit connect/close
    // or when the Settings picker asks (refreshPorts).
    if (this._cachedPorts) return this._cachedPorts;
    try {
      // On ALSA every open port brings an "RtMidi … Client" of ours into the
      // list, and it outlives close(). Picking one wires our feedback back in.
      const pickable = (name: string) => !OWN_PORT.test(name);
      this._cachedPorts = { inputs: easymidi.getInputs().filter(pickable), outputs: easymidi.getOutputs().filter(pickable) };
    } catch (_) {
      this._cachedPorts = { inputs: [], outputs: [] };
    }
    return this._cachedPorts;
  }

  refreshPorts(): MidiPortList {
    this._cachedPorts = null;
    return this.listPorts();
  }

  connect(inputName: string | null, outputName: string | null): boolean {
    if (!easymidi) {
      console.warn('[MIDI] easymidi not loaded — MIDI unavailable.');
      return false;
    }

    // Only the ports the operator picked. This used to fall back to the first
    // port matching /x.?touch/i, then to the first port of all, so any surface
    // on the bus could take the show over (the e2e server included).
    if (!inputName) {
      console.log('[MIDI] No input port picked. Pick one under Settings → MIDI controller.');
      return false;
    }

    const { inputs, outputs } = this.refreshPorts();
    if (!inputs.length && !outputs.length) {
      console.warn('[MIDI] No MIDI ports available.');
      return false;
    }

    console.log('[MIDI] Available inputs: ', inputs);
    console.log('[MIDI] Available outputs:', outputs);

    const inName  = inputs.includes(inputName) ? inputName : null;
    const outName = outputName && outputs.includes(outputName) ? outputName : null;

    if (!inName) {
      console.warn(`[MIDI] Input port "${inputName}" is not available. Plug it in, or pick another under Settings → MIDI controller.`);
      return false;
    }
    if (outputName && !outName) {
      console.warn(`[MIDI] Output port "${outputName}" is not available; connecting without feedback.`);
    }

    try {
      this.input = new easymidi.Input(inName);
      this._inputName = inName;
      console.log(`[MIDI] Input:  ${inName}`);

      if (outName) {
        this.output = new easymidi.Output(outName);
        console.log(`[MIDI] Output: ${outName}`);
      }

      this._bindInput();
      this.enabled = true;
      this._lastCcOut.clear();
      // Drive the surface to the current show immediately, rather than waiting
      // for the first thing to change.
      this.sendFeedback();
      return true;
    } catch (err) {
      console.error('[MIDI] Failed to open MIDI port:', messageOf(err));
      return false;
    }
  }

  _bindingFor(kind: 'cc' | 'notes', number: number, channel: number): MidiBinding | null {
    const binding = this.map[kind] && this.map[kind][number];
    if (!binding) return null;
    if (binding.channel !== undefined && binding.channel !== channel) return null;
    return binding;
  }

  _bindInput(): void {
    const input = this.input;
    if (!input) return;
    // this.map is read at dispatch time rather than captured here, so a
    // relearned binding takes effect immediately instead of on the next
    // reconnect.

    // MIDI monitor: one line per incoming message. Invaluable when mapping a
    // controller, unusable during a show — a single encoder sweep is hundreds
    // of lines. Off unless DEBUG_MIDI=1.
    if (process.env.DEBUG_MIDI === '1') {
      input.on('noteon',  ({ note, velocity, channel }) =>
        console.log(`[MIDI] noteon  ch=${channel + 1} note=${note} vel=${velocity}  → ${this.map.notes[note] ? this.map.notes[note].action : 'unmapped'}`));
      input.on('noteoff', ({ note, channel }) =>
        console.log(`[MIDI] noteoff ch=${channel + 1} note=${note}`));
      input.on('cc',      ({ controller, value, channel }) =>
        console.log(`[MIDI] cc      ch=${channel + 1} cc=${controller} val=${value}  → ${this.map.cc[controller] ? this.map.cc[controller].action : 'unmapped'}`));
      input.on('pitch',   ({ value, channel }) =>
        console.log(`[MIDI] pitch   ch=${channel + 1} val=${value}`));
    }

    // Note On → button press
    input.on('noteon', ({ note, velocity, channel }) => {
      // A learn in progress swallows the message: the operator is telling us
      // which control they mean, not asking for it to fire.
      if (velocity > 0 && this._captureLearn('notes', note, channel)) return;

      if (velocity === 0 && this._releasePad(channel, note)) return;
      const binding = this._bindingFor('notes', note, channel);
      if (!binding) return;
      if (binding.action === 'padPress') {
        if (velocity > 0) this._safely(binding, () => this._pressPad(channel, note, binding));
        return;
      }
      if (velocity === 0) {
        // Note-off: release momentary actions
        if (binding.action === 'energyHold') this.apply({ energyOverride: null });
        return;
      }
      this._safely(binding, () => this._dispatch(binding));
    });

    // Explicit Note Off for controllers that send it separately
    input.on('noteoff', ({ note, channel }) => {
      if (this._releasePad(channel, note)) return;
      const binding = this._bindingFor('notes', note, channel);
      if (binding && binding.action === 'energyHold') {
        this.apply({ energyOverride: null });
        this.sendFeedback();
      }
    });

    // CC → encoder (relative) or fader (absolute)
    input.on('cc', ({ controller, value, channel }) => {
      const key = `${channel}:${controller}`;
      const between = value > 0 && value < 127;
      this._trackTouch(key, controller, channel, value, between);

      // Learning a fader: its touch sensor speaks first, and is not the fader.
      if (this._learn && !between && !this._moved.has(key) && this._learnWantsFader()) return;
      if (this._captureLearn('cc', controller, channel, value)) return;

      // Note the touch even when unmapped: a fader being moved is a fader we
      // should not be driving, whatever it is bound to.
      this._lastCcIn.set(controller, Date.now());

      const binding = this._bindingFor('cc', controller, channel);
      if (!binding) return;
      // Only a control that has shown itself to be a fader drives a fader
      // action: a touch sensor would throw it to the ends.
      if (binding.type !== 'relative' && FADER_ACTIONS.has(binding.action) && !this._moved.has(key)) {
        this._warnSwitch(key, controller, binding);
        return;
      }
      if (ENCODER_ACTIONS.has(binding.action)) {
        const delta = this._encoderSteps(key, controller, channel, binding, value) * (binding.scale || 1);
        // A no-movement message is not an edit: dispatching zero would still
        // clear the palette label and suppress the control's own feedback.
        if (delta !== 0) {
          this._safely(binding, () => this._dispatchContinuous(binding, delta));
        }
      } else if (binding.type !== 'relative') {
        this._safely(binding, () => this._dispatchAbsolute(binding, value));
      }
    });
  }

  _learnWantsFader(): boolean {
    const binding = this._learn && this._learn.binding;
    return !!binding && binding.type !== 'relative' && FADER_ACTIONS.has(binding.action);
  }

  _trackTouch(key: string, controller: number, channel: number, value: number, between: boolean): void {
    const now = Date.now();
    const bound = this._bindingFor('cc', controller, channel);
    if (bound && (bound.type === 'relative' || !FADER_ACTIONS.has(bound.action))) {
      if (between) this._moved.add(key);
      return;
    }
    if (between) {
      this._moved.add(key);
      for (const [touch, at] of this._touchDown) {
        if (touch === key || this._touchOf.has(touch) || now - at > TOUCH_PAIR_MS) continue;
        this._touchOf.set(touch, key);
        this._heal(touch, key);
      }
      return;
    }
    if (this._moved.has(key)) return;
    if (value === 127) {
      this._touchDown.set(key, now);
    } else {
      this._touchDown.delete(key);
      const fader = this._touchOf.get(key);
      if (fader) {
        this._lastCcOut.delete(Number(fader.split(':')[1]));
        this._sendControlFeedback();
      }
    }
  }

  _heal(touchKey: string, faderKey: string): void {
    const touchCc = Number(touchKey.split(':')[1]);
    const faderCc = Number(faderKey.split(':')[1]);
    const binding = this.map.cc && this.map.cc[touchCc];
    if (!binding || !FADER_ACTIONS.has(binding.action) || binding.type === 'relative') return;
    if (this.map.cc[faderCc]) return;
    console.warn(`[MIDI] CC ${touchCc} is the touch sensor of the fader on CC ${faderCc}: `
      + `its binding (${binding.action}) moves to CC ${faderCc}`);
    const cc: Record<string, MidiBinding> = { ...this.map.cc, [String(faderCc)]: binding };
    delete cc[String(touchCc)];
    this.map = { ...this.map, cc };
    if (this.onRebind) {
      try { this.onRebind(touchCc, faderCc, binding); } catch (err) { console.warn(`[MIDI] could not save the move: ${messageOf(err)}`); }
    }
  }

  _warnSwitch(key: string, controller: number, binding: MidiBinding): void {
    if (this._warnedSwitch.has(key)) return;
    this._warnedSwitch.add(key);
    console.warn(`[MIDI] CC ${controller} is bound to ${binding.action} but has only sent 0 and 127, like a fader's `
      + 'touch sensor or a button — ignored until it moves between the ends. Relearn the fader by moving it.');
  }

  _touched(faderCc: number): boolean {
    for (const [touch, fader] of this._touchOf) {
      if (Number(fader.split(':')[1]) === faderCc && this._touchDown.has(touch)) return true;
    }
    return false;
  }

  _safely(binding: MidiBinding, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.warn(`[MIDI] ${binding.action} failed: ${messageOf(err)}`);
    }
  }

  startLearn(binding: MidiBinding): Promise<LearnCapture | null> {
    this.cancelLearn('superseded');
    return new Promise<LearnCapture | null>((resolve) => {
      const timer = setTimeout(() => this.cancelLearn('timeout'), LEARN_TIMEOUT_MS);
      timer.unref();
      this._learn = { binding, resolve, timer };
      this._emitLearn({ status: 'armed', binding });
    });
  }

  cancelLearn(reason = 'cancelled'): boolean {
    const learn = this._learn;
    if (!learn) return false;
    this._learn = null;
    clearTimeout(learn.timer);
    learn.resolve(null);
    this._emitLearn({ status: reason, binding: learn.binding });
    return true;
  }

  get learning(): boolean { return !!this._learn; }

  _captureLearn(kind: 'cc' | 'notes', number: number, channel: number, value = 0): boolean {
    const learn = this._learn;
    if (!learn) return false;
    if (kind === 'cc' && ENCODER_ACTIONS.has(learn.binding.action)) return this._learnEncoder(learn, number, channel, value);
    // An encoder already caught: the rest of the surface works meanwhile.
    if (learn.encoder) return false;
    this._finishLearn(learn, { kind, number, channel, binding: learn.binding });
    return true;
  }

  onLearn(fn: (event: LearnEvent) => void): void { this._learnListeners.push(fn); }

  _emitLearn(event: LearnEvent): void {
    for (const fn of this._learnListeners) {
      try { fn(event); } catch (err) { console.warn(`[MIDI] learn listener: ${messageOf(err)}`); }
    }
  }

  _dispatch(binding: MidiBinding): void {
    const s = this.state;
    switch (binding.action) {
      case 'tap':
        this.tap();
        break;
      case 'toggleBlackout':
        this.apply({ masterBlackout: !s.masterBlackout });
        break;
      case 'toggleTempoMode':
        this.apply({ tempoMode: s.tempoMode === 'manual' ? 'auto' : 'manual' });
        break;
      case 'togglePlay':
        this.apply({ running: !s.running });
        break;
      case 'setPattern':
        this.apply({ pattern: binding.value });
        break;
      case 'setColorA':
        this.apply({ colorA: binding.value });
        break;
      case 'setColorB':
        this.apply({ colorB: binding.value });
        break;
      case 'setColorC':
        this.apply({ colorC: binding.value });
        break;
      case 'setColorD':
        this.apply({ colorD: binding.value });
        break;
      case 'setBeatDivision':
        this.apply({ beatDivision: Number(binding.value) || 1 });
        break;
      case 'energyHold': {
        // Momentary: note-on activates, note-off (handled above) deactivates.
        // A bound effect wins; otherwise this button follows cycleEnergyEffect.
        const effect = binding.value || this._energyEffect || ENERGY_IDS[0];
        this.apply({ energyOverride: effect });
        break;
      }
      case 'cycleEnergyEffect': {
        // Cycle which effect the energy hold button triggers (without activating it)
        const curIdx = ENERGY_IDS.indexOf(this._energyEffect || ENERGY_IDS[0]);
        this._energyEffect = ENERGY_IDS[(curIdx + 1) % ENERGY_IDS.length];
        break;
      }
      case 'cycleStrobeFunction': {
        const curIdx = STROBE_FN_IDS.indexOf(s.strobeFunction || 'standard');
        this.apply({ strobeFunction: STROBE_FN_IDS[(curIdx + 1) % STROBE_FN_IDS.length] });
        break;
      }
      case 'toggleFixBlackout': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        const cur = fix && fix.override;
        const newBo = !(cur && cur.blackout);
        if (!newBo && cur && cur.blackout && !cur.enabled) {
          this._emitFixOverride(fix.id, null);
          break;
        }
        // Blackout is a gate, not a replacement look. Clearing it restores the
        // prior override; if there was none, return to the pattern engine.
        this._emitFixOverride(fix.id, {
          ...(cur || { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }),
          blackout: newBo,
        });
        break;
      }
      case 'recallCue':
        // Wired up by server.js; a rig with no cue store just does nothing.
        if (this.recallCue && binding.value) this.recallCue(String(binding.value));
        break;
      case 'setPalette':
        // One press writes all four colour slots from a named look. The server
        // rejects an id it does not know, which surfaces as a toast rather than
        // a button that silently does nothing.
        if (binding.value) this.apply({ palette: String(binding.value) });
        break;
      case 'togglePaletteOverride': {
        // Over whatever is playing until pressed again. The auto show never
        // sets the override, so this colours the show rather than fighting it.
        if (!binding.value || !this.setPaletteOverride) break;
        const id = String(binding.value);
        this.setPaletteOverride(s.paletteOverrideId === id ? null : id);
        break;
      }
      case 'clearPaletteOverride':
        this.setPaletteOverride?.(null);
        break;
      case 'randomLook': {
        const others = this._lookList(binding.value === 'effect' ? 'effect' : 'pattern').filter((id) => id !== s.pattern);
        if (others.length) this._look(this._pick(others));
        break;
      }
      case 'randomColor': {
        const slot = slotOf(binding.value);
        const others = LIT_COLORS.filter((i) => !slot || i !== s[slot]);
        if (slot && others.length) this.apply({ [slot]: this._pick(others), ...this._fade() });
        break;
      }
      case 'scaleBpm': {
        const factor = Number(binding.value);
        if (factor > 0) this.apply({ bpm: clamp(Math.round(s.bpm * factor * 100) / 100, 20, 300) });
        break;
      }
      case 'stopEffects':
        this.busk?.stopEffects();
        break;
      case 'strobeBurst':
        this.busk?.strobeBurst(Number(binding.value) || 1000);
        break;
      case 'toggleAutoShow':
        this.busk?.toggleAutoShow();
        break;
    }
    this.sendFeedback();
  }

  _lookList(kind: 'pattern' | 'effect'): string[] {
    const rows = this.busk?.looks() ?? [];
    const acknowledged = !!this.busk?.acknowledged();
    const eligible = rows.filter((r) => acknowledged || !r.rapidFlash);
    if (kind === 'pattern') return eligible.filter((r) => !r.pixel && (!r.app || (r.app === 'own' && r.party))).map((r) => r.id);
    return eligible.filter((r) => r.app === 'hd' || r.app === 'ldj').map((r) => r.id);
  }

  _barsList(): (string | null)[] {
    return [null, ...(this.busk?.looks() ?? []).filter((r) => r.pixel && (this.busk?.acknowledged() || !r.rapidFlash)).map((r) => r.id)];
  }

  _look(id: string): void {
    this.apply({ pattern: id, ...this._fade() });
  }

  _fade(): { fadeMs?: number } {
    return this._fadeMs > 0 ? { fadeMs: this._fadeMs } : {};
  }

  _pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this._random() * list.length))];
  }

  _dispatchContinuous(binding: MidiBinding, delta: number): void {
    const s = this.state;
    switch (binding.action) {
      case 'adjustBpm':
        this.apply({ bpm: clamp(s.bpm + delta, 20, 300) });
        break;
      case 'adjustMasterDimmer':
        this.apply({ masterDimmer: clamp(s.masterDimmer + delta, 0, 255) });
        break;
      case 'adjustStrobeSpeed':
        this.apply({ strobeSpeed: clamp(s.strobeSpeed + delta, 0, 255) });
        break;
      case 'adjustFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        const cur = (fix.override && fix.override.enabled) ? fix.override.dim ?? 255 : 255;
        this._emitFixOverride(fix.id, {
          ...(fix.override || {}), enabled: true, dim: clamp(cur + delta, 0, 255), blackout: false,
        });
        break;
      }
      case 'adjustFixtureMax': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        const cur = Number.isInteger(fix.maxBrightness) ? fix.maxBrightness as number : 255;
        this._emitFixMax(fix.id, clamp(cur + delta, 0, 255));
        break;
      }
      case 'adjustAutoIntensity':
        // 0-100, not 0-255: the auto show's slider is a percentage.
        this.apply({ autoIntensity: clamp(Math.round((s.autoIntensity ?? 50) + delta), 0, 100) });
        break;
      case 'browsePattern':
      case 'browseEffect': {
        const list = this._lookList(binding.action === 'browsePattern' ? 'pattern' : 'effect');
        if (!list.length) break;
        const at = list.indexOf(s.pattern);
        // Not in the list (the other kind is on): the first turn lands on its first or last.
        this._look(list[at < 0 ? (delta > 0 ? 0 : list.length - 1) : wrapIndex(at + delta, list.length)]);
        break;
      }
      case 'browseColor': {
        const slot = slotOf(binding.value);
        if (slot) this.apply({ [slot]: wrapIndex(s[slot] + delta, COLOR_PRESETS.length), ...this._fade() });
        break;
      }
      case 'browseBeatDivision': {
        const at = Math.max(0, DIVISIONS.indexOf(s.beatDivision));
        this.apply({ beatDivision: DIVISIONS[clamp(at + delta, 0, DIVISIONS.length - 1)] });
        break;
      }
      case 'browseBarsPattern': {
        const list = this._barsList();
        this.apply({ pixelPattern: list[wrapIndex(Math.max(0, list.indexOf(s.pixelPattern)) + delta, list.length)] });
        break;
      }
      case 'browsePalette': {
        const list = this.busk?.palettes() ?? [];
        if (!list.length || !this.setPaletteOverride) break;
        const at = s.paletteOverrideId ? list.indexOf(s.paletteOverrideId) : -1;
        this.setPaletteOverride(list[at < 0 ? (delta > 0 ? 0 : list.length - 1) : wrapIndex(at + delta, list.length)]);
        break;
      }
      case 'adjustFadeTime':
        this._fadeMs = clamp(this._fadeMs + delta * FADE_STEP_MS, 0, FADE_MAX_MS);
        break;
      case 'adjustStrobeRate': {
        const busk = this.busk;
        if (busk) busk.setStrobeRate(clamp(Math.round(busk.strobeRate() + delta), 1, busk.strobeMaxRate));
        break;
      }
      case 'adjustAutoSync':
        // 5 ms a detent. One encoder click of 1 ms would be unusable — you
        // cannot hear a millisecond — and a whole beat per click would overshoot
        // the error every time. Five is small enough to creep up on the right
        // answer and large enough to get there within a song.
        this.apply({
          autoSyncOffsetMs: clamp(
            Math.round((s.autoSyncOffsetMs ?? 0) + delta * SYNC_NUDGE_MS),
            -SYNC_OFFSET_LIMIT_MS, SYNC_OFFSET_LIMIT_MS,
          ),
        });
        break;
    }
  }

  _dispatchAbsolute(binding: MidiBinding, raw: number): void {
    const s = this.state;
    const level = Math.round((raw / 127) * 255);
    switch (binding.action) {
      case 'setMasterDimmer':
        this.apply({ masterDimmer: level });
        break;
      case 'setStrobeSpeed':
        this.apply({ strobeSpeed: level });
        break;
      case 'setBpm':
        this.apply({ bpm: Math.round(20 + (raw / 127) * 280) });
        break;
      case 'setFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        this._emitFixOverride(fix.id, {
          ...(fix.override || { r: 0, g: 0, b: 0, w: 0, strobe: 0 }),
          enabled: true, dim: level, blackout: false,
        });
        break;
      }
      case 'setFixtureMax':
        if (s.fixtures.some((fixture) => fixture.id === binding.fixture)) this._emitFixMax(binding.fixture as number, level);
        break;
      case 'setAutoIntensity':
        this.apply({ autoIntensity: Math.round((raw / 127) * 100) });
        break;
      case 'setAutoSync':
        this.apply({
          autoSyncOffsetMs: Math.round(((raw - 63.5) / 63.5) * SYNC_OFFSET_LIMIT_MS),
        });
        break;
    }
  }

  overrideFixture: ((id: number, override: Partial<Override> | null) => void) | null = null;

  setFixtureMax: ((id: number, value: number) => void) | null = null;

  _emitFixOverride(id: number, override: Partial<Override> | null): void {
    if (this.overrideFixture) this.overrideFixture(id, override);
  }

  _emitFixMax(id: number, value: number): void {
    if (this.setFixtureMax) this.setFixtureMax(id, value);
  }

  sendFeedback(): void {
    if (!this.output) return;
    const s = this.state;

    this._sendControlFeedback();

    for (const [note, binding] of Object.entries(this.map.notes || {})) {
      let lit: boolean | null;
      switch (binding.action) {
        case 'setPattern':       lit = binding.value === s.pattern; break;
        case 'setColorA':        lit = binding.value === s.colorA; break;
        case 'setColorB':        lit = binding.value === s.colorB; break;
        case 'setColorC':        lit = binding.value === s.colorC; break;
        case 'setColorD':        lit = binding.value === s.colorD; break;
        case 'setBeatDivision':  lit = Number(binding.value) === s.beatDivision; break;
        case 'setPalette':       lit = binding.value === s.palette; break;
        case 'togglePaletteOverride': lit = !!binding.value && s.paletteOverrideId === String(binding.value); break;
        // Lit while there is something for it to do.
        case 'clearPaletteOverride': lit = !!s.paletteOverride; break;
        case 'toggleAutoShow':   lit = !!this.busk?.autoShowOn(); break;
        case 'toggleBlackout':   lit = !!s.masterBlackout; break;
        // Lit while the clock follows the music, as Play is while it runs.
        case 'toggleTempoMode':  lit = s.tempoMode !== 'manual'; break;
        case 'togglePlay':       lit = !!s.running; break;
        case 'energyHold':       lit = !!s.energyOverride; break;
        case 'toggleFixBlackout': {
          const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
          lit = !!(fix && fix.override && fix.override.blackout);
          break;
        }
        default: lit = null;    // nothing meaningful to show
      }
      if (lit !== null) this._ledNote(Number(note), lit ? 127 : 0, binding.channel || 0);
    }
  }

  _feedbackValue(binding: MidiBinding): number | null {
    const s = this.state;
    const to127 = (value: number, max: number) => Math.max(0, Math.min(127, Math.round((value / max) * 127)));

    switch (binding.action) {
      case 'setMasterDimmer':
      case 'adjustMasterDimmer':
        return to127(s.masterDimmer, 255);
      case 'setStrobeSpeed':
      case 'adjustStrobeSpeed':
        return to127(s.strobeSpeed, 255);
      case 'setBpm':
      case 'adjustBpm':
        // The inverse of the fader mapping in _dispatchAbsolute: 20-300 BPM.
        return to127(s.bpm - 20, 280);
      case 'setFixtureDim':
      case 'adjustFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) return null;
        // No override means the pattern engine owns the fixture and it is at
        // full — which is where the fader should sit, ready to pull it down.
        const dim = (fix.override && fix.override.enabled) ? fix.override.dim ?? 255 : 255;
        return to127(dim, 255);
      }
      case 'setFixtureMax':
      case 'adjustFixtureMax': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) return null;
        return to127(Number.isInteger(fix.maxBrightness) ? fix.maxBrightness as number : 255, 255);
      }
      case 'setAutoIntensity':
      case 'adjustAutoIntensity':
        return to127(s.autoIntensity ?? 50, 100);
      case 'setAutoSync':
      case 'adjustAutoSync':
        // Bipolar, so centre the ring rather than parking it at the bottom.
        return to127((s.autoSyncOffsetMs ?? 0) + SYNC_OFFSET_LIMIT_MS, SYNC_OFFSET_LIMIT_MS * 2);
      case 'browsePattern':
      case 'browseEffect': {
        const list = this._lookList(binding.action === 'browsePattern' ? 'pattern' : 'effect');
        const at = list.indexOf(s.pattern);
        return at < 0 ? null : to127(at, Math.max(1, list.length - 1));
      }
      case 'browseColor': {
        const slot = slotOf(binding.value);
        return slot ? to127(s[slot], COLOR_PRESETS.length - 1) : null;
      }
      case 'browseBeatDivision':
        return to127(Math.max(0, DIVISIONS.indexOf(s.beatDivision)), DIVISIONS.length - 1);
      case 'browseBarsPattern': {
        const list = this._barsList();
        return to127(Math.max(0, list.indexOf(s.pixelPattern)), Math.max(1, list.length - 1));
      }
      case 'browsePalette': {
        const list = this.busk?.palettes() ?? [];
        const at = s.paletteOverrideId ? list.indexOf(s.paletteOverrideId) : -1;
        return at < 0 ? null : to127(at, Math.max(1, list.length - 1));
      }
      case 'adjustFadeTime':
        return to127(this._fadeMs, FADE_MAX_MS);
      case 'adjustStrobeRate':
        return this.busk ? to127(this.busk.strobeRate() - 1, Math.max(1, this.busk.strobeMaxRate - 1)) : null;
      default:
        return null;
    }
  }

  _sendControlFeedback(): void {
    const output = this.output;
    if (!this.controlFeedback || !output) return;
    const now = Date.now();

    for (const [cc, binding] of Object.entries(this.map.cc || {})) {
      const value = this._feedbackValue(binding);
      if (value === null) continue;

      const number = Number(cc);
      const touchedAt = this._lastCcIn.get(number) || 0;
      if (now - touchedAt < ECHO_SUPPRESS_MS) continue;
      // A finger on it, by its touch sensor: the motor must not fight it.
      if (this._touched(number)) continue;
      const encoder = ENCODER_ACTIONS.has(binding.action) ? `${binding.channel || 0}:${number}` : null;
      // A ring moved off its end stays there until the encoder says what it is.
      if (encoder !== null && now - (this._probes.get(encoder) ?? -Infinity) < PROBE_HOLD_MS) continue;
      // An encoder sending its position counts on from where it was turned to,
      // which is not always where the ring was sent: send it again, so the
      // ring shows the show and the encoder counts from there.
      const drifted = encoder !== null && this._encoderMode(encoder, binding) === 'position'
        && this._positions.get(encoder) !== value;
      if (this._lastCcOut.get(number) === value && !drifted) continue;

      this._lastCcOut.set(number, value);
      if (encoder !== null) this._positions.set(encoder, value);
      try {
        output.send('cc', { controller: number, value, channel: binding.channel || 0 });
      } catch (_) { /* the port can vanish mid-show; feedback is not worth dying for */ }
    }
  }

  _ledNote(note: number, velocity: number, channel = 0): void {
    if (!this.output) return;
    try {
      this.output.send('noteon', { note, velocity, channel });
    } catch (_) { /* the port can vanish mid-show; feedback is not worth dying for */ }
  }

  _pressPad(channel: number, note: number, binding: MidiBinding): void {
    const key = `${channel}:${note}`;
    if (!this.pads || this._heldPads.has(key) || binding.bank === undefined || binding.slot === undefined) return;
    const pad = { bank: binding.bank, slot: binding.slot, owner: `midi:pad:${key}`, token: `midi:${key}` };
    const voice = this.pads.press(pad.bank, pad.slot, pad.owner, pad.token);
    const held: HeldPad = { ...pad, renew: null };
    this._heldPads.set(key, held);
    if (!voice || voice.mode !== 'hold') return;
    const strobeMs = voice.spec?.kind === 'strobe' ? this.pads.strobeMaxMs?.() : undefined;
    const maxMs = strobeMs !== undefined && Number.isFinite(strobeMs) && strobeMs > 0 ? strobeMs : MIDI_HOLD_MAX_MS;
    let ticks = 0;
    held.renew = setInterval(() => this._safely(binding, () => {
      if (this._heldPads.get(key) !== held) return;
      ticks++;
      const renewed = ticks * PAD_RENEW_MS < maxMs && !this._portGone() && !!this.pads?.renew(pad.bank, pad.slot, pad.owner, pad.token);
      if (!renewed) this._releasePad(channel, note);
    }), PAD_RENEW_MS);
    held.renew.unref?.();
  }

  _portGone(): boolean {
    if (!easymidi || !this._inputName) return false;
    try {
      return !easymidi.getInputs().includes(this._inputName);
    } catch (_) {
      return true;
    }
  }

  _releasePad(channel: number, note: number): boolean {
    const key = `${channel}:${note}`;
    const held = this._heldPads.get(key);
    if (!held) return false;
    if (held.renew) clearInterval(held.renew);
    this._heldPads.delete(key);
    this.pads?.release(held.bank, held.slot, held.owner, held.token);
    return true;
  }

  close(): void {
    for (const key of [...this._heldPads.keys()]) {
      const [channel, note] = key.split(':').map(Number);
      this._releasePad(channel, note);
    }
    this.cancelLearn('disconnected');
    // Forget what we sent: the next connection has to push the full state so
    // the faders fly to where the show is rather than staying where they lay.
    this._lastCcOut.clear();
    this._lastCcIn.clear();
    this._touchDown.clear();
    this._positions.clear();
    this._encModes.clear();
    this._probes.clear();
    if (this.input)  { try { this.input.close();  } catch (_) {} }
    if (this.output) { try { this.output.close(); } catch (_) {} }
    this.enabled = false;
    this._inputName = null;
    this._cachedPorts = null;
  }
}

function openMidiOutput(name: string): MidiOutput | null {
  if (!easymidi || !name) return null;
  if (!easymidi.getOutputs().includes(name)) return null;
  return new easymidi.Output(name);
}

export { openMidiOutput };
export default MidiController;
