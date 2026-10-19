// Milliseconds: a flash spans two 44 Hz render frames; minimum slots bound its cadence.
const FLASH_MS = 45;
const FLASH_MAX_MS = 80;
const MIN_SLOT_MS = 90;
const DEFAULT_BPM = 120;
const frac = (v: number): number => v - Math.floor(v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
function scatter(i: number, seed: number): number {
  let h = Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(seed + 7, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function flashMsOf(slotMs: number): number {
  return Math.min(FLASH_MAX_MS, Math.max(FLASH_MS, 0.35 * slotMs));
}
function flashLit(phase: number, slotMs: number): boolean {
  return phase * slotMs < flashMsOf(slotMs) + 1e-6;
}
const rampUp = (q: number): number => q * q;
const rampDown = (q: number): number => (1 - q) * (1 - q);
const swell = (q: number): number => {
  const s = Math.sin(Math.PI * q);
  return s * s;
};
const swellOnTheBeat = (q: number): number => {
  const c = Math.cos(Math.PI * q);
  return c * c;
};
const RAMP_BEATS = [4, 2, 1, 1 / 2, 1 / 4];
const RAMP_MIN_MS = 120;
const RANDOM_BEATS = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16];
const BURST_BEATS = [8, 4, 2, 1];
const BURST_MIN_MS = 400;
function cycleBeats(raw: number, ladder: readonly number[], bpm: number, minMs: number): number {
  const rung = Math.min(ladder.length - 1, Math.floor((Math.max(0, Math.min(255, raw)) / 256) * ladder.length));
  const beatMs = 60000 / bpm;
  let beats = ladder[rung];
  while (beats * beatMs < minMs && beats < 64)
    beats *= 2;
  return beats;
}
const RANDOM_RAMP_DENSITY = 0.7;
const RANDOM_FLASH_DENSITY = 0.55;
function swellsIn(cycle: number, light: number): boolean {
  return scatter(light, cycle * 3) < RANDOM_RAMP_DENSITY;
}
function randomSwell(shape: (q: number) => number, t: number, light: number): number {
  const cycle = Math.floor(t);
  if (!swellsIn(cycle, light))
    return 0;
  const length = 0.5 + 0.5 * scatter(light, cycle * 3 + 1);
  const start = scatter(light, cycle * 3 + 2) * (1 - length);
  const q = (t - cycle - start) / length;
  return q >= 0 && q < 1 ? shape(q) : 0;
}
function randomFlash(t: number, slotMs: number, light: number): number {
  const slot = Math.floor(t);
  if (scatter(light, slot) >= RANDOM_FLASH_DENSITY)
    return 0;
  const flash = flashMsOf(slotMs);
  const room = Math.max(0, 1 - flash / slotMs);
  const into = (t - slot - scatter(light, slot + 104729) * room) * slotMs;
  return into >= 0 && into < flash ? 1 : 0;
}
function burst(t: number, cycle: number, beatMs: number, slotMs = MIN_SLOT_MS): number {
  const into = frac(t) * cycle;
  let length = Math.max(0.5, Math.min(2, cycle / 4));
  if (slotMs > MIN_SLOT_MS)
    length = Math.min(cycle, Math.max(length, (2 * slotMs) / beatMs));
  if (into >= length)
    return 0;
  const lengthMs = length * beatMs;
  const flashes = Math.max(2, Math.floor(lengthMs / slotMs));
  const pos = (into / length) * flashes;
  return flashLit(frac(pos), lengthMs / flashes) ? 1 : 0;
}
type Program = (t: number, cycle: number, beatMs: number, light: number, slotMs: number) => number;
interface StrobeProgram {
  ladder: readonly number[];
  minMs: number;
  draw: Program;
}
const PROGRAMS: Record<string, StrobeProgram> = {
  'ramp-up-down': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t) => swellOnTheBeat(frac(t)) },
  'ramp-up-down-rnd': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t, _c, _b, light) => randomSwell(swell, t, light) },
  'ramp-up': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t) => rampUp(frac(t)) },
  'ramp-up-rnd': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t, _c, _b, light) => randomSwell(rampUp, t, light) },
  'ramp-down': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t) => rampDown(frac(t)) },
  'ramp-down-rnd': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t, _c, _b, light) => randomSwell(rampDown, t, light) },
  random: {
    ladder: RANDOM_BEATS, minMs: MIN_SLOT_MS,
    draw: (t, cycle, beatMs, light) => randomFlash(t, cycle * beatMs, light),
  },
  break: { ladder: BURST_BEATS, minMs: BURST_MIN_MS, draw: (t, cycle, beatMs, _light, slotMs) => burst(t, cycle, beatMs, slotMs) },
};
const DRAWN_STROBE_FUNCTIONS = Object.keys(PROGRAMS);
function drawnByTheShow(fnId: string): boolean {
  return Object.hasOwn(PROGRAMS, fnId);
}
function strobeLevel(fnId: string, raw: number, beatPos: number, bpm: number | null | undefined, light: number, minMs = 0): number {
  const program = Object.hasOwn(PROGRAMS, fnId) ? PROGRAMS[fnId] : null;
  if (!program)
    return 1;
  const tempo = bpm && bpm > 0 ? bpm : DEFAULT_BPM;
  const cycle = cycleBeats(raw, program.ladder, tempo, Math.max(program.minMs, minMs));
  return clamp01(program.draw(beatPos / cycle, cycle, 60000 / tempo, light, Math.max(MIN_SLOT_MS, minMs)));
}
export { FLASH_MS, FLASH_MAX_MS, MIN_SLOT_MS, scatter, flashLit, rampUp, rampDown, swell, swellsIn, randomSwell, randomFlash, burst, drawnByTheShow, strobeLevel, DRAWN_STROBE_FUNCTIONS, };
