import { automationValue, validateSequence } from './sequencer.ts';
import type { Automation, SequencePatch } from './sequencer.ts';
import type { MusicalTime } from './conductor.ts';
import { HttpError } from '../errors.ts';

type Axis = 'tempo' | 'brightness';
interface Run { settings: Automation; from: number; startMs: number; elapsedBeats: number; last: MusicalTime | null; armed: boolean }
interface Context { bpm: number; masterDimmer: number; running: boolean; masterBlackout: boolean; armed: boolean; sequenceRunning: boolean }

export class LiveAutomation {
  private runs: Record<Axis, Run | null> = { tempo: null, brightness: null };
  private readonly current: () => Context;
  private readonly apply: (patch: SequencePatch) => void;
  private readonly now: () => number;

  constructor(current: () => Context, apply: (patch: SequencePatch) => void, now = () => performance.now()) {
    this.current = current; this.apply = apply; this.now = now;
  }

  start(axis: Axis, raw: unknown): void {
    if (axis !== 'tempo' && axis !== 'brightness') throw new HttpError(400, 'Choose tempo or brightness');
    const settings = validateSequence({ id: 'live-automation', name: 'Live automation', automation: { [axis]: raw } }).automation[axis];
    if (!settings || settings.mode === 'none') { this.runs[axis] = null; return; }
    const state = this.current();
    if (state.sequenceRunning) throw new HttpError(409, 'Stop the sequence before starting live automation; a playing sequence owns its automation.');
    if (!state.running || state.masterBlackout) throw new HttpError(409, 'Resume the look and release blackout before starting live automation.');
    this.runs[axis] = { settings, from: axis === 'tempo' ? state.bpm : state.masterDimmer,
      startMs: this.now(), elapsedBeats: 0, last: null, armed: state.armed };
  }

  stop(axis?: Axis): void {
    if (axis) this.runs[axis] = null;
    else this.runs = { tempo: null, brightness: null };
  }

  handEdit({ bpm, masterDimmer }: { bpm: boolean; masterDimmer: boolean }): void {
    if (bpm) this.stop('tempo');
    if (masterDimmer) this.stop('brightness');
  }

  status() {
    return { tempo: this.runs.tempo ? structuredClone(this.runs.tempo.settings) : null,
      brightness: this.runs.brightness ? structuredClone(this.runs.brightness.settings) : null };
  }

  frame(reading: MusicalTime): boolean {
    if (!this.runs.tempo && !this.runs.brightness) return false;
    const state = this.current();
    if (!state.running || state.masterBlackout || state.sequenceRunning) { this.stop(); return true; }
    const patch: SequencePatch = {};
    for (const axis of ['tempo', 'brightness'] as const) {
      const run = this.runs[axis];
      if (!run) continue;
      if (run.armed && !state.armed) { this.stop(axis); continue; }
      run.armed = state.armed;
      if (run.last?.epoch === reading.epoch) run.elapsedBeats += Math.max(0, reading.beatPos - run.last.beatPos);
      // Do not count a clock handover or backward correction twice.
      run.last = run.last?.epoch === reading.epoch && run.last.beatPos > reading.beatPos ? run.last : { ...reading };
      const elapsed = axis === 'tempo' ? Math.max(0, this.now() - run.startMs) / 1000 : run.elapsedBeats;
      const value = automationValue(run.settings, run.from, elapsed);
      if (value !== null) {
        if (axis === 'tempo') patch.bpm = Math.max(20, Math.min(300, Math.round(value * 100) / 100));
        else patch.masterDimmer = Math.max(0, Math.min(255, Math.round(value)));
      }
      if (run.settings.mode === 'target' && elapsed >= run.settings.period) this.stop(axis);
    }
    if (Object.keys(patch).length) this.apply(patch);
    return true;
  }
}
