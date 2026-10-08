const acceptedCodes = new Set(['DISARMED', 'BUSY', 'INVALID', 'RATE_LIMIT', 'NO_LEASE', 'ACKNOWLEDGEMENT_REQUIRED']);

export class LeasePump {
  constructor({ transport, capture, target, fixtureId, width, height, now = () => performance.now(), report = () => {} }) {
    Object.assign(this, { transport, capture, target, fixtureId, width, height, now, report });
    this.generation = 0; this.lease = null; this.busy = false; this.retryAt = 0; this.failures = 0; this.frames = 0; this.stopped = false;
  }
  async release(lease, connectionId) {
    if (!lease || !this.transport.connected || this.transport.id !== connectionId) return;
    try { await this.transport.request('pixel-input:release', { fixtureId: this.fixtureId, leaseId: lease.id }); } catch {}
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
      this.report(this.transport.connected ? target.reason : 'Lightshow disconnected');
      return;
    }
    if (this.lease && this.lease.key !== target.key) await this.invalidate();
    if (this.now() < this.retryAt) return;
    this.busy = true;
    const generation = this.generation, connectionId = this.transport.id, key = target.key;
    try {
      if (!this.lease) {
        const response = await this.transport.request('pixel-input:claim', { fixtureId: this.fixtureId, width: this.width, height: this.height });
        if (!response?.ok) { this.backoff(acceptedCodes.has(response?.code) ? response.code : 'Pixel input unavailable'); return; }
        const lease = { id: response.leaseId, key, connectionId };
        if (typeof lease.id !== 'string' || !lease.id) throw new Error('Missing pixel lease identity');
        if (response.format !== 'rgb24' || response.order !== 'row-major' || response.ttlMs !== 2000 || !Number.isFinite(response.maxFps) || response.maxFps < 10) {
          await this.release(lease, connectionId);
          throw new Error('Incompatible pixel input protocol');
        }
        if (!this.valid(generation, connectionId, key)) { await this.release(lease, connectionId); return; }
        this.lease = lease;
      }
      const captureStarted = this.now();
      const image = await this.capture();
      if (!this.valid(generation, connectionId, key)) { await this.invalidate(); return; }
      if (this.now() - captureStarted > 500) throw new Error('Captured frame is stale');
      if (!image || image.width !== this.width || image.height !== this.height || !(image.data instanceof Uint8Array) || image.data.length !== this.width * this.height * 3) throw new Error('Invalid captured pixels');
      const response = await this.transport.request('pixel-input:frame', { fixtureId: this.fixtureId, leaseId: this.lease.id, data: image.data });
      if (!this.valid(generation, connectionId, key)) { await this.invalidate(); return; }
      if (!response?.ok) {
        await this.invalidate();
        this.backoff(acceptedCodes.has(response?.code) ? response.code : 'Pixel frame rejected');
        return;
      }
      this.failures = 0; this.frames++; this.report('Streaming');
    } catch {
      await this.invalidate();
      this.backoff('Capture or pixel connection unavailable');
    } finally { this.busy = false; }
  }
}
