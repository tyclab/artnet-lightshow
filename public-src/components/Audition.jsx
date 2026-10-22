import { pick, librarySig } from '../state.js';
import { auditionSig, setAudition, startAudition } from '../audition.js';
import { demoPosition, demoFrameAt, DEMO_DURATION_MS, DEMO_BPM } from '../../src/shared/demo-track.ts';
import { resolverOf } from '../preview-inputs.js';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';
import { fmtTime } from '../utils.js';

export function Audition({ compact = false }) {
  const s = pick(['patterns', 'armed', 'safety']), a = auditionSig.value;
  const library = librarySig.value;
  const rows = [...(s.patterns || []).filter((p) => !p.retired), ...(library.user || []).filter((p) => !(s.patterns || []).some((r) => r.id === p.id))];
  const spec = a.spec || resolverOf(library.user)(a.id);
  const blocked = spec && requiresAcknowledgement(spec) && !a.acknowledged && !s.safety?.photosensitivityAcknowledged;
  const { section, beat } = demoPosition(a.position), levels = demoFrameAt(a.position).party;
  return <section class="audition-panel" aria-label="Effect audition">
    <div class="palette-tools">
      <button type="button" class={`btn sm${a.active ? ' active' : ''}`} disabled={!!s.armed} aria-pressed={a.active}
        onClick={() => a.active ? setAudition({ active: false, playing: false }) : startAudition(a.id, a.spec, a.name)}>
        {a.active ? 'Close audition' : 'Audition effects'}</button>
      {!compact && <span class="muted">Demo track · {DEMO_BPM} BPM · browser preview while disarmed</span>}
      {s.armed && <span class="muted">Disarm outputs to audition.</span>}
    </div>
    {a.active && <>
      <label>Effect <select aria-label="Audition effect" value={a.id} onChange={(e) => startAudition(e.currentTarget.value)}>
        {a.spec && <option value={a.id}>{a.name || 'Edited draft'}</option>}
        {rows.filter((r) => !a.spec || r.id !== a.id).map((r) => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
      </select></label>
      {blocked && <div class="audition-safety" role="alert">
        <p>This preview contains rapid flashing that can cause seizures in people with photosensitive epilepsy. Check that everyone viewing the screen can safely watch.</p>
        <button type="button" class="btn sm" onClick={() => setAudition({ acknowledged: true, position: 0 })}>Allow flashing in this browser preview</button>
      </div>}
      <div class="palette-tools">
        <button type="button" class="btn sm" onClick={() => setAudition({ playing: !a.playing, position: a.position >= DEMO_DURATION_MS ? 0 : a.position })}>{a.playing ? 'Pause demo' : 'Play demo'}</button>
        <button type="button" class="btn sm" onClick={() => setAudition({ position: 0 })}>Restart demo</button>
        <input type="range" min="0" max={DEMO_DURATION_MS} step="50" value={a.position} aria-label="Audition position"
          aria-valuetext={fmtTime(a.position)} onInput={(e) => setAudition({ position: Number(e.currentTarget.value), playing: false })} />
        <span data-audition-section={section}>{section} · beat {Math.floor(beat) + 1} · {fmtTime(a.position)}</span>
      </div>
      <div class="audition-bands" aria-label="Demo audio bands">{['bass', 'mid', 'high'].map((band) => <label key={band}>{band}
        <meter min="0" max="1" value={levels[band]} aria-label={`Demo ${band}`} /></label>)}</div>
      <p class="look-note">Build → drop → breakdown → groove. Audition has its own colours and audio; the live look, voices and outputs keep their state.</p>
    </>}
  </section>;
}
