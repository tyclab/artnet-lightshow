import { useState } from 'preact/hooks';
import { api } from '../state.js';
import { settleSequenceEdits } from '../sequence-workspace.js';

export function ShowSetup({ seq, onSetup }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The server captures or removes the setup against the revision this page saw.
  const run = async (action) => {
    setBusy(true); setError('');
    await settleSequenceEdits();
    const setup = await api('/api/show-setup');
    const result = !setup.ok ? setup
      : setup.expected.id !== seq.id ? { ok: false, error: 'The show changed while its setup was being captured.' }
        : await onSetup(action, setup.expected);
    if (!result?.ok) setError(result?.error || 'The show setup was not changed.');
    setBusy(false);
  };
  const capture = () => run('capture');
  const globals = () => run('global');
  return <details class="show-setup">
    <summary>Show audio and pads</summary>
    <p>{seq.performance ? 'This show owns its Party audio response and all sixteen pad assignments. Save the sequence to keep changes.'
      : 'This show uses the global Party audio response and pad deck.'}</p>
    <div class="seq-toolbar">
      <button type="button" disabled={busy} onClick={capture}>Capture current setup</button>
      <button type="button" disabled={busy || !seq.performance} onClick={globals}>Use global setup</button>
    </div>
    <p class="muted">Edit audio response in Perform and pad assignments in Pads. Named pad layouts can be reused across shows.</p>
    {error && <p role="alert">{error}</p>}
  </details>;
}

export async function withCurrentShowSetup(sequence, request = api) {
  const result = await request('/api/show-setup');
  if (!result.ok) return null;
  return { ...sequence, performance: result.performance };
}
