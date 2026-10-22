import type { Colour } from '../types/rig.ts';
import type { PictureFrame, PictureImage } from '../types/picture.ts';

export interface PictureFeatures {
  palette: Colour[];
  speed: number;
  level: number;
  expiresAt: number;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const SAMPLE_COUNT = 256;

export class PictureFeatureExtractor {
  private previous: Float32Array | null = null;
  private stamp = -Infinity;
  private lease: string | null = null;
  private value: PictureFeatures | null = null;

  update(frame: PictureFrame | null, image: PictureImage | null, nowMs: number): PictureFeatures | null {
    if (!frame || frame.expiresAt <= nowMs) {
      this.previous = null; this.value = null; this.lease = null; this.stamp = -Infinity;
      return null;
    }
    if (this.lease === frame.leaseId && this.stamp === frame.expiresAt) return this.value;
    if (this.lease !== frame.leaseId) { this.previous = null; this.stamp = -Infinity; this.value = null; }
    this.lease = frame.leaseId;
    const data = image?.data ?? frame.data;
    const columns = image ? Math.min(image.width, Math.ceil(Math.sqrt(SAMPLE_COUNT * image.width / image.height))) : 0;
    const rows = image ? Math.min(image.height, Math.floor(SAMPLE_COUNT / columns)) : 0;
    const count = image ? columns * rows : Math.min(SAMPLE_COUNT, Math.floor(data.length / 3));
    const samples = new Float32Array(count * 3), mean = [0, 0, 0];
    const buckets = Array.from({ length: 13 }, () => ({ count: 0, r: 0, g: 0, b: 0 }));
    let lit = 0;
    for (let i = 0; i < count; i++) {
      const offset = image
        ? (Math.floor((Math.floor(i / columns) + 0.5) * image.height / rows) * image.width
          + Math.floor((i % columns + 0.5) * image.width / columns)) * 3
        : Math.floor(i * (data.length / 3) / count) * 3;
      const r = data[offset] / 255, g = data[offset + 1] / 255, b = data[offset + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
      for (let k = 0; k < 3; k++) { samples[i * 3 + k] = data[offset + k] / 255; mean[k] += samples[i * 3 + k] / count; }
      if (max < 0.03) continue;
      lit++;
      let hue = delta < 1e-6 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      hue /= 6;
      const bucket = buckets[delta / max < 0.1 ? 12 : Math.min(11, Math.floor(hue * 12))];
      bucket.count++; bucket.r += r / max * 255; bucket.g += g / max * 255; bucket.b += b / max * 255;
    }
    let change = 0;
    for (let i = 0; i < samples.length; i++) {
      samples[i] -= mean[i % 3];
      if (this.previous?.length === samples.length) change += Math.abs(samples[i] - this.previous[i]) / samples.length;
    }
    const dt = Number.isFinite(this.stamp) ? Math.max(1 / 120, Math.min(1, (frame.expiresAt - this.stamp) / 1000)) : 0;
    const motion = dt > 0 ? clamp(change / dt) : 0;
    const keep = dt > 0 ? Math.exp(-dt / 0.3) : 0;
    const palette = buckets.map((b, index) => ({ ...b, index })).filter((b) => b.count > 0)
      .sort((a, b) => b.count - a.count).slice(0, 4).sort((a, b) => a.index - b.index)
      .map((b) => ({ r: b.r / b.count, g: b.g / b.count, b: b.b / b.count, w: 0, a: 0, uv: 0 }));
    this.value = { palette, speed: (this.value?.speed ?? motion) * keep + motion * (1 - keep), level: lit > 0 ? 1 : 0, expiresAt: frame.expiresAt };
    this.previous = samples; this.stamp = frame.expiresAt;
    return this.value;
  }
}
