import { performance } from 'node:perf_hooks';
import '../src/shared/effects/index.ts';
import { V2_PRESETS } from '../src/shared/effects/v2/presets.ts';
import { kindOf } from '../src/shared/effects/registry.ts';
import { buildRoom } from '../src/shared/room.ts';
import { HD_MASTER_DEFAULTS } from '../src/shared/effects/types.ts';

const n = 3000, room = buildRoom(n, (i) => i % 50 / 49, (i) => Math.floor(i / 50) / 59, (i) => i % 17 / 16, null);
room.space = { x: Float32Array.from(room.X, (x) => x * 8 - 4), y: Float32Array.from(room.Z, (y) => y * 3),
  z: Float32Array.from(room.Y, (z) => z * 6 - 3), size: new Float32Array(n).fill(0.03), bounds: { width: 8, depth: 6, height: 3 },
  listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 }, anchors: { speakerLeft: { x: -2, y: 0.5, z: -2 }, speakerRight: { x: 2, y: 0.5, z: -2 } } };
const slots = [], lampOf = new Int32Array(n), cellAlong = new Float32Array(n);
let start = 0;
for (const count of [2400, 100, ...new Array(12).fill(40), ...new Array(20).fill(1)]) {
  const index = slots.length;
  slots.push(Array.from({ length: count }, (_, i) => start + i));
  lampOf.fill(index, start, start + count);
  for (let i = 0; i < count; i++) cellAlong[start + i] = i / Math.max(1, count - 1);
  start += count;
}
room.lamps = { slots, lampOf, cellAlong };
const colour = { r: 255, g: 64, b: 16, w: 0, a: 0, uv: 0 };
const out = Array.from({ length: n }, () => ({ colour, level: 0, strength: 0 }));
const frame = { beatPos: 0, bpm: 124, nowMs: 0, dtMs: 1000 / 44, anchorBeat: 0, palette: [colour], lookPalette: [colour],
  pictureFeatures: { palette: [colour], speed: 1, level: 1, expiresAt: 100000 },
  paletteOverride: null, roll: 0, audio: null, audioMode: 'tempo', master: { ...HD_MASTER_DEFAULTS },
  seed: [1, 2, 3, 4], acknowledged: true, hueStrobe: 'flash' };
let failed = false;
for (const preset of V2_PRESETS) {
  const def = kindOf(preset.spec.kind), f = { ...frame, spec: preset.spec }, state = def.init(preset.spec.params, room, f), times = [];
  for (let k = 0; k < 160; k++) {
    f.beatPos = k / 8; f.nowMs = f.beatPos * 60000 / f.bpm;
    const start = performance.now();
    def.render(preset.spec.params, state, room, f, out);
    if (k >= 40) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`${preset.id.padEnd(27)} p95 ${p95.toFixed(2)} ms`);
  if (p95 > 8) failed = true;
}
if (failed) process.exitCode = 1;
