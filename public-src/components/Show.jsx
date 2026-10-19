import { useState } from 'preact/hooks';
import { pick, send } from '../state.js';
import { useDraft } from '../draft.js';
import { showActive, startShow } from '../transport-model.js';
import { runTransport } from './Transport.jsx';
import { ArmSwitch } from './Perform.jsx';
import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { Effects } from './Effects.jsx';
import { Colors } from './Colors.jsx';

/**
 * The view the app opens on: the room as the rig paints it, the looks to pick
 * from beside it, and along the top the few switches a party needs — armed or
 * not, what paints the room, the auto show on or off, blackout, the master.
 * Everything deeper keeps its own view: pads and strobes in Perform, the auto
 * show's sources and timeline in Auto Show, the room's bindings in Stage.
 */

const BUSY_TEXT = { downloading: 'downloading the track', analyzing: 'analysing the track', ready: 'ready — tap to start' };

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
        <input type="range" min="0" max="255" value={dim} aria-valuetext={`${pct} percent`}
          onInput={(e) => onDim(parseInt(e.target.value, 10))} onChange={(e) => commitDim(parseInt(e.target.value, 10))} />
        <span class="show-master-value">{pct}%</span>
      </label>
    </div>
  );
}

export function Show() {
  return (
    <div class="show-view">
      <div class="show-strip">
        <ArmSwitch />
        <AutoSwitch />
        <Masters />
      </div>
      <StrobesOff perform />
      <div class="show-body">
        <div class="show-room"><StageView compact /></div>
        <div class="show-looks"><Effects /><Colors /></div>
      </div>
    </div>
  );
}
