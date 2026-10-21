import { compareSlots, rankOf, supersededError } from './analyzer-worker.ts';
import { cancelledError, isCancelled, messageOf } from './errors.ts';
import { settings } from './server/settings.ts';
import type AnalyzerWorker from './analyzer-worker.ts';
import type { AnalysisPriority, AnalyzeOptions } from './analyzer-worker.ts';
import type { Analysis } from './show/score.ts';

export type LocalAnalyzer = Pick<AnalyzerWorker,
  'analyze' | 'cancel' | 'promote' | 'setQueueOrder' | 'pause' | 'resume' | 'restart' | 'prewarm' | 'shutdown'>;

export interface RemoteRequest {
  source: string;
  targetDurationSec: number | null;
  priority: AnalysisPriority;
  tag: string | null;
}

/** One job on a remote worker. `result` rejects with `remote`: declined, failed or cancelled. */
export interface RemoteHandle {
  readonly id: string;
  readonly worker: string;
  readonly result: Promise<Analysis>;
  priority: AnalysisPriority;
  cancel(reason: string): void;
}

export interface RemotePool {
  eligible(source: unknown): boolean;
  idleWorker(): string | null;
  hasCompatible(): boolean;
  run(worker: string, request: RemoteRequest): RemoteHandle;
  onChange(fn: () => void): void;
}

interface Entry {
  id: number;
  source: string;
  target: number | null;
  priority: AnalysisPriority;
  tag: string | null;
  order: number;
  queuedAt: number;
  resolve: (analysis: Analysis) => void;
  reject: (err: Error) => void;
  settled: boolean;
  /** The local run in flight, if any; a stale run's answer is ignored. */
  local: symbol | null;
  remote: RemoteHandle | null;
  /** A worker accepted it and failed: this machine finishes it. */
  remoteFailed: boolean;
}

const RANKS: Record<string, true | undefined> = { current: true, high: true, normal: true };

/**
 * Sends each analysis to an idle remote GPU worker when one is connected and
 * runs the rest on this machine. The playing track starts here at once when no
 * worker is idle, and a worker that frees up runs it too: the first answer wins.
 * A prefetch waits up to `analysis.remoteWaitMs` for a busy worker. Whatever a
 * worker fails or drops comes back to this machine.
 */
class AnalysisRouter {
  declare _local: LocalAnalyzer;
  declare _pool: RemotePool | null;
  declare _waitMs: () => number;
  declare _now: () => number;
  declare _queue: Entry[];
  declare _live: Set<Entry>;
  declare _nextId: number;
  declare _paused: string | null;
  declare _shuttingDown: boolean;
  declare _wake: ReturnType<typeof setTimeout> | null;

  constructor(local: LocalAnalyzer, { waitForRemoteMs = () => settings.get('analysis.remoteWaitMs'), now = () => Date.now() }:
    { waitForRemoteMs?: () => number; now?: () => number } = {}) {
    this._local = local;
    this._pool = null;
    this._waitMs = waitForRemoteMs;
    this._now = now;
    this._queue = [];
    this._live = new Set();
    this._nextId = 1;
    this._paused = null;
    this._shuttingDown = false;
    this._wake = null;
  }

  attachRemote(pool: RemotePool): void {
    this._pool = pool;
    pool.onChange(() => this._pump());
    this._pump();
  }

  analyze(source: unknown, targetDurationSec: number | null | undefined, options: AnalyzeOptions = {}): Promise<Analysis> {
    if (this._shuttingDown) return Promise.reject(new Error('AnalyzerWorker is shutting down'));
    const priority = (options.priority && RANKS[options.priority] ? options.priority : 'normal') as AnalysisPriority;
    const queuePos = options.queuePos;
    return new Promise<Analysis>((resolve, reject) => {
      const entry: Entry = {
        id: this._nextId++, source: source as string,
        target: typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) ? targetDurationSec : null,
        priority, tag: options.tag || null,
        order: typeof queuePos === 'number' && Number.isFinite(queuePos) && queuePos >= 0 ? queuePos : Infinity,
        queuedAt: this._now(), resolve, reject, settled: false, local: null, remote: null, remoteFailed: false,
      };
      this._live.add(entry);
      this._insert(entry);
      this._pump();
    });
  }

  promote(tag: string | null | undefined, priority: AnalysisPriority = 'high'): void {
    if (!tag || !RANKS[priority]) return;
    for (const entry of this._live) {
      if (entry.tag !== tag || rankOf(entry.priority) <= rankOf(priority)) continue;
      entry.priority = priority;
      if (entry.remote) entry.remote.priority = priority;
    }
    this._queue.sort(compareSlots);
    this._local.promote(tag, priority);
    this._pump();
  }

  cancel(tag: string | null | undefined): boolean {
    if (!tag) return false;
    const matching = [...this._live].filter((entry) => entry.tag === tag);
    for (const entry of matching) this._settle(entry, cancelledError());
    if (matching.length) this._pump();
    return matching.length > 0;
  }

  setQueueOrder(tags: unknown): void {
    if (!Array.isArray(tags)) return;
    for (const entry of this._queue) {
      if (entry.priority === 'current') continue;
      const idx = entry.tag ? tags.indexOf(entry.tag) : -1;
      entry.order = idx < 0 ? Infinity : idx;
    }
    this._queue.sort(compareSlots);
    this._local.setQueueOrder(tags);
  }

  pause(reason: string): void {
    this._paused = reason;
    this._local.pause(reason);
  }

  resume(): void {
    this._paused = null;
    this._local.resume();
    this._pump();
  }

  restart(reason?: string, opts?: { whenIdle?: boolean }): void { this._local.restart(reason, opts); }

  prewarm(): void { this._local.prewarm(); }

  shutdown(): void {
    this._shuttingDown = true;
    if (this._wake) clearTimeout(this._wake);
    for (const entry of [...this._live]) this._settle(entry, new Error('worker shutting down'));
    this._local.shutdown();
  }

  /** What the router holds: for the workers' status page. */
  counts(): { queued: number; local: number; remote: number } {
    let local = 0, remote = 0;
    for (const entry of this._live) {
      if (entry.local) local++;
      if (entry.remote) remote++;
    }
    return { queued: this._queue.length, local, remote };
  }

  _insert(entry: Entry, { front = false } = {}): void {
    let i = 0;
    while (i < this._queue.length) {
      const cmp = compareSlots(this._queue[i], entry);
      if (cmp > 0 || (cmp === 0 && front)) break;
      i++;
    }
    this._queue.splice(i, 0, entry);
  }

  _unqueue(entry: Entry): void {
    const idx = this._queue.indexOf(entry);
    if (idx >= 0) this._queue.splice(idx, 1);
  }

  _settle(entry: Entry, err: Error | null, analysis?: Analysis): void {
    if (entry.settled) return;
    entry.settled = true;
    this._live.delete(entry);
    this._unqueue(entry);
    this._dropRemote(entry, err ? messageOf(err) : 'analysed elsewhere');
    this._dropLocal(entry);
    if (err) entry.reject(err);
    else entry.resolve(analysis as Analysis);
  }

  _dropRemote(entry: Entry, reason: string): void {
    const handle = entry.remote;
    if (!handle) return;
    entry.remote = null;
    handle.cancel(reason);
  }

  /** Stop the local run; the local analyser recycles its process for the next job. */
  _dropLocal(entry: Entry): void {
    if (!entry.local) return;
    entry.local = null;
    if (entry.tag) this._local.cancel(entry.tag);
  }

  _localEntries(): Entry[] {
    return [...this._live].filter((entry) => entry.local);
  }

  _remoteEligible(entry: Entry): boolean {
    return !!this._pool && !entry.remote && !entry.remoteFailed && this._pool.eligible(entry.source);
  }

  _pump(): void {
    if (this._shuttingDown) return;
    this._dispatchRemote();
    this._preemptRemote();
    this._dispatchLocal();
    this._armWake();
  }

  _dispatchRemote(): void {
    const pool = this._pool;
    if (!pool) return;
    for (let worker = pool.idleWorker(); worker; worker = pool.idleWorker()) {
      const queued = this._queue.find((entry) => this._remoteEligible(entry));
      const running = this._localEntries();
      const race = running.length === 1 && running[0].tag && this._remoteEligible(running[0]) ? running[0] : null;
      let entry: Entry;
      if (race && (!queued || rankOf(race.priority) < rankOf(queued.priority))) entry = race;
      else if (queued) entry = queued;
      else return;
      this._unqueue(entry);
      if (!this._sendRemote(worker, entry)) return;
    }
  }

  _sendRemote(worker: string, entry: Entry): boolean {
    let handle: RemoteHandle;
    try {
      handle = (this._pool as RemotePool).run(worker, {
        source: entry.source, targetDurationSec: entry.target, priority: entry.priority, tag: entry.tag,
      });
    } catch (err) {
      console.warn(`[analyzer] remote: could not send request ${entry.id}: ${messageOf(err)}`);
      entry.remoteFailed = true;
      if (!entry.local) this._insert(entry, { front: true });
      return false;
    }
    entry.remote = handle;
    handle.result.then((analysis) => {
      if (entry.remote !== handle) return;
      entry.remote = null;
      this._settle(entry, null, analysis);
      this._pump();
    }, (err: Error & { remote?: string }) => {
      if (entry.remote !== handle) return;
      entry.remote = null;
      if (err.remote !== 'declined') entry.remoteFailed = true;
      if (!entry.local) this._insert(entry, { front: true });
      this._pump();
    });
    return true;
  }

  // The playing track frees a worker from lower-priority work so it can race the run here.
  _preemptRemote(): void {
    const head = this._queue[0];
    if (!head || head.priority !== 'current' || !this._remoteEligible(head)) return;
    for (const entry of [...this._live]) {
      if (!entry.remote || (entry.priority === 'current' && entry.tag === head.tag)) continue;
      if (entry.priority === 'current') {
        this._settle(entry, supersededError());
        continue;
      }
      this._dropRemote(entry, 'preempted by the track now playing');
      if (!entry.local) this._insert(entry, { front: true });
    }
  }

  _dispatchLocal(): void {
    const head = this._queue[0];
    if (!head || this._paused) return;
    const running = this._localEntries();
    if (head.priority === 'current') {
      if (running.some((entry) => entry.tag && entry.tag === head.tag)) return;
      for (const entry of running) {
        if (!entry.tag) continue;
        this._dropLocal(entry);
        if (entry.remote) continue;
        if (entry.priority === 'current') this._settle(entry, supersededError());
        else this._insert(entry, { front: true });
      }
      this._runLocal(head);
      return;
    }
    if (running.length) return;
    const pool = this._pool;
    const waitForWorker = !!pool && pool.hasCompatible() && this._remoteEligible(head)
      && this._now() - head.queuedAt < this._waitMs();
    if (!waitForWorker) this._runLocal(head);
  }

  _runLocal(entry: Entry): void {
    this._unqueue(entry);
    const run = Symbol(`local ${entry.id}`);
    entry.local = run;
    const queuePos = entry.order === Infinity ? null : entry.order;
    this._local.analyze(entry.source, entry.target, { priority: entry.priority, tag: entry.tag, queuePos })
      .then((analysis) => {
        if (entry.local !== run) return;
        entry.local = null;
        this._settle(entry, null, analysis);
        this._pump();
      }, (err: Error) => {
        if (entry.local !== run) return;
        entry.local = null;
        // A worker still racing it may succeed where this machine failed.
        if (!entry.remote || isCancelled(err)) this._settle(entry, err);
        this._pump();
      });
  }

  _armWake(): void {
    if (this._wake) { clearTimeout(this._wake); this._wake = null; }
    const pool = this._pool;
    if (!pool || !pool.hasCompatible()) return;
    const waiting = this._queue.find((entry) => entry.priority !== 'current' && this._remoteEligible(entry));
    if (!waiting) return;
    const delay = Math.max(0, waiting.queuedAt + this._waitMs() - this._now());
    this._wake = setTimeout(() => { this._wake = null; this._pump(); }, delay + 5);
    this._wake.unref?.();
  }
}

export default AnalysisRouter;
