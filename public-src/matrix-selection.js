import { resolveGradient, toHex } from '../src/shared/palette-model.ts';
import { hsbToColour, LDJ_RANDOM_HUES, resolvePalette } from '../src/shared/effects/palette.ts';

export const MATRIX_DEFAULT_PALETTE = {
  id: 'matrix-rainbow', name: 'Rainbow', colours: LDJ_RANDOM_HUES.map((h) => toHex(hsbToColour(h / 360, 1, 1))),
};

export function matrixPaletteCells(palette, seed = Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32))) {
  const colours = resolvePalette({ palette: palette.colours }, null, [], seed, 0);
  const gradient = resolveGradient(palette, colours);
  const cells = gradient ? Array.from({ length: 8 }, (_, i) => gradient.sample(i / 7)) : colours;
  return cells.map((colour) => toHex(colour).toLowerCase());
}

export function shuffledMatrixPalette(palettes, currentId, random = Math.random) {
  const choices = palettes.filter((p) => p.id !== currentId);
  const pool = choices.length ? choices : palettes;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? null;
}

// Locked cells keep renewing ordinary leases; the server never gains a permanent latch.
export function createMatrixSelection(holds, onChange = () => {}) {
  const cells = new Map(), pointers = new Map();
  let locked = false;
  const publish = () => onChange({ locked, cells: [...cells.keys()] });
  const drop = (key, release = true) => {
    if (!cells.has(key)) return;
    cells.delete(key);
    for (const [pointer, cell] of pointers) if (cell === key) pointers.delete(pointer);
    if (release) holds.release(key);
  };
  const lift = (pointer) => {
    const key = pointers.get(pointer);
    if (key === undefined) return;
    pointers.delete(pointer);
    const cell = cells.get(key);
    if (!cell) return;
    cell.pointers.delete(pointer);
    if (!locked && !cell.pointers.size) drop(key);
  };
  return {
    press(pointer, key, colour) {
      lift(pointer);
      if (locked && cells.has(key)) drop(key);
      else {
        let cell = cells.get(key);
        if (!cell) {
          cell = { pointers: new Set() };
          cells.set(key, cell);
          holds.press(key, colour);
        }
        cell.pointers.add(pointer);
        pointers.set(pointer, key);
      }
      publish();
    },
    release(pointer) { lift(pointer); publish(); },
    setLocked(value) {
      locked = value;
      if (!locked) for (const [key, cell] of cells) if (!cell.pointers.size) drop(key);
      publish();
    },
    refused(key) { drop(key, false); publish(); },
    clear() { holds.releaseAll(); cells.clear(); pointers.clear(); locked = false; publish(); },
  };
}

export function matrixShouldRelease(before, after) {
  return before && ((before.armed && !after.armed) || (before.running && !after.running)
    || (!before.paused && after.paused) || (!before.blackout && after.blackout)
    || (before.connected && !after.connected) || (before.voice && !after.voice));
}
