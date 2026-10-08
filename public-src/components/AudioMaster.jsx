import { useState } from 'preact/hooks';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { api } from '../state.js';

const CONTROLS = [
  ['brightness', 'Party brightness', 100, 100, 'Scales Party effects independently of the main dimmer.'],
  ['sensitivity', 'Input sensitivity', 100, 100, 'Raises the audio level supplied to Party effects.'],
  ['threshold', 'Gate threshold', 100, 100, 'Quiet input below this level does not trigger an effect.'],
  ['smoothing', 'Smoothing', 100, 100, 'Higher values make the audio response steadier.'],
  ['attackMs', 'Attack', 2000, 1, 'Time to follow a rising audio level.'],
  ['releaseMs', 'Release', 5000, 1, 'Time to follow a falling audio level.'],
  ['reactiveDepth', 'Reactive depth', 100, 100, 'How strongly audio changes Party effects.'],
];

export function AudioMaster({ audio }) {
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const change = (key, value) => { setDraft((previous) => ({ ...previous, [key]: value })); setMessage(''); };
  const apply = async (event) => {
    event.preventDefault();
    if (busy) return;
    const { ldjTrigger, ...master } = draft;
    const patch = {};
    if (Object.keys(master).length) patch.master = Object.fromEntries(Object.entries(master).map(([key, value]) => [key, Number(value)]));
    if (ldjTrigger !== undefined) patch.ldjTrigger = Number(ldjTrigger);
    setBusy(true);
    const result = await api('/api/audio', { method: 'PUT', body: JSON.stringify(patch) });
    setBusy(false);
    if (result.ok) { setDraft({}); setMessage('Audio response saved.'); }
    else setMessage(result.error || 'Audio response could not be saved.');
  };
  return (
    <details class="audio-master">
      <summary>Audio response</summary>
      <form onSubmit={apply}>
        <p>Global settings for Party effects. Choose Reactive mode to follow live audio.</p>
        <fieldset disabled={busy}>
          {CONTROLS.map(([key, label, max, scale, hint]) => {
            const value = draft[key] ?? audio.master?.[key] ?? HD_MASTER_DEFAULTS[key];
            return (
              <label key={key}>
                <span>{label} ({scale === 100 ? '%' : 'ms'})</span>
                <input type="number" min="0" max={max} step="1" required
                  value={value === '' ? '' : Math.round(Number(value) * scale)}
                  onInput={(event) => change(key, event.currentTarget.value === '' ? '' : Number(event.currentTarget.value) / scale)} />
                <small>{hint}</small>
              </label>
            );
          })}
          <label>
            <span>Light DJ trigger (%)</span>
            <input type="number" min="0" max="100" step="1" required
              value={draft.ldjTrigger === '' ? '' : Math.round(Number(draft.ldjTrigger ?? audio.ldjTrigger ?? 0.3) * 100)}
              onInput={(event) => change('ldjTrigger', event.currentTarget.value === '' ? '' : Number(event.currentTarget.value) / 100)} />
            <small>Fallback beat threshold. An active Visualizer uses the trigger in its effect settings.</small>
          </label>
        </fieldset>
        <div class="audio-master-actions">
          <button type="submit" disabled={busy || !Object.keys(draft).length}>Apply audio response</button>
          <button type="button" disabled={busy || !Object.keys(draft).length} onClick={() => { setDraft({}); setMessage(''); }}>Discard edits</button>
          <button type="button" disabled={busy} onClick={() => { setDraft({ ...HD_MASTER_DEFAULTS, ldjTrigger: 0.3 }); setMessage('Defaults ready to apply.'); }}>Use defaults</button>
        </div>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
