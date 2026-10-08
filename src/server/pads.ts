import { z } from 'zod';
import { PAD_BANKS, PAD_SLOTS, PAD_COUNT, STROBE_ID, padFieldsSchema as fieldsSchema, padLayoutSchema as layoutSchema } from '../shared/party-setup.ts';
import type { PadContent, PadContentKind, PadEntry, PadLaunchMode, ShowPerformance } from '../shared/party-setup.ts';
export { PAD_BANKS, PAD_SLOTS, PAD_COUNT, STROBE_ID };
export type { PadContent, PadContentKind, PadEntry, PadLaunchMode };

import { deepFreeze, presetById } from '../shared/effects/index.ts';
import { canonical } from '../shared/effects/layer.ts';
import { HttpError, messageOf } from '../errors.ts';
import { JsonStore } from './json-store.ts';
import { snapshot } from './effect-library.ts';
import { validate, ValidationError } from './validation.ts';
import { launchOf, targetsOf } from './voices.ts';
import { resolveBundle } from './sequencer.ts';
import { bundleSpec } from '../shared/effects/bundle.ts';
import type { EffectResolver, SequencePattern } from './sequencer.ts';
import type { PresetLookup, Voice, VoiceManager, VoiceMode, VoiceTargets } from './voices.ts';

/**
 * Pads: Hue Dynamics' two banks of eight. Each pad plays a preset, a pattern
 * (one voice of lanes and clips), the strobe, or drops a pattern into the
 * sequence; held, once or as a loop that a second press stops; on a grid of
 * its own (0 is now) and on the whole rig or some fixtures. The layout lives
 * in config/pads.json; what a pad plays is a voice (voices.ts), one per pad.
 *
 *   hold   plays while its owner renews the lease: a page over the socket,
 *          or a REST caller pressing again within HOLD_TIMEOUT_MS
 *   once   plays its length: `?ms=`, else the preset's, else its loop's
 *   loop   latched until the pad is pressed or toggled again
 */

// Hue Dynamics' default: 240 of its 960 ticks to the beat.
export const DEFAULT_QUANTISE = 0.25;
/** The token a REST press uses when it names none, so its bare release finds it. */
export const REST_TOKEN = 'rest';

/** What a pattern pad hands the pattern player: the pad's launch, under the pad's key. No length: the pattern's own plays, unless `lengthMs`. */
export interface PadVoiceLaunch {
  targets: VoiceTargets;
  mode: VoiceMode;
  quantise: number;
  /** Start it under this key: a pad plays one voice at a time. */
  key: string;
  source: 'pad';
  label: string;
  owner?: string;
  token?: string;
  lengthMs?: number;
}
/** Plays a pattern as one voice; the sequencer's patterns install it. */
export type PatternVoiceHook = (id: string, launch: PadVoiceLaunch) => Voice;

export interface PatternPlayerOptions {
  voices: VoiceManager;
  /** A saved pattern by id, or null. */
  pattern: (id: string) => SequencePattern | null;
  fixtureIds: () => readonly number[];
  resolve: EffectResolver;
}

/**
 * The pattern player: the pattern resolved over the pad's fixtures, started
 * as one bundle voice with the pad's launch. A once lasts the bundle's own
 * length unless the launch gives one.
 */
export function patternPlayer({ voices, pattern, fixtureIds, resolve }: PatternPlayerOptions): PatternVoiceHook {
  return (id, launch) => {
    const found = pattern(id);
    if (!found) throw new HttpError(404, `No such pattern: ${id}`);
    const bundle = resolveBundle(found, launch.targets, fixtureIds(), resolve);
    const once = launch.mode === 'once';
    return voices.start({
      ...launch, spec: bundleSpec(bundle, once), tier: 'voice',
      ...(once && launch.lengthMs === undefined ? { lengthBeats: bundle.lengthBeats } : {}),
    });
  };
}
/** Drops a pattern into the loaded sequence at a beat; the sequencer installs it. */
export type InsertPatternHook = (id: string, atBeat: number) => void;
/** A pad launched (its grid beat) or a held one released (with its end), for the sequencer's punch recording. */
export type PadHitHook = (hit: { bank: number; slot: number; startBeat: number; endBeat?: number; lengthMs?: number; once?: boolean }) => void;
/** The manual strobe's hold, which the strobe installs: the strobe pad and voice-hold's `{ preset: 'strobe' }` both go through it. */
export interface StrobeHook {
  hold(owner: string, token: string, launch: { targets: VoiceTargets; quantise: number }): Voice;
  release(owner: string, token: string): void;
}

/** One issue with a new assignment, under its path in the entry. */
export interface PadIssue { path: (string | number)[]; message: string }
/** Asked of an entry before it is saved, with the one it replaces: what it names that is not there. */
export type PadAdmission = (entry: PadEntry, before: PadEntry) => PadIssue[];

/** A pad's place in the layout, bank by bank; a 400 naming the bank or the slot that is none. */
export function padIndex(bank: unknown, slot: unknown): number {
  if (bank !== 0 && bank !== 1) throw new HttpError(400, `pad: bank must be 0 or ${PAD_BANKS - 1}`);
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= PAD_SLOTS) {
    throw new HttpError(400, `pad: slot must be 0 to ${PAD_SLOTS - 1}`);
  }
  return bank * PAD_SLOTS + slot;
}

/**
 * The owner a REST press holds a pad under: one per pad, and never a
 * socket's (socket.io ids have no colon), so a REST press and a socket's
 * never share a lease.
 */
export const restOwner = (bank: number, slot: number): string => `rest:pad:${bank}:${slot}`;

const padKey = (index: number) => `pad:${Math.floor(index / PAD_SLOTS)}:${index % PAD_SLOTS}`;

// ── The layout file ─────────────────────────────────────────────────────────

const fileSchema = z.object({ pads: layoutSchema, activeLayoutId: z.string().min(1).max(64).nullable().optional() }).strict();

const ordered = (pads: readonly PadEntry[]): PadEntry[] =>
  [...pads].sort((a, b) => (a.bank * PAD_SLOTS + a.slot) - (b.bank * PAD_SLOTS + b.slot));

// A fresh install: the six energy effects and the strobe held, then Hue
// Dynamics and Light DJ looks. None but the two energy strobes (and the
// strobe pad, the strobe's own) waits for the photosensitivity acknowledgement.
// The energy effects and the strobe start on the press, as they always have;
// the looks on Hue Dynamics' quarter beat.
const DEFAULTS: [content: PadContent, launch: PadLaunchMode, accent: string][] = [
  [{ kind: 'preset', id: 'energy.whiteStrobe' }, 'hold', '#FFFFFF'],
  [{ kind: 'preset', id: 'energy.colorStrobe' }, 'hold', '#F472B6'],
  [{ kind: 'preset', id: 'energy.blinder' }, 'hold', '#FDE047'],
  [{ kind: 'preset', id: 'energy.uvWash' }, 'hold', '#7C3AED'],
  [{ kind: 'preset', id: 'energy.kill' }, 'hold', '#334155'],
  [{ kind: 'preset', id: 'energy.glow' }, 'hold', '#FB923C'],
  [{ kind: 'strobe', id: STROBE_ID }, 'hold', '#E2E8F0'],
  [{ kind: 'preset', id: 'hd.bassBloom' }, 'once', '#FF006E'],
  [{ kind: 'preset', id: 'hd.auroraDrift' }, 'loop', '#06B6D4'],
  [{ kind: 'preset', id: 'hd.neonDomino' }, 'loop', '#FF2BD6'],
  [{ kind: 'preset', id: 'hd.prismRicochet' }, 'loop', '#A855F7'],
  [{ kind: 'preset', id: 'hd.meteorShower' }, 'once', '#38BDF8'],
  [{ kind: 'preset', id: 'ldj.Swirl' }, 'loop', '#22D3EE'],
  [{ kind: 'preset', id: 'ldj.GrooveWave' }, 'loop', '#22C55E'],
  [{ kind: 'preset', id: 'ldj.NorthernLights' }, 'loop', '#10B981'],
  [{ kind: 'preset', id: 'ldj.Popcorn' }, 'once', '#FACC15'],
];
const startsAtOnce = (content: PadContent): boolean => content.kind === 'strobe' || content.id.startsWith('energy.');
/** The layout a fresh install starts with, frozen; labels are the presets' names. */
export const DEFAULT_PADS: readonly PadEntry[] = deepFreeze(DEFAULTS.map(([content, launch, accent], i): PadEntry => ({
  bank: Math.floor(i / PAD_SLOTS) as 0 | 1, slot: i % PAD_SLOTS,
  label: content.kind === 'strobe' ? 'Strobe' : presetById(content.id)!.name,
  accent, content, launch, quantise: startsAtOnce(content) ? 0 : DEFAULT_QUANTISE, targets: 'shared',
})));

/** A default pad saved when every default sat on the quarter beat is today's default; a pad the user changed keeps its grid. */
function mended(entry: PadEntry): PadEntry {
  const shipped = DEFAULT_PADS[entry.bank * PAD_SLOTS + entry.slot];
  if (shipped.quantise === DEFAULT_QUANTISE) return entry;
  return canonical(entry) === canonical({ ...shipped, quantise: DEFAULT_QUANTISE }) ? shipped : entry;
}

/** A refusal in the form validate() gives one: each issue under its path. */
function refusal(label: string, issues: PadIssue[]): ValidationError {
  return new ValidationError(`${label}: ${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    issues.map((i) => ({ code: 'custom', path: i.path, message: i.message, input: undefined })) as unknown as z.ZodIssue[]);
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export class PadStore extends JsonStore {
  declare _layout: readonly PadEntry[];
  _activeLayoutId: string | null = null;
  revision = 0;
  _scope: (() => Readonly<ShowPerformance> | null) | null = null;
  _writeScope: ((pads: PadEntry[], activeLayoutId: string | null) => void) | null = null;
  layoutExists: ((id: string) => boolean) | null = null;
  declare _listeners: (() => void)[];
  declare _admit: PadAdmission | null;

  /** pads.json. No file is the default layout; one that does not validate is moved aside whole (JsonStore). */
  constructor(file: string) {
    super(file, { tag: 'pads', fallback: 'starting with the default pads' });
    this._layout = DEFAULT_PADS;
    this._listeners = [];
    this._admit = null;
  }

  // Shapes only: a preset or pattern deleted since, or a fixture gone, leaves
  // the pad assigned (refused at launch), rather than costing the whole layout.
  load(): this {
    const saved = this.readValid(fileSchema);
    if (saved) {
      this._layout = deepFreeze(ordered(saved.pads).map(mended));
      this._activeLayoutId = saved.activeLayoutId ?? null;
    }
    return this;
  }

  useDefaults(): void {
    this._layout = DEFAULT_PADS;
    this._activeLayoutId = null;
  }

  /** Every pad, bank 0 then bank 1, as copies. */
  layout(): PadEntry[] {
    return this.view().map(snapshot);
  }

  /** The layout itself, frozen, for the live state (it rides every broadcast). */
  view(): readonly PadEntry[] {
    return this._scope?.()?.pads ?? this._layout;
  }

  /** One pad, as a copy. */
  get(bank: number, slot: number): PadEntry {
    return snapshot(this.view()[padIndex(bank, slot)]);
  }

  activeLayoutId(): string | null {
    const scope = this._scope?.();
    const id = scope ? scope.activePadLayoutId : this._activeLayoutId;
    return id && this.layoutExists && !this.layoutExists(id) ? null : id;
  }

  setScope(read: () => Readonly<ShowPerformance> | null, write: (pads: PadEntry[], activeLayoutId: string | null) => void): void {
    this._scope = read;
    this._writeScope = write;
  }

  /** What decides whether an entry names what is there; asked only of what changed. */
  setAdmission(fn: PadAdmission | null): void {
    this._admit = fn;
  }

  /** Called after every saved change; never for a refused, failed or empty one. */
  onChange(fn: () => void): void {
    this._listeners.push(fn);
  }

  /** Assign one pad. Its bank and slot may come along when they are the place's own. */
  set(bank: number, slot: number, input: unknown): PadEntry {
    const index = padIndex(bank, slot);
    let body = input;
    if (isRecord(input) && (Object.hasOwn(input, 'bank') || Object.hasOwn(input, 'slot'))) {
      const { bank: b, slot: s, ...rest } = input;
      if (b !== undefined && b !== bank) throw refusal('pad', [{ path: ['bank'], message: `${String(b)} is not this pad's (${bank})` }]);
      if (s !== undefined && s !== slot) throw refusal('pad', [{ path: ['slot'], message: `${String(s)} is not this pad's (${slot})` }]);
      body = rest;
    }
    const entry: PadEntry = { bank: bank as 0 | 1, slot, ...validate(fieldsSchema, body, 'pad') };
    const issues = this._admit?.(entry, this.view()[index]) ?? [];
    if (issues.length) throw refusal('pad', issues);
    this._commit(this.view().map((p, i) => (i === index ? entry : p)));
    return snapshot(entry);
  }

  /** Replace the whole layout: sixteen pads, each place once. All or nothing. */
  validate(input: unknown, before: readonly PadEntry[] = this.view()): PadEntry[] {
    const entries = validate(layoutSchema, input, 'pads') as PadEntry[];
    const issues = entries.flatMap((entry, i) => (this._admit?.(entry, before[entry.bank * PAD_SLOTS + entry.slot]) ?? [])
      .map((issue) => ({ ...issue, path: [i, ...issue.path] })));
    if (issues.length) throw refusal('pads', issues);
    return ordered(entries);
  }

  replace(input: unknown, activeLayoutId: string | null = this.activeLayoutId()): PadEntry[] {
    this._commit(this.validate(input), activeLayoutId);
    return this.layout();
  }

  /** Back to the default layout. */
  reset(): PadEntry[] {
    this._commit(DEFAULT_PADS, null);
    return this.layout();
  }

  // Written first, then published, as the effect library does; a change that
  // changes nothing is neither written nor told.
  _commit(next: readonly PadEntry[], activeLayoutId: string | null = this.activeLayoutId()): void {
    if (canonical(next) === canonical(this.view()) && activeLayoutId === this.activeLayoutId()) return;
    if (this._scope?.() && this._writeScope) {
      this._writeScope(next.map(snapshot), activeLayoutId);
      for (const fn of this._listeners) {
        try { fn(); } catch (err) { console.warn(`[pads] listener: ${messageOf(err)}`); }
      }
      return;
    }
    try {
      this.writeJson({ pads: next, ...(activeLayoutId ? { activeLayoutId } : {}) });
    } catch (err) {
      console.warn(`[pads] could not save ${this.file}: ${messageOf(err)}`);
      throw new HttpError(500, `Could not save the pads: ${messageOf(err)}`);
    }
    this._layout = deepFreeze([...next]);
    this._activeLayoutId = activeLayoutId;
    this.revision++;
    for (const fn of this._listeners) {
      try { fn(); } catch (err) { console.warn(`[pads] listener: ${messageOf(err)}`); }
    }
  }
}

// ── Playing them ────────────────────────────────────────────────────────────

export interface PadsOptions {
  voices: VoiceManager;
  store: PadStore;
  /** Presets by id or alias, as a launch reads them now (the library's, saved ones included). */
  lookup: () => PresetLookup;
  /** A pattern on the sequence shelf by id, or null: what a pattern or sequencePattern pad must name when saved. */
  pattern: (id: string) => SequencePattern | null;
  /** The patch's fixture ids now. */
  fixtureIds: () => readonly number[];
  /** The beat a sequence pattern is dropped in from. */
  beat?: () => number;
  insertPattern?: InsertPatternHook;
  /** Required: a pattern pad always has a player (patternPlayer). */
  patternVoice: PatternVoiceHook;
  strobe?: StrobeHook;
}

/** A voice a pad launched, or a strobe hold: what lights a pad, and what a release lets go of. */
interface PadRecord {
  /** The pad, or null for voice-hold's `{ preset: 'strobe' }`. */
  index: number | null;
  id: string;
  launchSeq: number;
  via: 'voice' | 'strobe';
  owner: string | null;
  token: string | null;
}

const HELD_ONLY = 'The strobe pad plays while it is held: press and release it';

export class Pads {
  declare store: PadStore;
  // Installed by the sequencer; until then a sequencePattern pad answers 409.
  declare insertPattern: InsertPatternHook | undefined;
  declare onHit: PadHitHook | undefined;
  declare _holds: Map<string, number>;
  // A latched loop's start, for the end its toggle-off records.
  declare _latched: Map<number, number>;
  declare patternVoice: PatternVoiceHook;
  declare strobe: StrobeHook | undefined;
  declare _voices: VoiceManager;
  declare _lookup: () => PresetLookup;
  declare _pattern: (id: string) => SequencePattern | null;
  declare _fixtureIds: () => readonly number[];
  declare _beat: () => number;
  declare _records: PadRecord[];

  constructor({ voices, store, lookup, pattern, fixtureIds, beat, insertPattern, patternVoice, strobe }: PadsOptions) {
    this.store = store;
    if (typeof patternVoice !== 'function') throw new TypeError('Pads needs a pattern player');
    if (typeof pattern !== 'function') throw new TypeError('Pads needs the pattern shelf');
    this.insertPattern = insertPattern;
    this.patternVoice = patternVoice;
    this.strobe = strobe;
    this._voices = voices;
    this._lookup = lookup;
    this._pattern = pattern;
    this._fixtureIds = fixtureIds;
    this._beat = beat ?? (() => 0);
    this._records = [];
    this._holds = new Map();
    this._latched = new Map();
    store.setAdmission((entry, before) => this._admit(entry, before));
  }

  /** One pad, as a copy. */
  entry(bank: number, slot: number): PadEntry {
    return this.store.get(bank, slot);
  }

  /** A press, as the pad's launch says; null when nothing plays (an empty pad, a loop stopped, a pattern dropped in). */
  press(bank: number, slot: number, owner: string, token: string): Voice | null {
    const index = padIndex(bank, slot);
    const entry = this.store.get(bank, slot);
    const content = entry.content;
    if (!content) return null;
    if (content.kind === 'sequencePattern') return this._insert(entry);
    if (content.kind === 'strobe') return this._holdStrobe(index, owner, token, this._targets(entry), entry.quantise);
    if (entry.launch === 'loop') return this._hit(bank, slot, entry, this._toggle(index, entry));
    if (entry.launch === 'once') return this._hit(bank, slot, entry, this._launch(index, entry, 'once'));
    const voice = this._hit(bank, slot, entry, this._launch(index, entry, 'hold', { owner, token }));
    if (voice && this.onHit) this._holds.set(`${index}|${owner}|${token}`, this._gridBeat(entry));
    return voice;
  }

  /** Let go of the hold this pad launched for `owner` and `token`, whatever the pad holds now; whether one went. */
  release(bank: number, slot: number, owner: string, token: string): boolean {
    const index = padIndex(bank, slot);
    const record = this._alive().find((r) => r.index === index && r.owner === owner && r.token === token);
    if (record) this._stop(record);
    // An ended voice's hold is closed too: the key never outlives its voice.
    const key = `${index}|${owner}|${token}`;
    const startBeat = this._holds.get(key);
    this._holds.delete(key);
    if (startBeat !== undefined) this.onHit?.({ bank, slot, startBeat, endBeat: this._beat() });
    return record !== undefined;
  }

  /**
   * Close the holds and loops whose voice ended by itself (its owner gone,
   * stop-all, a cap, a lease): the recording hears the end now. Once a frame.
   */
  sweep(): void {
    if (this._holds.size === 0 && this._latched.size === 0) return;
    const alive = this._alive();
    const held = new Set(alive.filter((r) => r.owner !== null).map((r) => `${r.index}|${r.owner}|${r.token}`));
    const lit = new Set(alive.filter((r) => r.owner === null).map((r) => r.index));
    const ended: [number, number][] = [];
    for (const [key, startBeat] of this._holds) {
      if (held.has(key)) continue;
      this._holds.delete(key);
      ended.push([Number(key.slice(0, key.indexOf('|'))), startBeat]);
    }
    for (const [index, startBeat] of this._latched) {
      if (lit.has(index)) continue;
      this._latched.delete(index);
      ended.push([index, startBeat]);
    }
    const endBeat = this._beat();
    for (const [index, startBeat] of ended) this.onHit?.({ bank: Math.floor(index / PAD_SLOTS), slot: index % PAD_SLOTS, startBeat, endBeat });
  }

  /** Play the pad once, whatever its launch: `ms` long, else its preset's or its pattern's length. */
  once(bank: number, slot: number, ms?: number): Voice | null {
    const index = padIndex(bank, slot);
    const entry = this.store.get(bank, slot);
    const content = entry.content;
    if (!content) return null;
    if (content.kind === 'sequencePattern') return this._insert(entry);
    if (content.kind === 'strobe') throw new HttpError(409, HELD_ONLY);
    return this._hit(bank, slot, entry, this._launch(index, entry, 'once', null, ms), ms);
  }

  /** Stop what the pad plays, or start it as a loop, whatever its launch. Null when it stopped. */
  toggle(bank: number, slot: number): Voice | null {
    const index = padIndex(bank, slot);
    const entry = this.store.get(bank, slot);
    if (entry.content?.kind === 'strobe') throw new HttpError(409, HELD_ONLY);
    return this._hit(bank, slot, entry, this._toggle(index, entry));
  }

  /** Stop every voice a pad launched, the strobe pad's hold included; the others play on. How many. */
  stopAll(): number {
    let n = 0;
    for (const record of this._alive()) {
      if (record.index !== null && record.via === 'strobe') {
        this._stop(record);
        n++;
      }
    }
    return n + this._voices.stopWhere((v) => v.source === 'pad');
  }

  /** voice-hold's `{ preset: 'strobe' }`, through the strobe pad's hook; without one, a preset by that id (a 400). */
  holdStrobe(owner: string, token: string, targets?: unknown): Voice {
    return this._holdStrobe(null, owner, token, targets);
  }

  /** Let go of `owner`'s hold under `token`, a pad's or not, by the way it was pressed. */
  releaseHold(owner: string, token: string): void {
    const record = this._alive().find((r) => r.owner === owner && r.token === token);
    if (record) this._stop(record);
    else this._voices.release(owner, token);
  }

  /** The voice each pad plays, bank 0 then bank 1, or null for a dark one. */
  lit(): (string | null)[] {
    const out: (string | null)[] = Array(PAD_COUNT).fill(null);
    // In launch order: the latest on a pad lights it.
    for (const record of this._alive()) if (record.index !== null) out[record.index] = record.id;
    return out;
  }

  /** The live state's `pads`: the layout, and which pads are lit. */
  view(): { layout: readonly PadEntry[]; lit: (string | null)[]; activeLayoutId: string | null } {
    return { layout: this.store.view(), lit: this.lit(), activeLayoutId: this.store.activeLayoutId() };
  }

  _toggle(index: number, entry: PadEntry): Voice | null {
    // Stopping first, before anything a launch would ask (the acknowledgement among it).
    const current = this._alive().filter((r) => r.index === index).at(-1);
    if (current) {
      this._stop(current);
      const startBeat = this._latched.get(index);
      this._latched.delete(index);
      if (startBeat !== undefined) this.onHit?.({ bank: Math.floor(index / PAD_SLOTS), slot: index % PAD_SLOTS, startBeat, endBeat: this._beat() });
      return null;
    }
    if (!entry.content) return null;
    if (entry.content.kind === 'sequencePattern') return this._insert(entry);
    const voice = this._launch(index, entry, 'latched');
    if (this.onHit) this._latched.set(index, this._gridBeat(entry));
    return voice;
  }

  _launch(index: number, entry: PadEntry, mode: VoiceMode, lease: { owner: string; token: string } | null = null, ms?: number): Voice {
    const content = entry.content!;
    const launch: PadVoiceLaunch = {
      targets: this._targets(entry), mode, quantise: entry.quantise, key: padKey(index), source: 'pad', label: entry.label || content.id,
      ...(lease ?? {}), ...(ms !== undefined ? { lengthMs: ms } : {}),
    };
    let voice: Voice;
    if (content.kind === 'pattern') {
      voice = this.patternVoice(content.id, launch);
    } else {
      // A copy of the preset as it is now: a later edit leaves this launch as it was.
      const found = launchOf({ preset: content.id }, this._lookup());
      voice = this._voices.start({
        ...launch, spec: found.spec, tier: 'voice', label: entry.label || found.label,
        // A once with no length plays its preset's, then its kind's (voices.ts lengthBeatsOf).
        ...(mode === 'once' && ms === undefined ? { lengthBeats: found.lengthBeats } : {}),
      });
    }
    this._remember(index, voice, 'voice', lease);
    return voice;
  }

  _holdStrobe(index: number | null, owner: string, token: string, targets: unknown, quantise = 0): Voice {
    if (this.strobe) {
      const voice = this.strobe.hold(owner, token, { targets: targetsOf(targets, this._fixtureIds()), quantise });
      this._remember(index, voice, 'strobe', { owner, token });
      return voice;
    }
    // voice-hold's own way with `{ preset: 'strobe' }`, as it was before the strobe.
    const found = launchOf({ preset: STROBE_ID }, this._lookup());
    const voice = this._voices.start({
      spec: found.spec, targets: targetsOf(targets, this._fixtureIds()), mode: 'hold', tier: 'voice', source: 'api', label: found.label, owner, token,
    });
    this._remember(index, voice, 'voice', { owner, token });
    return voice;
  }

  /** Drop the pad's pattern into the sequence at its next grid line (now, for a grid of 0). */
  _insert(entry: PadEntry): null {
    if (!this.insertPattern) throw new HttpError(409, 'No sequence to drop a pattern into on this server yet');
    this.insertPattern(entry.content!.id, this._gridBeat(entry));
    return null;
  }

  /** The pad's next grid line from now (now, for a grid of 0). */
  _gridBeat(entry: PadEntry): number {
    const beat = this._beat();
    const q = entry.quantise;
    return q > 0 && Number.isFinite(beat) ? Math.ceil(beat / q - 1e-9) * q : beat;
  }

  /** Tell the recording of a launch; a loop toggled off launched nothing. */
  _hit(bank: number, slot: number, entry: PadEntry, voice: Voice | null, ms?: number): Voice | null {
    if (voice && this.onHit) this.onHit({ bank, slot, startBeat: this._gridBeat(entry), ...(ms !== undefined ? { lengthMs: ms } : {}), ...(voice.mode === 'once' ? { once: true } : {}) });
    return voice;
  }

  /** The pad's fixtures that are still patched: a fixture removed since is gone, never another's id. */
  _targets(entry: PadEntry): VoiceTargets {
    if (entry.targets === 'shared') return 'shared';
    const known = new Set(this._fixtureIds());
    return entry.targets.filter((id) => known.has(id));
  }

  _stop(record: PadRecord): void {
    this._records = this._records.filter((r) => r !== record);
    if (record.via === 'strobe' && this.strobe && record.owner !== null && record.token !== null) this.strobe.release(record.owner, record.token);
    else if (record.owner !== null && record.token !== null) this._voices.release(record.owner, record.token);
    else this._voices.stop(record.id);
  }

  _remember(index: number | null, voice: Voice, via: PadRecord['via'], lease: { owner: string; token: string } | null): void {
    // A renewal hands back the same launch: one record for it.
    this._records = this._alive().filter((r) => !(r.id === voice.id && r.launchSeq === voice.launchSeq));
    this._records.push({ index, id: voice.id, launchSeq: voice.launchSeq, via, owner: lease?.owner ?? null, token: lease?.token ?? null });
  }

  /**
   * The records whose launch still plays. One ended (a stop, a disarm, a
   * lease run out, its page gone, a launch on the same pad) is forgotten:
   * nothing hidden is left for a release or a toggle to find.
   */
  _alive(): PadRecord[] {
    this._records = this._records.filter((r) => this._voices.get(r.id)?.launchSeq === r.launchSeq);
    return this._records;
  }

  /** What a new assignment names must be there now: its preset or shelf pattern, its fixtures. Only what changed is asked. */
  _admit(entry: PadEntry, before: PadEntry): PadIssue[] {
    const issues: PadIssue[] = [];
    const { content, targets } = entry;
    if (content && canonical(content) !== canonical(before.content)) {
      if (content.kind === 'preset' && !this._lookup()(content.id)) {
        issues.push({ path: ['content', 'id'], message: `No such preset: ${content.id}` });
      }
      if ((content.kind === 'pattern' || content.kind === 'sequencePattern') && !this._pattern(content.id)) {
        issues.push({ path: ['content', 'id'], message: `No such pattern: ${content.id}` });
      }
    }
    if (Array.isArray(targets) && canonical(targets) !== canonical(before.targets)) {
      const known = new Set(this._fixtureIds());
      for (const id of targets) if (!known.has(id)) issues.push({ path: ['targets'], message: `no fixture ${id}` });
    }
    return issues;
  }
}
