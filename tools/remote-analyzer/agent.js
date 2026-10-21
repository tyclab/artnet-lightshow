import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { io as connect } from 'socket.io-client';
import { blockingApp } from './desktop.js';

export const AGENT_VERSION = '1';
const NAMESPACE = '/analysis-worker';
const HTTP_BASE = '/api/analysis-worker';
const TICK_MS = 5000;
const READY_TIMEOUT_MS = 5 * 60_000;
const ID_RE = /^[0-9a-f-]{36}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

export function validOffer(offer) {
  if (!offer || typeof offer !== 'object') return false;
  const { id, key, version, ext, bytes, targetDurationSec, settings } = offer;
  return ID_RE.test(String(id)) && KEY_RE.test(String(key)) && typeof version === 'string'
    && typeof ext === 'string' && /^(\.[a-z0-9]{1,8})?$/.test(ext) && Number.isInteger(bytes) && bytes > 0 && bytes < 2 ** 31
    && (targetDurationSec === null || (typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec)))
    && !!settings && ['demucs', 'bs-roformer'].includes(settings.separator) && ['auto', 'songformer', 'off'].includes(settings.structureModel);
}

/**
 * The worker side of remote analysis: connects out to the lightshow, prepares the analysis code the server runs,
 * says whether this PC can take work now, and runs one job at a time in the analysis container.
 */
export class Agent {
  constructor(config, { runtime, gpu, desktop = null, hold = null, connectSocket = connect, fetcher = fetch, log = console.log, now = Date.now,
    tickMs = TICK_MS } = {}) {
    Object.assign(this, { config, runtime, gpu, desktop, hold, connectSocket, fetcher, log, now, tickMs });
    this.socket = null; this.server = null; this.prepared = null; this.preparing = null; this.prepareError = null;
    this.job = null; this.proc = null; this.procEnv = null; this.ownMiB = 0; this.lastJobAt = now();
    this.sent = null; this.device = null; this.timer = null; this.stopped = false; this.lastRefusal = null;
    this.jobsDir = path.join(config.dataDir, 'jobs');
  }

  start() {
    fs.mkdirSync(this.jobsDir, { recursive: true });
    for (const name of fs.readdirSync(this.jobsDir)) fs.rmSync(path.join(this.jobsDir, name), { force: true });
    this.desktop?.run();
    const { server, token } = this.config;
    const socket = this.connectSocket(`${server.origin}${NAMESPACE}`, {
      path: server.socketPath, auth: { token }, transports: ['websocket'],
      reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 30_000,
    });
    this.socket = socket;
    socket.on('connect', () => { this.log(`Connected to ${server.base}`); this.hello().catch((err) => this.log(`Hello failed: ${messageOf(err)}`)); });
    socket.on('connect_error', (err) => {
      const why = err?.message || 'connection failed';
      if (why !== this.lastRefusal) { this.lastRefusal = why; this.log(`Lightshow refused or unreachable: ${why}`); }
    });
    socket.on('disconnect', (reason) => {
      this.log(`Disconnected (${reason})`);
      this.sent = null;
      if (this.job) this.abort('the connection to the server was lost', { post: false });
    });
    socket.on('server', (view) => this.serverView(view));
    socket.on('job', (offer, ack) => this.offer(offer, ack));
    socket.on('cancel', (message) => {
      if (this.job && message?.id === this.job.id) this.abort(`the server called it off (${message.reason || 'cancelled'})`, { post: false });
    });
    this.timer = setInterval(() => this.tick().catch((err) => this.log(`Check failed: ${messageOf(err)}`)), this.tickMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.job) this.abort('the worker is stopping', { post: true });
    await this.stopProcess('the worker is stopping');
    this.desktop?.stop();
    this.hold?.release();
    this.socket?.close();
  }

  async hello() {
    if (!this.device) {
      const card = await this.gpu();
      this.device = card.ok ? { kind: 'cuda', name: card.name, vramMiB: card.totalMiB } : null;
    }
    const decision = await this.decide();
    const ack = await this.socket.timeout(15_000).emitWithAck('hello', {
      protocol: 1, name: this.config.name, version: this.prepared?.version ?? null, models: this.prepared?.models ?? null,
      device: this.device, available: decision.available, reason: decision.reason, agent: AGENT_VERSION,
    });
    if (!ack?.ok) { this.log(`The server did not accept this worker: ${ack?.error ?? 'no answer'}`); return; }
    this.sent = decision;
    this.serverView(ack);
    if (!this.prepared || this.prepared.version !== ack.version) this.prepare(ack.version);
  }

  serverView(view) {
    if (!view || typeof view.version !== 'string') return;
    const before = this.server;
    this.server = view;
    if (before?.compatible !== view.compatible || before?.reason !== view.reason) {
      this.log(view.compatible ? `The server takes this worker's results (analysis ${view.version})`
        : `The server will not send jobs yet: ${view.reason}`);
    }
    if (this.prepared && view.version !== this.prepared.version && !this.preparing) this.prepare(view.version);
  }

  prepare(version) {
    if (this.preparing) return this.preparing;
    this.prepareError = null;
    this.log(`Preparing analysis ${version}`);
    this.preparing = (async () => {
      try {
        await this.stopProcess('the analysis code changed');
        this.prepared = await this.runtime.prepare(version);
        this.log(`Ready: analysis ${this.prepared.version}, models ${this.prepared.models.join(', ') || 'none'}`);
      } catch (err) {
        this.prepareError = messageOf(err);
        this.log(`Cannot prepare analysis ${version}: ${this.prepareError}`);
      } finally {
        this.preparing = null;
      }
      await this.report({ force: true });
    })();
    return this.preparing;
  }

  /** Whether this PC takes work now; the server judges the code and models itself. */
  async decide() {
    if (this.preparing) return { available: false, reason: 'preparing the analysis environment' };
    if (!this.prepared) return { available: false, reason: this.prepareError || 'not prepared' };
    const reading = this.desktop?.latest() ?? null;
    const app = blockingApp(reading, this.config.allowFullscreen);
    if (app) return { available: false, reason: `a fullscreen program is in front (${app})` };
    if (this.job) return { available: true, reason: null };
    const card = await this.gpu();
    if (!card.ok) return { available: false, reason: 'the GPU does not answer (nvidia-smi)' };
    const others = card.usedMiB - (this.proc ? this.ownMiB : 0);
    if (others > this.config.maxOtherVramMiB) return { available: false, reason: `other programs use ${others} MiB of the GPU's memory` };
    return { available: true, reason: null };
  }

  async report({ force = false } = {}) {
    if (!this.socket?.connected || !this.sent) return;
    const decision = await this.decide();
    const versionChanged = this.sent.version !== this.prepared?.version;
    if (!force && !versionChanged && decision.available === this.sent.available && decision.reason === this.sent.reason) return;
    const status = { ...decision, version: this.prepared?.version ?? null, models: this.prepared?.models ?? null };
    this.sent = status;
    this.socket.emit('status', status);
  }

  async tick() {
    if (this.stopped) return;
    const app = blockingApp(this.desktop?.latest() ?? null, this.config.allowFullscreen);
    if (app && this.job) this.abort(`a fullscreen program came to the front (${app})`, { post: true, yielded: true });
    if (!this.job && this.proc) {
      const idleMin = (this.now() - this.lastJobAt) / 60_000;
      if (app) await this.stopProcess(`${app} is in front`);
      else if (idleMin >= this.config.idleStopMin) await this.stopProcess(`idle for ${Math.round(idleMin)} min`);
    }
    await this.report();
  }

  async offer(offer, ack) {
    if (typeof ack !== 'function') return;
    let refusal = null;
    if (!validOffer(offer)) refusal = 'the offer was unreadable';
    else if (this.job) refusal = 'already running a job';
    else if (!this.prepared || offer.version !== this.prepared.version) refusal = 'not prepared for this analysis version';
    else {
      const decision = await this.decide();
      if (!decision.available) refusal = decision.reason;
    }
    if (refusal || this.job) {
      ack({ accepted: false, reason: refusal || 'already running a job' });
      return;
    }
    this.job = { id: offer.id, key: offer.key, file: path.join(this.jobsDir, `${offer.id}${offer.ext}`), started: this.now(), aborted: null };
    ack({ accepted: true });
    this.run(this.job, offer).catch((err) => this.log(`Job ${offer.id} ended badly: ${messageOf(err)}`));
  }

  headers(job, extra = {}) {
    return { 'X-Lightshow-Worker-Token': this.config.token, 'X-Lightshow-Job-Key': job.key, ...extra };
  }

  async run(job, offer) {
    this.hold?.acquire();
    const label = `${offer.priority} job ${offer.id.slice(0, 8)}`;
    try {
      this.log(`Took the ${label} (${(offer.bytes / 1e6).toFixed(1)} MB${offer.targetDurationSec ? `, target ${Math.round(offer.targetDurationSec)}s` : ''})`);
      await this.download(job, offer);
      const proc = await this.process(offer.settings);
      if (job.aborted) return;
      const reply = await proc.request(`/jobs/${path.basename(job.file)}`, offer.targetDurationSec);
      if (job.aborted) return;
      const seconds = Math.round((this.now() - job.started) / 100) / 10;
      const body = reply.error
        ? { version: this.prepared.version, error: String(reply.error).slice(0, 4000), recycle: !!reply.recycle, seconds }
        : { version: this.prepared.version, result: reply.result, recycle: !!reply.recycle, seconds };
      await this.post(job, body);
      this.log(reply.error ? `The ${label} failed in the analyser: ${String(reply.error).slice(0, 200)}` : `Analysed the ${label} in ${seconds}s`);
      if (reply.recycle) await this.stopProcess('the GPU faulted');
    } catch (err) {
      if (!job.aborted) {
        this.log(`The ${label} failed: ${messageOf(err)}`);
        await this.post(job, { version: this.prepared?.version ?? '', error: messageOf(err).slice(0, 4000) }).catch(() => {});
        await this.stopProcess('a job failed');
      }
    } finally {
      fs.rmSync(job.file, { force: true });
      if (this.job === job) this.job = null;
      this.lastJobAt = this.now();
      this.hold?.release();
      await this.report({ force: true });
    }
  }

  async download(job, offer) {
    const response = await this.fetcher(`${this.config.server.base}${HTTP_BASE}/jobs/${offer.id}/audio`,
      { headers: this.headers(job), redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`the audio download answered ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(job.file, { mode: 0o600 }));
    const size = fs.statSync(job.file).size;
    if (size !== offer.bytes) throw new Error(`the audio arrived with ${size} of ${offer.bytes} bytes`);
  }

  async post(job, body) {
    const response = await this.fetcher(`${this.config.server.base}${HTTP_BASE}/jobs/${job.id}/result`, {
      method: 'POST', redirect: 'error', body: zlib.gzipSync(Buffer.from(JSON.stringify(body))),
      headers: this.headers(job, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 409) this.log('The server runs other analysis code now; reconnecting to prepare it');
    if (!response.ok && response.status !== 404) throw new Error(`the server answered ${response.status} to the result`);
  }

  envFor(settings) {
    return {
      ARTNET_USE_BS_ROFORMER: settings.separator === 'bs-roformer' ? '1' : '0',
      ARTNET_STRUCTURE_MODEL: settings.structureModel,
      ARTNET_GPU_MEMORY: this.config.gpuMemory,
    };
  }

  /** The warm analysis container for these settings; another separator or structure model needs a new one. */
  async process(settings) {
    const env = this.envFor(settings);
    const key = JSON.stringify(env);
    if (this.proc && !this.proc.exited && this.procEnv === key) return this.proc;
    await this.stopProcess('the analysis settings changed');
    const before = await this.gpu();
    const proc = this.runtime.startProcess(this.prepared, env);
    this.proc = proc;
    this.procEnv = key;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the analyser did not get ready in time')), READY_TIMEOUT_MS); });
    try { await Promise.race([proc.ready, timeout]); } finally { clearTimeout(timer); }
    const after = await this.gpu();
    this.ownMiB = before.ok && after.ok ? Math.max(0, after.usedMiB - before.usedMiB) : 0;
    return proc;
  }

  async stopProcess(reason) {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null; this.procEnv = null; this.ownMiB = 0;
    if (!proc.exited) this.log(`Stopping the analysis container: ${reason}`);
    await proc.stop();
  }

  abort(reason, { post = false, yielded = false } = {}) {
    const job = this.job;
    if (!job || job.aborted) return;
    job.aborted = reason;
    this.log(`Gave up the job ${job.id.slice(0, 8)}: ${reason}`);
    if (post) this.post(job, { version: this.prepared?.version ?? '', error: reason, ...(yielded ? { yielded: true } : {}) }).catch(() => {});
    void this.stopProcess(reason);
  }
}
