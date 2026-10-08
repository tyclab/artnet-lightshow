import { useState } from 'preact/hooks';
import { api, pick } from '../state.js';
import { AutomationEditor, automationStart } from './AutomationEditor.jsx';

function LiveAxis({ axis, active, blocked }) {
  const [draft, setDraft] = useState(() => active || automationStart(axis, 'target'));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const apply = async (settings) => {
    setBusy(true); setMessage('');
    try {
      const r = await api('/api/performance/automation', { method: 'PUT', body: JSON.stringify({ axis, settings }) });
      setMessage(r.ok ? settings ? 'Automation started.' : 'Automation stopped.' : r.error || 'Could not change automation');
    } finally { setBusy(false); }
  };
  return <fieldset disabled={busy}>
    <legend>Live {axis} · {active ? 'running' : 'stopped'}</legend>
    <AutomationEditor name={`Live ${axis}`} kind={axis} unit={axis === 'tempo' ? 'seconds' : 'beats'} value={draft} onChange={setDraft} />
    <button type="button" class="btn" disabled={blocked || !draft} onClick={() => apply(draft)}>Start {axis} automation</button>
    <button type="button" class="btn" disabled={!active} onClick={() => apply(null)}>Stop {axis} automation</button>
    {message && <p role="status">{message}</p>}
  </fieldset>;
}

export function LiveAutomation() {
  const s = pick(['liveAutomation', 'sequence', 'masterBlackout', 'running']);
  const sequence = s.sequence?.playing || s.sequence?.paused;
  const blocked = !!sequence || !!s.masterBlackout || s.running === false;
  return <details class="card live-automation"><summary>Live tempo and brightness automation</summary>
    <p class="setting-help">Runs immediately on the current look. Moving a fader stops that control’s automation. Stop, blackout, disarm or starting a sequence ends it; restarting never resumes it.</p>
    {blocked && <p role="status">{sequence ? 'Use the playing sequence’s automation, or stop it first.' : 'Resume the look and release blackout to start automation.'}</p>}
    {['tempo', 'brightness'].map((axis) => <LiveAxis key={axis} axis={axis} active={s.liveAutomation?.[axis]} blocked={blocked} />)}
  </details>;
}
