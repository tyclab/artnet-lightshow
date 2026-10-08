export const CAPTURE_MS = 12000;

export class BpmCaptureSession {
  constructor() { this.samples = []; this.seen = null; this.source = null; this.polls = 0; }

  add(input, elapsedMs) {
    this.polls++;
    const reading = input?.reading;
    if (!input?.listening || !reading || !Number.isFinite(reading.t)) return;
    if (this.source !== null && (input.source !== this.source || reading.t < this.seen)) {
      this.samples = []; this.polls = 1; this.seen = null;
    }
    this.source = input.source;
    if (reading.t === this.seen) return;
    this.seen = reading.t;
    if (!reading.locked || !Number.isFinite(reading.bpm) || reading.bpm < 20 || reading.bpm > 300) return;
    this.samples.push({ bpm: reading.bpm, at: elapsedMs });
  }

  result() {
    const sorted = this.samples.map((s) => s.bpm).sort((a, b) => a - b);
    if (!sorted.length) return { bpm: null, confidence: 0, ready: false, samples: 0 };
    const median = sorted[Math.floor(sorted.length / 2)];
    const stable = this.samples.filter((s) => Math.abs(s.bpm - median) <= median * 0.03);
    const span = stable.length ? stable.at(-1).at - stable[0].at : 0;
    // This score measures observed lock and consistency, not detector probability.
    const confidence = stable.length / Math.max(1, this.polls) * Math.min(1, span / 8000);
    return { bpm: Math.round(median * 10) / 10, confidence, samples: stable.length,
      ready: stable.length >= 8 && span >= 4000 && confidence >= 0.7 };
  }
}
