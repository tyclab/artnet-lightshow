import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, connectedSig, librarySig, pick } from '../state.js';
import { createHoldControl } from '../hold-control.js';
import { useSafetyGate } from './Photosensitivity.jsx';
import { matrixAsks } from '../preview-inputs.js';
import { paletteName } from './PaletteEditor.jsx';
import { parseHex } from '../../src/shared/palette-model.ts';
import { colorToCss } from '../utils.js';
import { createMatrixSelection, MATRIX_DEFAULT_PALETTE, matrixPaletteCells, matrixShouldRelease, shuffledMatrixPalette } from '../matrix-selection.js';

export const MATRIX_MODES = [
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'flashes', label: 'Flashes' },
  { id: 'pulses', label: 'Pulses' },
  { id: 'cycle', label: 'Cycle' },
  { id: 'solid', label: 'Solid' },
];

// Serialize each lease's requests so an in-flight renewal cannot overtake release.
export function createMatrixHolds(post, onRefused = () => {}) {
  const page = Math.random().toString(36).slice(2, 8);
  const fingers = new Map();
  let generation = 0;
  const release = (pointerId) => {
    const finger = fingers.get(pointerId);
    if (!finger) return;
    fingers.delete(pointerId);
    finger.control.release();
  };
  const refuse = (pointerId, finger) => {
    finger.refused = true;
    finger.control.release();
    if (fingers.get(pointerId) !== finger) return;
    fingers.delete(pointerId);
    onRefused(pointerId);
  };
  return {
    press(pointerId, colour) {
      release(pointerId);
      const serial = ++generation;
      const finger = { colour, refused: false, releasing: false, tail: null };
      finger.control = createHoldControl(({ action, token }) => {
        if (finger.refused) return false;
        if (action === 'release') finger.releasing = true;
        const send = () => {
          if (finger.refused || (action === 'renew' && finger.releasing)) return null;
          const sent = post(action === 'release' ? 'release' : 'press', { colour, token: `${page}-${pointerId}-${serial}-${token}` }, action);
          if (!sent || typeof sent.then !== 'function') return null;
          return sent.then((r) => { if (action === 'press' && r && r.ok === false) refuse(pointerId, finger); }, () => {});
        };
        const next = finger.tail ? finger.tail.then(send) : send();
        finger.tail = next;
        if (next) next.then(() => { if (finger.tail === next) finger.tail = null; });
        return true;
      });
      fingers.set(pointerId, finger);
      finger.control.press();
    },
    release,
    releaseAll() { for (const id of [...fingers.keys()]) release(id); },
  };
}

export function matrixCellKeys(colour, hold, letGo) {
  const id = `key-${colour}`;
  const ours = (e) => e.key === ' ' || e.key === 'Enter';
  return {
    onKeyDown: (e) => { if (!ours(e)) return; e.preventDefault(); if (!e.repeat) hold(id, colour); },
    onKeyUp: (e) => { if (!ours(e)) return; e.preventDefault(); letGo(id); },
    onBlur: () => letGo(id),
  };
}

export function matrixModeKey(event, choose) {
  const buttons = [...event.currentTarget.querySelectorAll('[role="radio"]')];
  const at = buttons.indexOf(event.target);
  const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
  const to = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : direction && at >= 0 ? (at + direction + buttons.length) % buttons.length : -1;
  if (to < 0 || !buttons[to]) return;
  event.preventDefault();
  buttons[to].focus();
  choose(buttons[to].value);
}

// Failed renewals expire on the server; explicit actions use normal API errors.
function postMatrix(verb, body, action) {
  const init = { method: 'POST', body: JSON.stringify(body) };
  if (action === 'renew') {
    return fetch(`/api/matrix/${verb}`, { ...init, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  }
  return api(`/api/matrix/${verb}`, init);
}

export function Matrix() {
  const s = pick(['matrix', 'builtinPalettes', 'userPalettes', 'armed', 'running', 'sequence', 'masterBlackout']);
  const board = s.matrix || {};
  const mode = board.mode || null;
  const playing = Array.isArray(board.colours) ? board.colours.map((c) => String(c).toLowerCase()) : [];
  const lib = librarySig.value;
  const palettes = [...(s.builtinPalettes || lib.palettes?.builtin || []), ...(s.userPalettes || lib.palettes?.user || [])];
  const [paletteId, setPaletteId] = useState(() => {
    try { return localStorage.getItem('lightshow.matrix.palette') || 'rainbow'; } catch { return 'rainbow'; }
  });
  const [roll, setRoll] = useState(0);
  const palette = palettes.find((p) => p.id === paletteId) || palettes.find((p) => p.id === 'rainbow') || palettes[0] || MATRIX_DEFAULT_PALETTE;
  const body = JSON.stringify(palette);
  const colours = useMemo(() => matrixPaletteCells(JSON.parse(body)), [body, roll]);
  const [selection, setSelection] = useState({ locked: false, cells: [] });
  const controls = useMemo(() => {
    const holds = createMatrixHolds(postMatrix, (key) => control.refused(key));
    const control = createMatrixSelection(holds, setSelection);
    return control;
  }, []);
  useEffect(() => {
    const clear = () => controls.clear();
    const hidden = () => { if (document.hidden) clear(); };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', hidden); clear(); };
  }, [controls]);
  useEffect(() => { controls.clear(); }, [body, roll]);
  const previous = useRef(null);
  const lifecycle = { armed: s.armed, running: s.running, paused: s.sequence?.paused,
    blackout: s.masterBlackout, connected: connectedSig.value, voice: board.voice };
  useEffect(() => {
    if (matrixShouldRelease(previous.current, lifecycle)) controls.clear();
    previous.current = lifecycle;
  }, [lifecycle.armed, lifecycle.running, lifecycle.paused, lifecycle.blackout, lifecycle.connected, lifecycle.voice]);

  const gate = useSafetyGate();
  const hold = (id, key, colour) => {
    if (matrixAsks(mode, gate.acknowledged)) { gate.guard(`Matrix ${mode}`, () => {}); return false; }
    controls.press(id, key, colour);
    return true;
  };
  const letGo = (id) => controls.release(id);
  const press = (e, key, colour) => {
    e.preventDefault();
    if (hold(e.pointerId, key, colour)) e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const release = (e) => letGo(e.pointerId);
  const chooseMode = (next) => {
    const apply = () => api('/api/matrix', { method: 'PUT', body: JSON.stringify({ mode: next }) });
    if (selection.cells.length && matrixAsks(next, gate.acknowledged)) gate.guard(`Matrix ${next}`, apply);
    else apply();
  };
  const choosePalette = (next) => {
    controls.clear();
    setPaletteId(next.id);
    setRoll((n) => n + 1);
    try { localStorage.setItem('lightshow.matrix.palette', next.id); } catch { /* private mode */ }
  };

  return (
    <section class="matrix-view" aria-label="Matrix board">
      <div class="matrix-now" aria-live="polite">
        {playing.length ? `Playing ${playing.length} colour${playing.length > 1 ? 's' : ''} as ${mode}`
          : selection.locked ? 'Tap colours to lock or release them' : 'Hold colours to play them'}
      </div>
      <div class="palette-tools matrix-palette-tools">
        <label>Matrix palette <select aria-label="Matrix palette" value={palette.id} onChange={(e) => {
          const next = palettes.find((p) => p.id === e.currentTarget.value);
          if (next) choosePalette(next);
        }}>
          {(palettes.length ? palettes : [palette]).map((p) => <option key={p.id} value={p.id}>{paletteName(p)}</option>)}
        </select></label>
        <button type="button" class="btn sm" aria-pressed={selection.locked} onClick={() => controls.setLocked(!selection.locked)}>Lock colours</button>
      </div>
      <div class="matrix-modes" role="radiogroup" aria-label="Board mode" onKeyDown={(event) => matrixModeKey(event, chooseMode)}>
        {MATRIX_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            tabIndex={(mode || MATRIX_MODES[0].id) === m.id ? 0 : -1}
            value={m.id}
            class={`matrix-mode ${mode === m.id ? 'active' : ''}`}
            onClick={() => chooseMode(m.id)}
          >{m.label}</button>
        ))}
      </div>
      {gate.dialog}
      <div class="matrix-grid" style={{ touchAction: 'none' }}>
        {colours.map((colour, index) => (
          <button
            key={index}
            type="button"
            class={`matrix-cell${selection.cells.includes(index) || playing.includes(colour) ? ' held' : ''}`}
            aria-label={`Colour ${colour}`}
            aria-pressed={selection.cells.includes(index) || playing.includes(colour)}
            style={{ background: colorToCss(parseHex(colour)) }}
            onPointerDown={(e) => press(e, index, colour)}
            onPointerUp={release}
            onPointerCancel={() => controls.clear()}
            onLostPointerCapture={release}
            onContextMenu={(e) => e.preventDefault()}
            {...matrixCellKeys(String(index), (id) => hold(id, index, colour), letGo)}
          />
        ))}
      </div>
      <div class="palette-tools">
        <button type="button" class="btn sm" onClick={() => choosePalette(shuffledMatrixPalette(palettes, palette.id) || palette)}>Shuffle palette</button>
        <button type="button" class="btn sm" onClick={() => choosePalette(palette)}>Reroll colours</button>
        <button type="button" class="btn sm" onClick={() => controls.clear()}>Release colours</button>
      </div>
      {selection.locked && <p class="muted">Locked colours release when this page loses focus or closes.</p>}
    </section>
  );
}
