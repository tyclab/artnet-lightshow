import { pick, send } from '../state.js';
import { DEFAULT_BACKGROUND } from '../../src/shared/background.ts';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';

export function Background() {
  const { background } = pick(['background']);
  const value = background ?? DEFAULT_BACKGROUND;
  const update = (patch) => send({ background: { ...value, ...patch } });
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
        onInput={(e) => update({ colour: { ...value.colour, ...parseHex(e.target.value), w: value.colour.w, a: value.colour.a, uv: value.colour.uv } })} /></label>
      {['w', 'a', 'uv'].map((channel) => <label>{({ w: 'White', a: 'Amber', uv: 'UV' })[channel]}
        <input type="range" min="0" max="255" value={value.colour[channel]}
          onInput={(e) => update({ colour: { ...value.colour, [channel]: Number(e.target.value) } })} />
      </label>)}
    </>}
    <p class="hint">{value.mode === 'follow' ? 'Uses the effect’s authored ambient colours and movement. Effects without an ambient layer stay dark between notes.'
      : value.mode === 'fixed' ? 'Fills the effect’s background with this colour. Deliberate dark rests stay dark.' : 'Removes ambient light; the effect and its trails still play.'}</p>
  </section>;
}
