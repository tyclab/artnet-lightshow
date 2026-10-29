import { useRef } from 'preact/hooks';
import { pick, send } from '../state.js';
import { DEFAULT_BACKGROUND } from '../../src/shared/background.ts';
import { cellsOf } from '../../src/shared/rig.ts';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';

// The server replaces the whole background on every set, so an edit builds on the last one
// sent rather than on the last echo: a level dragged within the echo's round trip would
// otherwise carry the previous mode (or colour) back and undo the click before it.
const LOST_ECHO_MS = 5000;
const CHANNELS = ['r', 'g', 'b', 'w', 'a', 'uv'];
const SCOPES = { rig: 'Whole rig', wash: 'Wash fixtures', selected: 'Selected fixtures…' };
const picked = (value) => (value.selected ?? []).join(',');
const same = (a, b) => a.mode === b.mode && a.level === b.level && CHANNELS.every((c) => a.colour[c] === b.colour[c])
  && (a.fixtures ?? 'rig') === (b.fixtures ?? 'rig') && picked(a) === picked(b);

/** Which patched fixtures the setting reaches, in the words of the card; as backgroundScope decides it. */
function scopeHint(value, fixtures, wash) {
  const scope = value.fixtures ?? 'rig';
  if (scope === 'rig') return null;
  const count = scope === 'wash' ? wash.length : fixtures.filter((f) => (value.selected ?? []).includes(f.id)).length;
  const what = scope === 'wash' ? `${count} of ${fixtures.length} fixtures: the single-light ones (lamps, PARs, LED washes)`
    : `${count} of ${fixtures.length} fixtures picked`;
  return `${what}. The others keep the effect’s own background.`;
}

export function Background() {
  const { background, fixtures = [], profiles = {} } = pick(['background', 'fixtures', 'profiles']);
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
  const scope = value.fixtures ?? 'rig';
  const wash = fixtures.filter((f) => !cellsOf(profiles[f.profileId]));
  // Kept in patch order; a fixture since removed from the patch drops out on the next pick.
  const toggle = (id, on) => {
    const chosen = new Set(base().selected ?? []);
    if (on) chosen.add(id); else chosen.delete(id);
    update({ selected: fixtures.filter((f) => chosen.has(f.id)).map((f) => f.id) });
  };
  const hint = scopeHint(value, fixtures, wash);
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
    <label>Fixtures
      <select aria-label="Background fixtures" value={scope} onChange={(e) => update({ fixtures: e.target.value })}>
        {Object.entries(SCOPES).map(([id, label]) => <option value={id}>{label}</option>)}
      </select>
    </label>
    {scope === 'selected' && <fieldset class="background-fixtures" aria-label="Fixtures the background reaches">
      {fixtures.length ? fixtures.map((f) => <label class="insp-check">
        <input type="checkbox" checked={(value.selected ?? []).includes(f.id)} onChange={(e) => toggle(f.id, e.target.checked)} />
        <span>{f.label || `Fixture ${f.id}`}</span>
      </label>) : <p class="setting-help">The patch has no fixtures yet.</p>}
    </fieldset>}
    {hint && <p class="setting-help">{hint}</p>}
    <p class="hint">{value.mode === 'follow' ? 'Uses the effect’s authored ambient colours and movement. Effects without an ambient layer stay dark between notes.'
      : value.mode === 'fixed' ? 'Fills the effect’s background with this colour. Deliberate dark rests stay dark.' : 'Removes ambient light; the effect and its trails still play.'}</p>
  </section>;
}
