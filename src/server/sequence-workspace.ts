import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { JsonStore } from './json-store.ts';
import { patternSchema, sequenceSchema } from './sequencer.ts';
import { canonical } from '../shared/effects/layer.ts';
import { messageOf, codeOf } from '../errors.ts';
import type { Recording, Sequence, Sequencer } from './sequencer.ts';

const nonnegative = z.number().nonnegative();
const takeSchema = z.object({
  phase: z.enum(['active', 'review']).optional(), mode: z.enum(['overdub', 'replace']),
  fromBeat: nonnegative, clockFrom: z.number(), full: z.boolean().optional(), quantise: nonnegative.max(64),
  sequenceId: z.string().min(1).max(64), revision: z.number().int(),
  take: z.array(z.object({
    bank: z.number().int().min(-1), slot: z.number().int().min(-1), start: nonnegative, length: nonnegative,
    targets: z.union([z.literal('shared'), z.array(z.number().int().nonnegative())]), open: z.boolean(),
    presetId: z.string().optional(), patternId: z.string().optional(), pattern: patternSchema.optional(),
    drop: z.boolean().optional(), once: z.boolean().optional(), at: nonnegative.optional(),
  }).strict().refine((hit) => hit.presetId ? !hit.patternId && hit.length > 0 : !!hit.patternId && hit.pattern?.id === hit.patternId)).max(4096),
}).strict();

const workspaceSchema = z.object({
  version: z.literal(1), sequence: sequenceSchema.nullable(), baseline: sequenceSchema.nullable(),
  savedSequenceId: z.string().nullable(), beat: nonnegative,
  take: takeSchema.nullable(), takeCompatible: z.boolean(),
}).strict().refine((w) => (!w.baseline || w.baseline.id === w.sequence?.id)
  && (!w.savedSequenceId || w.savedSequenceId === w.sequence?.id)
  && (!w.take || w.take.sequenceId === w.sequence?.id));

export interface WorkspaceStatus {
  dirty: boolean;
  recovered: boolean;
  pending: boolean;
  blocked: boolean;
  error: string | null;
}

export class SequenceWorkspace extends JsonStore {
  private sequencer: Sequencer;
  private saved: (id: string) => Sequence | null;
  private baseline: Sequence | null = null;
  private identity: string | null = null;
  private recovered = false;
  private dirty = false;
  private blocked = false;
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirty = 0;
  private pending = false;
  private detach: (() => void) | null = null;
  private notify: () => void;

  constructor(file: string, sequencer: Sequencer, saved: (id: string) => Sequence | null, notify: () => void = () => {}) {
    super(file, { tag: 'sequence-workspace', fallback: 'workspace awaits recovery' });
    this.sequencer = sequencer;
    this.saved = saved;
    this.notify = notify;
  }

  open(): this {
    try {
      if (fs.statSync(this.file).size > 32 * 1024 * 1024) throw new Error('Workspace exceeds 32 MiB');
      const data = workspaceSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      if (data.sequence) {
        this.sequencer.validateRecoveryTargets(data.sequence);
        this.sequencer.load(data.sequence);
        this.sequencer.seek(data.beat);
        if (data.take) this.sequencer.restoreTake(data.take as Recording, data.takeCompatible);
        this.recovered = true;
      }
      this.baseline = data.baseline;
      this.identity = data.sequence?.id ?? null;
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') {
        this.blocked = true;
        this.error = messageOf(err);
      }
    }
    this.updateDirty();
    this.sequencer.setWorkspaceStatus(() => this.status());
    this.detach = this.sequencer.onChange(() => this.changed());
    return this;
  }

  status(): WorkspaceStatus {
    return {
      dirty: this.dirty,
      recovered: this.recovered, pending: this.pending, blocked: this.blocked, error: this.error,
    };
  }

  document() {
    const sequence = this.sequencer.current();
    const take = this.sequencer.pendingTake();
    return {
      version: 1 as const, sequence, baseline: this.baseline ? structuredClone(this.baseline) : null,
      savedSequenceId: this.baseline?.id ?? null, beat: this.sequencer.status().beat,
      take, takeCompatible: take?.revision === this.sequencer.revision(),
    };
  }

  savedChanged(): void {
    if (!this.detach) return;
    const current = this.sequencer.current();
    if (!current) return;
    this.baseline = this.saved(current.id);
    this.changed();
  }

  private updateDirty(): void {
    const current = this.sequencer.current();
    this.dirty = !!current && (!this.baseline || canonical(current) !== canonical(this.baseline));
  }

  private changed(): void {
    if (this.blocked) return;
    const id = this.sequencer.current()?.id ?? null;
    if (id !== this.identity) {
      this.identity = id;
      this.baseline = id ? this.saved(id) : null;
      this.recovered = false;
    }
    this.updateDirty();
    if (!this.pending) this.firstDirty = Date.now();
    this.pending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(300, 2000 - (Date.now() - this.firstDirty))));
    this.timer.unref();
    this.notify();
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.blocked || !this.pending) return !this.error;
    try {
      const data = workspaceSchema.parse(this.document());
      this.writeJson(data);
      this.pending = false;
      this.error = null;
    } catch (err) { this.error = messageOf(err); }
    this.notify();
    return !this.error;
  }

  startFresh(): void {
    // Preserve the unreadable document before enabling autosave again.
    if (this.blocked && fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.recovery-${crypto.randomUUID()}`);
    this.blocked = false;
    this.error = null;
    this.recovered = false;
    this.changed();
    this.flush();
  }

  close(): void {
    // Never opened: the file on disk is still the recovery copy.
    if (!this.detach) return;
    if (!this.blocked && this.sequencer.current()) this.pending = true;
    this.flush();
    this.detach?.();
    this.detach = null;
  }
}
