import fs from 'node:fs/promises';
import path from 'node:path';

export const TELEMETRY_INTERVAL_MS = 30_000;
const MAX_LOG_BYTES = 1024 * 1024;
const round = value => Math.round(value * 100) / 100;

export class PumpTelemetry {
  constructor(pump, output, now = () => performance.now()) {
    Object.assign(this, { pump, output, now });
    this.at = now(); this.frames = pump.frames;
    this.reset();
  }
  reset() {
    this.capture = { count: 0, total: 0, max: 0 };
    this.ack = { count: 0, total: 0, max: 0 };
    this.counts = { captureFailures: 0, ackFailures: 0, claimFailures: 0, rejectedFrames: 0, staleFrames: 0, revokedFrames: 0, idlePauses: 0 };
  }
  count(name) { this.counts[name]++; }
  async measure(name, operation) {
    const started = this.now();
    try { return await operation(); }
    finally {
      const duration = this.now() - started, sample = this[name];
      sample.count++; sample.total += duration; sample.max = Math.max(sample.max, duration);
    }
  }
  snapshot() {
    const now = this.now(), intervalMs = now - this.at, frames = this.pump.frames - this.frames;
    const active = !this.pump.stopped && this.pump.transport.connected && !!this.pump.lease && this.pump.target().ok;
    const summary = sample => ({ samples: sample.count, mean: sample.count ? round(sample.total / sample.count) : null, max: sample.count ? round(sample.max) : null });
    const record = {
      event: 'browser_visuals_telemetry', time: new Date().toISOString(), output: this.output,
      active, reason: active ? null : this.pump.waiting ?? null, intervalMs: round(intervalMs), acceptedFrames: frames,
      fps: active || frames || this.capture.count ? round(frames * 1000 / Math.max(1, intervalMs)) : null,
      requestedFps: this.pump.fps, negotiatedFps: this.pump.lease ? Math.min(this.pump.fps, this.pump.lease.claim.maxFps) : null,
      captureMs: summary(this.capture), ackMs: summary(this.ack), ...this.counts,
    };
    this.at = now; this.frames = this.pump.frames; this.reset();
    return record;
  }
}

// One active file and one backup; a slow or failed disk never queues capture work.
export function telemetryWriter(file, warn = () => {}, maxBytes = MAX_LOG_BYTES) {
  let writing = false, warned = false;
  return async records => {
    if (writing) return;
    writing = true;
    try {
      const data = records.map(record => JSON.stringify(record) + '\n').join('');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.stat(file).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size && size + Buffer.byteLength(data) > maxBytes) {
        await fs.rm(file + '.1', { force: true });
        await fs.rename(file, file + '.1');
      }
      await fs.appendFile(file, data, { mode: 0o600 });
      warned = false;
    } catch {
      if (!warned) { warned = true; try { warn('Browser telemetry file unavailable'); } catch {} }
    } finally { writing = false; }
  };
}

export function startTelemetry(feeds, file, log = console.log, extra = () => ({})) {
  if (!feeds.length) return () => {};
  const emit = file ? telemetryWriter(file, log) : records => { for (const record of records) log(JSON.stringify(record)); };
  const metrics = feeds.map(([output, pump]) => (pump.telemetry = new PumpTelemetry(pump, output)));
  const timer = setInterval(() => {
    try { void Promise.resolve(emit(metrics.map(metric => ({ ...metric.snapshot(), ...extra() })))).catch(() => {}); } catch {}
  }, TELEMETRY_INTERVAL_MS);
  timer.unref();
  return () => { clearInterval(timer); for (const [, pump] of feeds) pump.telemetry = null; };
}
