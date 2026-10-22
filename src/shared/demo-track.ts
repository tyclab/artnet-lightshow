import type { PreviewAudioSource } from './preview.ts';
import type { AudioFrame } from './effects/audio-frame.ts';

export const DEMO_BPM = 124;
export const DEMO_BEATS = 64;
export const DEMO_DURATION_MS = DEMO_BEATS * 60000 / DEMO_BPM;
export const DEMO_SECTIONS = ['build', 'drop', 'breakdown', 'groove'] as const;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export function demoPosition(positionMs: number) {
  const beat = Math.max(0, Math.min(DEMO_BEATS - 1e-6, positionMs * DEMO_BPM / 60000));
  const section = DEMO_SECTIONS[Math.floor(beat / 16)];
  return { beat, section, progress: (beat % 16) / 16 };
}

export function demoFrameAt(positionMs: number): AudioFrame {
  const { beat, section, progress } = demoPosition(positionMs);
  const pulse = (rate: number, decay: number) => Math.exp(-((beat * rate) % 1) * decay);
  const level = section === 'build' ? 0.2 + 0.75 * progress : section === 'drop' ? 1 : section === 'breakdown' ? 0.18 : 0.65;
  const bass = clamp(level * pulse(1, 5));
  const mid = clamp(level * (0.2 + 0.6 * pulse(0.5, 3)));
  const high = clamp(level * pulse(section === 'build' && progress > 0.5 ? 4 : 2, 9));
  const full = clamp(0.6 * bass + 0.25 * mid + 0.15 * high);
  const hit = [bass, mid, high].map((v) => v > 0.4);
  return {
    t: positionMs, generation: 1, rms: full / 8, power: full * 0.001,
    dominantHz: 80 + 1800 * ((beat / 16) % 1), party: { full, bass, mid, high },
    disco: { hit, gate: [0.15, 0.15, 0.15], level: [bass, mid, high], peakHit: hit[0],
      neural: { mainFrequency: (beat / 16) % 1, amplitude: full } },
    spl: { db: -60 + full * 50, level: full, beat: bass > 0.4 ? 'loud' : 'quiet',
      section: section === 'drop' ? 'loud' : section === 'breakdown' ? 'quiet' : 'soft',
      eventT: Math.floor(beat) * 60000 / DEMO_BPM },
  };
}

export const DEMO_AUDIO_SOURCE: PreviewAudioSource = Object.freeze({
  frameAt: demoFrameAt,
  pictureAt(positionMs: number) {
    const { progress, section } = demoPosition(positionMs);
    return { palette: [{ r: 10, g: 120, b: 255 }, { r: 255, g: 30, b: 110 }, { r: 255, g: 180, b: 0 }],
      speed: section === 'drop' ? 1 : section === 'breakdown' ? 0.1 : 0.2 + progress * 0.6,
      level: section === 'breakdown' ? 0.3 : 0.9, expiresAt: positionMs + 100 };
  },
  modulationAt(positionMs: number) {
    const { section, progress } = demoPosition(positionMs);
    const { bass, mid, high } = demoFrameAt(positionMs).party;
    return { section, sectionProgress: progress, stems: { bass, drums: bass, vocals: mid, hats: high } };
  },
});
