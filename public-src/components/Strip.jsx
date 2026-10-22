import { useState } from 'preact/hooks';
import { api, pick, send } from '../state.js';
import { useDraft } from '../draft.js';
import { showActive, startShow } from '../transport-model.js';
import { runTransport } from './Transport.jsx';

/**
 * The strip above every live view — Show, Effects, Perform, Stage, Auto Show
 * and Sequence — with the few switches a party reaches for wherever it is:
 * armed or not and what paints the room, the auto show on or off, blackout
 * and the master. The app shell renders it once, so every view has the same
 * controls in the same place; the setup views have none. Everything deeper
 * keeps its own view: pads and strobes in Perform, the auto show's sources
 * and timeline in Auto Show, the room's bindings in Stage.
 */

const BUSY_TEXT = { downloading: 'downloading the track', analyzing: 'analysing the track', ready: 'ready — tap to start' };

/**
 * What the base layer paints from: the show's effects, or the picture a sender (the
 * browser helper's --room mode) samples at each lamp's plan position. Voices, pads,
 * overrides and the matrix's own pixel feed sit above either; without frames the
 * effects show through after two seconds.
 */
function PictureSwitch() {
  const s = pick(['picture', 'armed']);
  const source = s.picture?.source ?? 'effects';
  const input = s.picture?.input ?? null;
  const choose = (next) => api('/api/picture/source', { method: 'POST', body: JSON.stringify({ source: next }) });
  const hint = source === 'inspired' ? input?.receiving ? 'picture colours and motion drive spatial effects' : 'waiting for picture colours and motion'
    : source !== 'visualizer' ? 'the show\'s effects paint the room'
    : !s.armed ? 'arm the outputs; the picture needs a live rig'
      : input?.receiving ? `visualizer picture on ${input.units} lamp cells` : 'no picture arriving — effects show meanwhile';
  return (
    <div class="perform-picture" title={hint}>
      <div class="segmented" role="group" aria-label="Picture source">
        {[['effects', 'Effects'], ['inspired', 'Colour + motion'], ['visualizer', 'Visualizer']].map(([id, label]) => (
          <button key={id} type="button" class={`segmented-btn ${source === id ? 'active' : ''}`} aria-pressed={source === id} onClick={() => choose(id)}>{label}</button>
        ))}
      </div>
      <span class="perform-picture-hint">{hint}</span>
    </div>
  );
}

/**
 * The outputs' switch. Disarmed, the show renders for the preview and the
 * stage view but nothing leaves the machine: the WLEDs and the Hue lamps are
 * the house's again. The server starts disarmed; a party arms it here.
 */
export function ArmSwitch() {
  const s = pick(['armed']);
  const armed = !!s.armed;
  return (
    <section class="perform-arm" aria-label="Outputs">
      <button type="button" class={`perform-arm-switch${armed ? ' armed' : ''}`} role="switch" aria-checked={armed}
        onClick={() => api(armed ? '/api/outputs/disarm' : '/api/outputs/arm', { method: 'POST' })}>
        <span class="perform-arm-state">{armed ? 'Armed' : 'Disarmed'}</span>
        <span class="perform-arm-hint">{armed ? 'frames go out to the rig — tap to disarm' : 'nothing goes out to the rig — tap to arm'}</span>
      </button>
      <PictureSwitch />
    </section>
  );
}

/** The auto show on or off; what it follows and plays is Auto Show's business. */
function AutoSwitch() {
  const s = pick(['showOn', 'autoShow', 'autoSource', 'activeSource']);
  const on = showActive(s);
  const status = s.autoShow?.status || 'idle';
  const busy = status === 'downloading' || status === 'analyzing';
  const [pending, setPending] = useState(false);
  const toggle = async () => {
    setPending(true);
    try {
      await runTransport([on || busy ? { path: '/api/auto/stop', method: 'POST' } : startShow(s)]);
    } finally {
      setPending(false);
    }
  };
  const track = s.autoShow?.track;
  const hint = on
    ? (track?.name ? `${track.artist ? `${track.artist} — ` : ''}${track.name}` : 'following the music — tap to stop')
    : BUSY_TEXT[status] || 'off — the look stays as picked';
  return (
    <button type="button" class={`show-switch${on ? ' on' : ''}`} role="switch" aria-checked={on} disabled={pending} onClick={toggle}
      title="The auto show picks the looks from the music. Its sources and timeline are in Auto Show.">
      <span class="show-switch-state">Auto show</span>
      <span class="show-switch-hint">{hint}</span>
    </button>
  );
}

/** Blackout and the master: the two hands that reach for every light at once. */
function Masters() {
  const s = pick(['masterDimmer', 'masterBlackout']);
  const [dim, onDim, commitDim] = useDraft(s.masterDimmer ?? 255, (v) => send({ masterDimmer: v }));
  const pct = Math.round((dim / 255) * 100);
  const dark = !!s.masterBlackout;
  return (
    <div class="show-masters">
      <button type="button" class={`show-switch blackout${dark ? ' on' : ''}`} role="switch" aria-checked={dark}
        onClick={() => send({ masterBlackout: !dark })}>
        <span class="show-switch-state">Blackout</span>
        <span class="show-switch-hint">{dark ? 'the rig is dark — tap to restore' : 'tap to darken every light'}</span>
      </button>
      <label class="show-master">
        <span class="show-master-label">Master</span>
        <input type="range" min="0" max="255" value={dim} aria-label="Master dimmer" aria-valuetext={`${pct} percent`}
          onInput={(e) => onDim(parseInt(e.target.value, 10))} onChange={(e) => commitDim(parseInt(e.target.value, 10))} />
        <span class="show-master-value">{pct}%</span>
      </label>
    </div>
  );
}

/** A landmark of its own: it sits between the view tabs and the view's panel. */
export function Strip() {
  return (
    <section class="show-strip" aria-label="Show controls">
      <ArmSwitch />
      <AutoSwitch />
      <Masters />
    </section>
  );
}
