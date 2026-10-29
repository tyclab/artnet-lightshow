import { useRef } from 'preact/hooks';
import { pick, send } from '../state.js';
import { DEFAULT_BACKGROUND } from '../../src/shared/background.ts';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';

// The server replaces the whole background on every set, so an edit builds on the last one
// sent rather than on the last echo: a level dragged within the echo's round trip would
// otherwise carry the previous mode (or colour) back and undo the click before it.
const LOST_ECHO_MS = 5000;
const CHANNELS = ['r', 'g', 'b', 'w', 'a', 'uv'];
const same = (a, b) => a.mode === b.mode && a.level === b.level && CHANNELS.every((c) => a.colour[c] === b.colour[c]);

export function Background() {
  const { background } = pick(['background']);
  const value = background ?? DEFAULT_BACKGROUND;
  const sent = useRef(null);
  // Echoed, or never will be (rejected, lost): edits build on the server's value again.
  if (sent.current && (same(sent.current.value, value) || Date.now() - sent.current.at > LOST_ECHO_MS)) sent.current = null;
  const base = () => (sent.current && Date.now() - sent.current.at <= LOST_ECHO_MS ? sent.current.value : value);
  const update = (patch) => {
    const next = { ...base(), ...patch };
    sent.current = send({ background: next }) ? { value: next, at: Date.now() } : null;
  };
  const setColour = (patch) => update({ colour: { ...base().colour, ...patch } });
  return <section class="card" aria-label="Background lighting">
    <div class="card-title">Background</div>
    <div class="btn-group" role="group" aria-label="Background mode">
      {['follow', 'fixed', 'off'].map((mode) => <button type="button" class={`btn sm ${value.mode === mode ? 'active' : ''}`}
        aria-pressed={value.mode === mode} onClick={() => update({ mode })}>
        {mode === 'follow' ? 'Follow effect' : mode === 'fixed' ? 'Fixed colour' : 'Off'}
      </button>)}
    </div>
    <label>Background level <output aria-hidden="true">{Math.round(value.level * 100)}%</output>
      <input aria-label="Background level" type="range" min="0" max="100" value={Math.round(value.level * 100)} disabled={value.mode === 'off'}
        onInput={(e) => update({ level: Number(e.target.value) / 100 })} />
    </label>
    {value.mode === 'fixed' && <>
      <label>Colour <input type="color" value={toHex(value.colour).slice(0, 7)}
        onInput={(e) => { const { w, a, uv } = base().colour; setColour({ ...parseHex(e.target.value), w, a, uv }); }} /></label>
      {['w', 'a', 'uv'].map((channel) => <label>{({ w: 'White', a: 'Amber', uv: 'UV' })[channel]}
        <input type="range" min="0" max="255" value={value.colour[channel]}
          onInput={(e) => setColour({ [channel]: Number(e.target.value) })} />
      </label>)}
    </>}
    <p class="hint">{value.mode === 'follow' ? 'Uses the effect’s authored ambient colours and movement. Effects without an ambient layer stay dark between notes.'
      : value.mode === 'fixed' ? 'Fills the effect’s background with this colour. Deliberate dark rests stay dark.' : 'Removes ambient light; the effect and its trails still play.'}</p>
  </section>;
}
