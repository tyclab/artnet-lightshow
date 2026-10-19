const acceptedCodes = new Set(['DISARMED', 'BUSY', 'INVALID', 'RATE_LIMIT', 'NO_LEASE', 'ACKNOWLEDGEMENT_REQUIRED', 'STALE']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.ceil(ms)));

/** The curtain panel's wire protocol: one fixture, a row-major RGB grid. */
export const panelProtocol = {
  events: { claim: 'pixel-input:claim', frame: 'pixel-input:frame', release: 'pixel-input:release' },
  claim: (pump) => ({ fixtureId: pump.fixtureId, width: pump.width, height: pump.height }),
  accepts: (pump, response) => response.format === 'rgb24' && response.order === 'row-major' && response.ttlMs === 2000 && Number.isFinite(response.maxFps) && response.maxFps >= 1,
  frame: (pump, lease, data) => ({ fixtureId: pump.fixtureId, leaseId: lease.id, data }),
  release: (pump, lease) => ({ fixtureId: pump.fixtureId, leaseId: lease.id }),
  image: (pump, image) => image && image.width === pump.width && image.height === pump.height && image.data instanceof Uint8Array && image.data.length === pump.width * pump.height * 3 ? image.data : null,
};

export class LeasePump {
  constructor({ transport, capture, target, fixtureId, width, height, fps = 44, now = () => performance.now(), wait = sleep, report = () => {}, protocol = panelProtocol }) {
    Object.assign(this, { transport, capture, target, fixtureId, width, height, fps, now, wait, report, protocol });
    this.generation = 0; this.lease = null; this.busy = false; this.retryAt = 0; this.failures = 0; this.frames = 0; this.stopped = false;
    this.nextCaptureAt = 0; this.nextSendAt = 0;
  }
  async release(lease, connectionId) {
    if (!lease || !this.transport.connected || this.transport.id !== connectionId) return;
    try { await this.transport.request(this.protocol.events.release, this.protocol.release(this, lease)); } catch {}
  }
  invalidate() {
    this.generation++;
    const lease = this.lease;
    this.lease = null;
    return this.release(lease, lease?.connectionId);
  }
  async stop() { this.stopped = true; await this.invalidate(); }
  backoff(reason) {
    this.retryAt = this.now() + Math.min(10_000, 1000 * 2 ** Math.min(this.failures++, 4));
    this.report(reason);
  }
  valid(generation, connectionId, key) {
    const target = this.target();
    return !this.stopped && generation === this.generation && this.transport.connected && connectionId === this.transport.id && target.ok && target.key === key;
  }
  async step() {
    if (this.busy || this.stopped) return;
    const target = this.target();
    if (!this.transport.connected || !target.ok) {
      await this.invalidate();
      this.nextCaptureAt = this.now() + 250;
      this.report(this.transport.connected ? target.reason : 'Lightshow disconnected');
      return;
    }
    if (this.lease && this.lease.key !== target.key) await this.invalidate();
    if (this.now() < this.retryAt || this.now() < this.nextCaptureAt) return;
    this.busy = true;
    const generation = this.generation, connectionId = this.transport.id, key = target.key;
    let failure = 'claimFailures';
    try {
      if (!this.lease) {
        const response = await this.transport.request(this.protocol.events.claim, this.protocol.claim(this, target));
        if (!response?.ok) { this.telemetry?.count('claimFailures'); this.backoff(acceptedCodes.has(response?.code) ? response.code : 'Pixel input unavailable'); return; }
        const lease = { id: response.leaseId, key, connectionId, claim: response };
        if (typeof lease.id !== 'string' || !lease.id) throw new Error('Missing pixel lease identity');
        if (!this.protocol.accepts(this, response)) {
          await this.release(lease, connectionId);
          throw new Error('Incompatible pixel input protocol');
        }
        if (!this.valid(generation, connectionId, key)) { await this.release(lease, connectionId); return; }
        this.lease = lease;
      }
      failure = 'captureFailures';
      const captureStarted = this.now();
      const image = await (this.telemetry ? this.telemetry.measure('capture', () => this.capture()) : this.capture());
      if (!this.valid(generation, connectionId, key)) { this.telemetry?.count('revokedFrames'); await this.invalidate(); return; }
      if (this.now() - captureStarted > 500) { failure = 'staleFrames'; throw new Error('Captured frame is stale'); }
      const data = this.protocol.image(this, image, this.lease);
      if (!data) throw new Error('Invalid captured pixels');
      const delay = this.nextSendAt - this.now();
      if (delay > 0) await this.wait(delay);
      if (!this.valid(generation, connectionId, key)) { this.telemetry?.count('revokedFrames'); await this.invalidate(); return; }
      if (this.now() - captureStarted > 500) { failure = 'staleFrames'; throw new Error('Captured frame is stale'); }
      const period = 1000 / Math.min(this.fps, this.lease.claim.maxFps);
      this.nextSendAt = this.now() + period;
      failure = 'ackFailures';
      const send = () => this.transport.request(this.protocol.events.frame, this.protocol.frame(this, this.lease, data));
      const response = await (this.telemetry ? this.telemetry.measure('ack', send) : send());
      if (!this.valid(generation, connectionId, key)) { await this.invalidate(); return; }
      if (!response?.ok) {
        this.telemetry?.count('rejectedFrames');
        await this.invalidate();
        this.backoff(acceptedCodes.has(response?.code) ? response.code : 'Pixel frame rejected');
        return;
      }
      this.nextCaptureAt = Math.max(captureStarted + period, this.now());
      this.failures = 0; this.frames++; this.report('Streaming');
    } catch {
      this.telemetry?.count(failure);
      await this.invalidate();
      this.backoff('Capture or pixel connection unavailable');
    } finally { this.busy = false; }
  }
}
