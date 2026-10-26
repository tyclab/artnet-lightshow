import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { buffer, logger } from './log.ts';
import { engineStatus } from './engine.ts';
import { hrtimeMs } from './frame-clock.ts';
import * as output from './output.ts';
import { isArmed } from './armed.ts';
import { state, voices, getSequenceStatus } from './state.ts';
import { KINDS } from '../shared/effects/registry.ts';
import { supervision } from './supervised.ts';
import { wledStatus } from './wled-watch.ts';
import type { Supervision } from './supervised.ts';
import type { EngineStatus } from './engine.ts';
import type { WledBoardStatus } from './wled-watch.ts';
import type { HueStatus } from './hue.ts';

export type HealthStatus = 'ok' | 'degraded' | 'failing';

export interface Problem {
  level: 'info' | 'warn' | 'error';
  what: string;
}

export interface EventLoopDelay {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** What assess() judges; health() gathers it from the running server. */
export interface HealthInputs {
  engine: Partial<EngineStatus> & { running: boolean };
  eventLoop: EventLoopDelay | null;
  rssMb: number;
  errors: { count: number; last: { component: string | null; msg: string } | null };
  supervisor: Supervision;
  auto: { status: string; error: string | null } | null;
  /** Whether anything leaves the machine (armed.ts); left out, nothing is said about it. */
  armed?: boolean;
  wled?: WledBoardStatus[];
  hue?: HueStatus[];
}

const WINDOW_MS = 30_000;
const RECENT_ERRORS_MS = 10 * 60_000;
const STALL_MS = 100;
const LATE_SHARE = 0.05;
const RSS_MB = 1536;
const performanceLog = logger('performance');

/** What is wrong, in words, and the status it adds up to. */
export function assess(inputs: HealthInputs): { status: HealthStatus; problems: Problem[] } {
  const problems: Problem[] = [];
  const { engine, eventLoop, errors, supervisor, auto } = inputs;

  if (!engine.running) problems.push({ level: 'error', what: 'The engine is not running: nothing is going out to the rig.' });
  if (engine.fellBack) problems.push({ level: 'warn', what: 'The engine could not run on its own thread and fell back to the main one.' });
  const frames = engine.frames || 0;
  if (frames > 0 && (engine.lateFrames || 0) / frames > LATE_SHARE) {
    problems.push({ level: 'warn', what: `${Math.round(((engine.lateFrames || 0) / frames) * 100)}% of recent frames went out late.` });
  }
  if (eventLoop && eventLoop.p99Ms > STALL_MS) {
    problems.push({ level: 'warn', what: `The main thread stalled for up to ${Math.round(eventLoop.maxMs)} ms: the page and controllers answer late.` });
  }
  if (inputs.rssMb > RSS_MB) problems.push({ level: 'warn', what: `The server is using ${Math.round(inputs.rssMb)} MB of memory.` });
  if (errors.count) {
    const last = errors.last ? ` The last: ${errors.last.component ? `[${errors.last.component}] ` : ''}${errors.last.msg.split('\n')[0].slice(0, 160)}` : '';
    problems.push({ level: 'warn', what: `${errors.count} error${errors.count === 1 ? '' : 's'} logged in the last ten minutes.${last}` });
  }
  if (auto && auto.status === 'error' && auto.error) problems.push({ level: 'warn', what: `The auto show: ${auto.error}` });
  for (const board of inputs.wled || []) if (board.problem) problems.push({ level: 'warn', what: `${board.problem}.` });
  for (const bridge of inputs.hue || []) if (inputs.armed !== false && bridge.enabled && bridge.configured && bridge.status === 'failed') {
    problems.push({ level: 'warn', what: `Hue ${bridge.label || bridge.id}: ${bridge.error || 'The entertainment stream failed.'}` });
  }
  // Disarmed explains a dark rig without marking a healthy engine as degraded.
  if (inputs.armed === false) problems.push({ level: 'info', what: 'The outputs are disarmed: nothing goes out to the rig until they are armed.' });
  if (supervisor.restarts > 0) {
    const why = supervisor.lastExit ? ` The last: ${supervisor.lastExit.reason}.` : '';
    problems.push({ level: 'info', what: `Restarted ${supervisor.restarts} time${supervisor.restarts === 1 ? '' : 's'} by the supervisor.${why}` });
  }

  const status: HealthStatus = problems.some((p) => p.level === 'error') ? 'failing'
    : problems.some((p) => p.level === 'warn') ? 'degraded' : 'ok';
  return { status, problems };
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let lastWindow: EventLoopDelay | null = null;
const startedAt = Date.now();

// Each sample is the gap between ticks of a timer this often, so the timer's own period is not delay.
export const LOOP_RESOLUTION_MS = 10;
const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);
export const loopDelayOf = (h: Pick<NonNullable<typeof histogram>, 'count' | 'percentile' | 'max'>): EventLoopDelay | null => (h.count
  ? { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) } : null);

const metric = (value: number | undefined): number | null => Number.isFinite(value) ? value! : null;

// Whitelist scalars: health() also contains device addresses and recent error text.
export function performanceSample(
  engine: EngineStatus,
  eventLoop: EventLoopDelay | null,
  memory: Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>,
  armed: boolean,
  previous: EngineStatus | null,
  nowMs = hrtimeMs(),
) {
  const elapsed = (engine.sampledAtMs ?? NaN) - (previous?.sampledAtMs ?? NaN);
  const frames = (engine.totalFrames ?? NaN) - (previous?.totalFrames ?? NaN);
  const skipped = (engine.skippedFramesTotal ?? NaN) - (previous?.skippedFramesTotal ?? NaN);
  const continuous = engine.running && previous?.running && engine.thread === previous.thread
    && metric(engine.startedAtMs) !== null && engine.startedAtMs === previous.startedAtMs
    && Number.isFinite(elapsed) && elapsed > 0 && frames >= 0 && skipped >= 0;
  return {
    armed,
    engineRunning: engine.running,
    engineThread: engine.thread,
    engineFallback: !!engine.fellBack,
    targetFps: engine.rate,
    actualFps: continuous ? Math.round(frames * 100_000 / elapsed) / 100 : null,
    intervalMs: continuous ? Math.round(elapsed) : null,
    intervalSkipped: continuous ? skipped : null,
    engineSampleAgeMs: metric(engine.sampledAtMs) === null ? null : Math.max(0, Math.round(nowMs - engine.sampledAtMs!)),
    windowFrames: metric(engine.frames),
    lateFrames: metric(engine.lateFrames),
    skippedFramesTotal: metric(engine.skippedFramesTotal),
    renderP50Ms: metric(engine.renderMs?.p50),
    renderP95Ms: metric(engine.renderMs?.p95),
    renderMaxMs: metric(engine.renderMs?.max),
    lateP50Ms: metric(engine.lateMs?.p50),
    lateP95Ms: metric(engine.lateMs?.p95),
    lateMaxMs: metric(engine.lateMs?.max),
    eventLoopP50Ms: eventLoop?.p50Ms ?? null,
    eventLoopP99Ms: eventLoop?.p99Ms ?? null,
    eventLoopMaxMs: eventLoop?.maxMs ?? null,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

/** Watch the main thread's event loop from now on, a window at a time. */
export function startHealthMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  histogram.enable();
  const h = histogram;
  let previous: EngineStatus | null = null;
  setInterval(() => {
    lastWindow = loopDelayOf(h) || lastWindow;
    h.reset();
    try {
      const engine = engineStatus();
      const sample = performanceSample(engine, lastWindow, process.memoryUsage(), isArmed(), previous);
      previous = engine;
      performanceLog.info(sample, 'Periodic performance summary');
    } catch (_) { /* Telemetry must not interrupt the show. */ }
  }, WINDOW_MS).unref();
}

/** The event loop's delay over the last window (or this one, before the first ends). */
function eventLoopDelay(): EventLoopDelay | null {
  return lastWindow || (histogram ? loopDelayOf(histogram) : null);
}

let version: string | null = null;
function appVersion(): string {
  if (version === null) {
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version);
    } catch (_) {
      version = 'unknown';
    }
  }
  return version;
}

/** The auto show, as far as health needs to know it. */
export interface HealthDeps {
  autoShow?: { status?: string; error?: string | null; running?: boolean } | null;
}

/** The server's health now. */
export function health({ autoShow = null }: HealthDeps = {}) {
  const engine = engineStatus();
  const memory = process.memoryUsage();
  const since = Date.now() - RECENT_ERRORS_MS;
  const recentErrors = buffer.since(0, { level: 'error', limit: 1000 }).filter((e) => !e.previous && e.time >= since);
  const lastError = recentErrors.at(-1) || null;
  const inputs: HealthInputs = {
    engine,
    eventLoop: eventLoopDelay(),
    rssMb: memory.rss / 1024 / 1024,
    errors: { count: recentErrors.length, last: lastError && { component: lastError.component, msg: lastError.msg } },
    supervisor: supervision(),
    auto: autoShow ? { status: String(autoShow.status || 'idle'), error: autoShow.error ?? null } : null,
    armed: isArmed(),
    wled: wledStatus(),
    hue: output.getHueStatus(),
  };
  const { status, problems } = assess(inputs);
  return {
    ok: status !== 'failing',
    status,
    problems,
    version: appVersion(),
    node: process.version,
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    uptimeS: Math.round(process.uptime()),
    supervisor: inputs.supervisor,
    engine,
    eventLoop: inputs.eventLoop,
    memory: { rssMb: Math.round(inputs.rssMb), heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024) },
    outputs: {
      armed: inputs.armed,
      artnet: { enabled: state.artnet.enabled !== false, host: state.artnet.host },
      hue: inputs.hue,
      wled: inputs.wled,
    },
    auto: autoShow ? { status: inputs.auto?.status, running: !!autoShow.running, error: inputs.auto?.error ?? null } : null,
    log: { errors10m: recentErrors.length, lastError },
    // Diagnostic only: none of these moves the status.
    counts: counts(),
  };
}

/** Effect kinds registered, voices playing, and the sequence loaded and playing. */
function counts() {
  const seq = getSequenceStatus() as { loaded?: unknown; playing?: unknown } | null;
  return {
    effects: KINDS.size,
    voices: voices.list().length,
    sequence: { loaded: seq?.loaded ? 1 : 0, playing: seq?.playing ? 1 : 0 },
  };
}
