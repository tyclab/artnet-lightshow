import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { originAllowed, safeEqual } from './server/auth.ts';
import { durationOf, storedTimeoutMs } from './analyzer-worker.ts';
import { messageOf } from './errors.ts';
import type { Express, NextFunction, Request, Response, Router } from 'express';
import type { Server, Socket } from 'socket.io';
import type { AnalysisPriority } from './analyzer-worker.ts';
import type { RemoteHandle, RemotePool, RemoteRequest } from './analysis-router.ts';
import type { Analysis } from './show/score.ts';

export const NAMESPACE = '/analysis-worker';
export const HTTP_BASE = '/api/analysis-worker';
const PROTOCOL = 1;
const RESULT_LIMIT = '64mb';
const RECENT_KEPT = 20;
// Structure 'auto' runs SongFormer only on a GPU, so a worker may hold it when this server does not.
const GPU_EXTRAS = ['songformer'];

const MODEL_ID = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const helloSchema = z.object({
  protocol: z.literal(PROTOCOL),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  version: z.string().max(64).nullable(),
  models: z.array(MODEL_ID).max(32).nullable(),
  device: z.object({
    kind: z.enum(['cuda', 'rocm', 'cpu']),
    name: z.string().max(128).optional(),
    vramMiB: z.number().int().min(0).max(1 << 22).optional(),
  }).strict().nullable(),
  available: z.boolean(),
  reason: z.string().max(200).nullable().optional(),
  agent: z.string().max(64).optional(),
}).strict();
const statusSchema = helloSchema.omit({ protocol: true, name: true }).partial().strict();
const answerSchema = z.object({ accepted: z.boolean(), reason: z.string().max(200).optional() }).strict();
const resultSchema = z.object({
  version: z.string().max(64),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(4000).optional(),
  recycle: z.boolean().optional(),
  yielded: z.boolean().optional(),
  seconds: z.number().min(0).max(86400).optional(),
}).strict();

type Device = z.infer<typeof helloSchema>['device'];
type Kind = 'declined' | 'failed' | 'cancelled';
type Outcome = 'done' | 'failed' | 'yielded' | 'declined' | 'cancelled';

interface Stats { jobs: number; failed: number; declined: number; seconds: number; bytes: number }

interface WorkerRecord {
  socket: Socket;
  name: string | null;
  address: string;
  connectedAt: number;
  version: string | null;
  device: Device;
  models: string[] | null;
  available: boolean;
  reason: string | null;
  incompatible: string | null;
  job: Job | null;
  stats: Stats;
}

interface Job {
  id: string;
  key: string;
  worker: WorkerRecord;
  request: RemoteRequest;
  handle: RemoteHandle;
  state: 'offered' | 'running';
  offeredAt: number;
  acceptedAt: number | null;
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (analysis: Analysis) => void;
  reject: (err: Error) => void;
}

export interface RecentJob {
  worker: string;
  tag: string | null;
  file: string;
  priority: AnalysisPriority;
  outcome: Outcome;
  detail?: string;
  seconds: number | null;
  workerSeconds?: number;
  bytes: number;
  at: string;
}

export interface RemotePoolOptions {
  token: () => string;
  version: string;
  serverModels: () => Promise<string[] | null>;
  /** By default the local analyser's limit for the request, so a long track gets as long on a worker. */
  timeoutMs?: (request: RemoteRequest) => number;
  jobSettings?: () => { separator: string; structureModel: string };
  offerTimeoutMs?: number;
  now?: () => number;
}

function remoteError(kind: Kind, message: string): Error & { remote: Kind } {
  return Object.assign(new Error(message), { remote: kind });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function plainAddress(address: string): string {
  return address.replace(/^::ffff:/, '');
}

/**
 * Remote analysis workers: GPU machines that connect out to this server on
 * the `/analysis-worker` namespace with the worker token, take one job at a
 * time, fetch its audio here and post the document back. The worker token
 * opens these routes only; the UI token does not open them.
 */
export class RemoteAnalysisPool implements RemotePool {
  declare _token: () => string;
  declare version: string;
  declare _serverModels: () => Promise<string[] | null>;
  declare _timeoutMs: (request: RemoteRequest) => number;
  declare _jobSettings: () => { separator: string; structureModel: string };
  declare _offerTimeoutMs: number;
  declare _now: () => number;
  declare _workers: Map<string, WorkerRecord>;
  declare _jobs: Map<string, Job>;
  declare _listeners: (() => void)[];
  declare _recent: RecentJob[];
  declare _models: string[] | null;
  declare _notifying: boolean;

  constructor({ token, version, serverModels, timeoutMs = (request) => storedTimeoutMs(durationOf(request)), offerTimeoutMs = 5000, now = () => Date.now(),
    jobSettings = () => ({ separator: 'demucs', structureModel: 'auto' }) }: RemotePoolOptions) {
    this._token = token;
    this.version = version;
    this._serverModels = serverModels;
    this._timeoutMs = timeoutMs;
    this._jobSettings = jobSettings;
    this._offerTimeoutMs = offerTimeoutMs;
    this._now = now;
    this._workers = new Map();
    this._jobs = new Map();
    this._listeners = [];
    this._recent = [];
    this._models = null;
    this._notifying = false;
  }

  attach(io: Server): void {
    const ns = io.of(NAMESPACE);
    ns.use((socket, next) => {
      const expected = this._token();
      const presented = (socket.handshake.auth && socket.handshake.auth.token)
        || socket.handshake.headers['x-lightshow-worker-token'] || '';
      let refusal: string | null = null;
      if (!expected) refusal = 'Remote analysis is off: no worker token is set on this server';
      else if (!safeEqual(presented, expected)) refusal = presented ? 'Worker token refused' : 'This server requires a worker token';
      if (!refusal) return next();
      next(Object.assign(new Error(refusal), { data: { code: expected ? 'unauthorized' : 'disabled' } }));
    });
    ns.on('connection', (socket) => this._connected(socket));
  }

  httpRouter(): Router {
    const router = express.Router();
    router.use((req: Request, res: Response, next: NextFunction) => {
      if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'Cross-origin request refused' });
      const expected = this._token();
      if (expected && safeEqual(req.get('x-lightshow-worker-token'), expected)) return next();
      return res.status(401).json({ ok: false, error: 'Missing or invalid worker token' });
    });
    router.get('/jobs/:id/audio', (req: Request, res: Response) => this._sendAudio(req, res));
    // The job key is checked before a large body is read.
    router.post('/jobs/:id/result', (req: Request, res: Response, next: NextFunction) => {
      if (!this._jobFor(req)) return res.status(404).json({ ok: false, error: 'No such job running' });
      next();
    }, express.json({ limit: RESULT_LIMIT }), (req: Request, res: Response) => this._receive(req, res));
    router.use((_req: Request, res: Response) => res.status(404).json({ ok: false, error: 'Not found' }));
    return router;
  }

  /** GET /api/analysis/workers, behind the UI token like the rest of /api. */
  attachStatusRoute(app: Express, extra: () => Record<string, unknown> = () => ({})): void {
    app.get('/api/analysis/workers', (_req, res) => res.json({ ...this.status(), ...extra() }));
  }

  eligible(source: unknown): boolean {
    return typeof source === 'string' && path.isAbsolute(source) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(source);
  }

  idleWorker(): string | null {
    for (const [id, w] of this._workers) if (this._ready(w) && w.available && !w.job) return id;
    return null;
  }

  hasCompatible(): boolean {
    for (const w of this._workers.values()) if (this._ready(w) && (w.available || w.job)) return true;
    return false;
  }

  onChange(fn: () => void): void { this._listeners.push(fn); }

  run(workerId: string, request: RemoteRequest): RemoteHandle {
    const w = this._workers.get(workerId);
    if (!w || !this._ready(w) || w.job) throw new Error('that worker is not free');
    const stat = fs.statSync(request.source);
    if (!stat.isFile()) throw new Error(`${request.source} is not a file`);
    let resolve!: (analysis: Analysis) => void, reject!: (err: Error) => void;
    const result = new Promise<Analysis>((res, rej) => { resolve = res; reject = rej; });
    const job = {
      id: crypto.randomUUID(), key: crypto.randomBytes(24).toString('base64url'), worker: w, request,
      state: 'offered', offeredAt: this._now(), acceptedAt: null, bytes: 0, timer: null, resolve, reject,
    } as unknown as Job;
    job.handle = {
      id: job.id, worker: w.name as string, result, priority: request.priority,
      cancel: (reason: string) => this._end(job, 'cancelled', remoteError('cancelled', reason), { tell: reason }),
    };
    w.job = job;
    this._jobs.set(job.id, job);
    const offer = {
      id: job.id, key: job.key, version: this.version, ext: path.extname(request.source).toLowerCase(), bytes: stat.size,
      targetDurationSec: request.targetDurationSec, priority: request.priority, settings: this._jobSettings(),
    };
    w.socket.timeout(this._offerTimeoutMs).emit('job', offer, (err: Error | null, raw: unknown) => {
      if (this._jobs.get(job.id) !== job || job.state !== 'offered') return;
      const answer = answerSchema.safeParse(raw);
      if (err || !answer.success || !answer.data.accepted) {
        const why = err ? 'did not answer the job offer' : answer.success ? answer.data.reason || 'declined' : 'answered the offer unreadably';
        this._unavailable(w, why);
        this._end(job, 'declined', remoteError('declined', `${w.name} ${why}`));
        return;
      }
      job.state = 'running';
      job.acceptedAt = this._now();
      const limitMs = this._timeoutMs(request);
      job.timer = setTimeout(() => {
        const seconds = Math.round(limitMs / 1000);
        this._end(job, 'failed', remoteError('failed', `${w.name} timed out after ${seconds}s`), { tell: 'timed out' });
      }, limitMs);
      job.timer.unref?.();
      console.log(`[analyzer] remote ${w.name} took ${path.basename(request.source)} (${request.priority})`);
    });
    return job.handle;
  }

  async refreshModels(): Promise<void> {
    this._models = null;
    for (const w of this._workers.values()) if (w.name) await this._evaluate(w, { tell: true });
    this._changed();
  }

  disconnectAll(reason: string): void {
    for (const w of [...this._workers.values()]) {
      console.log(`[analyzer] remote ${w.name || w.address} disconnected: ${reason}`);
      w.socket.disconnect(true);
    }
  }

  status() {
    return {
      enabled: !!this._token(),
      version: this.version,
      models: this._models,
      workers: [...this._workers.values()].filter((w) => w.name).map((w) => ({
        name: w.name, address: w.address, connectedAt: new Date(w.connectedAt).toISOString(),
        version: w.version, device: w.device, models: w.models,
        compatible: !w.incompatible, incompatible: w.incompatible, available: w.available, reason: w.reason,
        job: w.job ? {
          tag: w.job.request.tag, file: path.basename(w.job.request.source), priority: w.job.request.priority, state: w.job.state,
          since: new Date(w.job.acceptedAt ?? w.job.offeredAt).toISOString(),
        } : null,
        stats: { ...w.stats, seconds: Math.round(w.stats.seconds * 10) / 10 },
      })),
      recent: [...this._recent],
    };
  }

  shutdown(): void {
    for (const job of [...this._jobs.values()]) this._end(job, 'cancelled', remoteError('cancelled', 'server shutting down'), { tell: 'server shutting down' });
  }

  _ready(w: WorkerRecord): boolean {
    return !!w.name && !w.incompatible && w.socket.connected;
  }

  // After the current step, once its job's promise has settled: the router never re-enters itself.
  _changed(): void {
    if (this._notifying) return;
    this._notifying = true;
    queueMicrotask(() => {
      this._notifying = false;
      for (const fn of this._listeners) {
        try { fn(); } catch (err) { console.warn(`[analyzer] remote: listener failed: ${messageOf(err)}`); }
      }
    });
  }

  _connected(socket: Socket): void {
    const w: WorkerRecord = {
      socket, name: null, address: plainAddress(socket.handshake.address), connectedAt: this._now(),
      version: null, device: null, models: null, available: false, reason: 'not introduced yet',
      incompatible: 'not introduced yet', job: null, stats: { jobs: 0, failed: 0, declined: 0, seconds: 0, bytes: 0 },
    };
    this._workers.set(socket.id, w);
    socket.on('hello', async (raw: unknown, ack?: (answer: unknown) => void) => {
      const hello = helloSchema.safeParse(raw);
      if (!hello.success) {
        if (typeof ack === 'function') ack({ ok: false, error: 'unreadable hello' });
        socket.disconnect(true);
        return;
      }
      for (const other of this._workers.values()) {
        if (other !== w && other.name === hello.data.name) {
          console.log(`[analyzer] remote ${other.name}: replaced by a new connection from ${w.address}`);
          other.socket.disconnect(true);
        }
      }
      Object.assign(w, {
        name: hello.data.name, version: hello.data.version, device: hello.data.device, models: hello.data.models,
        available: hello.data.available, reason: hello.data.available ? null : hello.data.reason ?? 'not ready',
      });
      await this._evaluate(w);
      const kind = w.device ? `${w.device.kind}${w.device.name ? ` ${w.device.name}` : ''}` : 'no device';
      console.log(`[analyzer] remote ${w.name} connected from ${w.address}: ${kind}, analysis ${w.version ?? 'not prepared yet'}`
        + `${w.incompatible ? `; cannot take jobs: ${w.incompatible}` : ''}`);
      if (typeof ack === 'function') ack(this._serverView(w));
      this._changed();
    });
    socket.on('status', async (raw: unknown) => {
      const update = statusSchema.safeParse(raw);
      if (!update.success || !w.name) return;
      const { available, reason, version, models, device } = update.data;
      const recheck = (version !== undefined && version !== w.version) || (models !== undefined && !sameSet(models ?? [], w.models ?? []));
      if (version !== undefined) w.version = version;
      if (models !== undefined) w.models = models;
      if (device !== undefined) w.device = device;
      if (available !== undefined) {
        if (available !== w.available || (reason ?? null) !== w.reason) {
          console.log(`[analyzer] remote ${w.name} ${available ? 'is ready for jobs' : `is not taking jobs: ${reason || 'busy'}`}`);
        }
        w.available = available;
        w.reason = available ? null : reason ?? 'busy';
      }
      if (recheck) await this._evaluate(w, { tell: true });
      this._changed();
    });
    socket.on('disconnect', (reason) => {
      this._workers.delete(socket.id);
      if (w.job) this._end(w.job, 'failed', remoteError('failed', `${w.name} disconnected (${reason})`));
      if (w.name) console.log(`[analyzer] remote ${w.name} disconnected (${reason})`);
      this._changed();
    });
  }

  _serverView(w: WorkerRecord) {
    return {
      ok: true, protocol: PROTOCOL, version: this.version, models: this._models,
      compatible: !w.incompatible, reason: w.incompatible, settings: this._jobSettings(),
    };
  }

  async _listModels(): Promise<string[] | null> {
    if (this._models) return this._models;
    try {
      const listed = await this._serverModels();
      this._models = listed ? [...listed].sort() : null;
    } catch (err) {
      console.warn(`[analyzer] remote: could not list this server's models: ${messageOf(err)}`);
      this._models = null;
    }
    return this._models;
  }

  async _evaluate(w: WorkerRecord, { tell = false } = {}): Promise<void> {
    const before = w.incompatible;
    const models = await this._listModels();
    if (w.version !== this.version) {
      w.incompatible = `its analysis code is ${w.version ?? 'unknown'}, this server's is ${this.version}`;
    } else if (!models) {
      w.incompatible = 'this server could not list its analysis models';
    } else if (!w.models || !sameSet(w.models.filter((m) => !GPU_EXTRAS.includes(m) || models.includes(m)), models)) {
      const has = w.models ?? [];
      const lacks = models.filter((m) => !has.includes(m));
      const extra = has.filter((m) => !models.includes(m) && !GPU_EXTRAS.includes(m));
      w.incompatible = `its models differ from this server's${lacks.length ? `: it lacks ${lacks.join(', ')}` : ''}`
        + `${extra.length ? `${lacks.length ? ' and' : ':'} has ${extra.join(', ')}` : ''}`;
    } else {
      w.incompatible = null;
    }
    if (w.incompatible !== before && w.name) {
      if (w.incompatible) console.warn(`[analyzer] remote ${w.name} cannot take jobs: ${w.incompatible}`);
      else if (before && tell) console.log(`[analyzer] remote ${w.name} now runs this server's analysis ${this.version}`);
      if (tell) w.socket.emit('server', this._serverView(w));
    }
  }

  _unavailable(w: WorkerRecord, reason: string): void {
    w.available = false;
    w.reason = reason;
  }

  _jobFor(req: Request): Job | null {
    const job = this._jobs.get(String(req.params.id));
    if (!job || !safeEqual(req.get('x-lightshow-job-key'), job.key) || !job.worker.socket.connected) return null;
    return job;
  }

  _sendAudio(req: Request, res: Response): void {
    const job = this._jobFor(req);
    if (!job) { res.status(404).json({ ok: false, error: 'No such job running' }); return; }
    let size: number;
    try { size = fs.statSync(job.request.source).size; } catch (_) {
      res.status(410).json({ ok: false, error: 'The audio is gone' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    const stream = fs.createReadStream(job.request.source);
    stream.on('error', () => res.destroy());
    stream.on('end', () => { job.bytes = size; });
    stream.pipe(res);
  }

  _receive(req: Request, res: Response): void {
    const job = this._jobFor(req);
    if (!job) { res.status(404).json({ ok: false, error: 'No such job running' }); return; }
    const body = resultSchema.safeParse(req.body);
    const w = job.worker;
    if (!body.success) {
      this._end(job, 'failed', remoteError('failed', `${w.name} posted an unreadable result`));
      res.status(400).json({ ok: false, error: 'Unreadable result' });
      return;
    }
    const { version, result, error, recycle, yielded, seconds } = body.data;
    if (version !== this.version) {
      w.incompatible = `its result came from analysis ${version}, this server's is ${this.version}`;
      console.warn(`[analyzer] remote ${w.name} cannot take jobs: ${w.incompatible}`);
      this._end(job, 'failed', remoteError('failed', `${w.name} ran other analysis code (${version})`));
      res.status(409).json({ ok: false, error: `This server runs analysis ${this.version}` });
      return;
    }
    if (error || !result || typeof result.schemaVersion !== 'string') {
      if (recycle || !error) this._unavailable(w, 'restarting its analyser');
      const why = error || 'no analysis document';
      this._end(job, yielded ? 'yielded' : 'failed', remoteError('failed', `${w.name}: ${why}`), { workerSeconds: seconds });
      res.json({ ok: true });
      return;
    }
    this._end(job, 'done', null, { analysis: result as Analysis, workerSeconds: seconds });
    if (recycle) this._unavailable(w, 'restarting its analyser');
    res.json({ ok: true });
  }

  _end(job: Job, outcome: Outcome, err: (Error & { remote?: Kind }) | null,
    { analysis, workerSeconds, tell }: { analysis?: Analysis; workerSeconds?: number; tell?: string } = {}): void {
    if (this._jobs.get(job.id) !== job) return;
    this._jobs.delete(job.id);
    if (job.timer) clearTimeout(job.timer);
    const w = job.worker;
    if (w.job === job) w.job = null;
    if (tell && w.socket.connected) {
      w.socket.emit('cancel', { id: job.id, reason: tell });
      this._unavailable(w, 'stopping a cancelled job');
    }
    const file = path.basename(job.request.source);
    const seconds = job.acceptedAt === null ? null : Math.round((this._now() - job.acceptedAt) / 100) / 10;
    if (outcome === 'done') {
      w.stats.jobs++;
      w.stats.seconds += seconds ?? 0;
      w.stats.bytes += job.bytes;
      console.log(`[analyzer] remote ${w.name} analysed ${file} (${job.request.priority}) in ${seconds}s`
        + `${workerSeconds !== undefined ? ` (${workerSeconds}s on the worker)` : ''}, ${(job.bytes / 1e6).toFixed(1)} MB of audio sent`);
    } else if (outcome === 'declined') {
      w.stats.declined++;
      console.log(`[analyzer] remote ${w.name} declined ${file}: ${messageOf(err)}`);
    } else if (outcome !== 'cancelled') {
      w.stats.failed++;
      console.warn(`[analyzer] remote ${w.name} gave ${file} back: ${messageOf(err)}`);
    }
    this._recent.unshift({
      worker: w.name as string, tag: job.request.tag, file, priority: job.request.priority, outcome,
      ...(err && outcome !== 'done' ? { detail: messageOf(err) } : {}), seconds,
      ...(workerSeconds !== undefined ? { workerSeconds } : {}), bytes: job.bytes, at: new Date(this._now()).toISOString(),
    });
    this._recent.length = Math.min(this._recent.length, RECENT_KEPT);
    if (err) job.reject(err);
    else job.resolve(analysis as Analysis);
    this._changed();
  }
}
