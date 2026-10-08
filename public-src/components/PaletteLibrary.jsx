import { useState } from 'preact/hooks';
import { api, patchLibrary } from '../state.js';
import { PaletteEditor } from './PaletteEditor.jsx';

const editable = ({ id: _id, ...body }) => JSON.parse(JSON.stringify(body));

export function PaletteLibrary({ builtin, user, onClose }) {
  const [id, setId] = useState('');
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = draft && (invalid || JSON.stringify(draft) !== baseline);
  const discard = () => !dirty || window.confirm('Discard the unsaved palette changes?');
  const choose = (next) => {
    if (!discard()) return false;
    const palette = user.find((p) => p.id === next);
    const body = palette ? editable(palette) : null;
    setId(next); setDraft(body); setBaseline(JSON.stringify(body)); setDeleting(false); setError('');
    return true;
  };
  const save = async () => {
    setBusy(true); setError('');
    const submitted = JSON.stringify(draft);
    const result = await api(`/api/palettes/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({ ...draft, name: draft.name.trim() }),
    });
    setBusy(false);
    if (!result.ok) { setError(result.error || 'Could not save palette'); return; }
    const body = editable(result.palette);
    setDraft((current) => JSON.stringify(current) === submitted ? body : current);
    setBaseline(JSON.stringify(body));
    patchLibrary((lib) => ({ ...lib, palettes: { ...lib.palettes,
      user: lib.palettes.user.map((p) => p.id === id ? result.palette : p) } }));
  };
  const remove = async () => {
    setBusy(true); setError('');
    const result = await api(`/api/palettes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) { setError(result.error || 'Could not delete palette'); setDeleting(false); return; }
    patchLibrary((lib) => ({ ...lib, palettes: { ...lib.palettes, user: lib.palettes.user.filter((p) => p.id !== id) } }));
    setId(''); setDraft(null); setBaseline(''); setDeleting(false);
  };
  return <section class="palette-draft" aria-label="Saved palettes">
    <div class="palette-tools">
      <label>Saved palette <select aria-label="Saved palette" value={id} disabled={busy} onChange={(e) => {
        if (!choose(e.currentTarget.value)) e.currentTarget.value = id;
      }}>
        <option value="">Choose a saved palette…</option>
        {user.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <button type="button" class="btn sm" disabled={busy} onClick={() => { if (discard()) onClose(); }}>Close library</button>
    </div>
    {!user.length && <p class="muted">Use Edit palette → Save as palette to create your first saved palette. Built-ins stay unchanged.</p>}
    {draft && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label>Palette name <input aria-label="Saved palette name" value={draft.name} maxLength={80} disabled={busy}
        onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} /></label>
      <PaletteEditor key={id} body={draft} onBodyChange={(body) => setDraft({ ...body, name: draft.name })}
        onInvalid={setInvalid} builtin={builtin} user={user} label="Saved palette colours" />
      <p class="muted">Changes apply the next time this palette is selected. Colours already playing keep their current values.</p>
      <div class="palette-tools">
        <button type="button" class="btn sm" disabled={busy || invalid || !draft.name.trim() || !dirty} onClick={save}>Save changes</button>
        <button type="button" class="btn sm" disabled={busy} onClick={() => setDeleting(true)}>Delete palette</button>
        {dirty && <span role="status">Unsaved palette changes</span>}
      </div>
      {deleting && <div role="alert" class="palette-tools">
        <span>Delete “{draft.name}” from your saved palettes?</span>
        <button type="button" class="btn sm" disabled={busy} onClick={remove}>Confirm delete</button>
        <button type="button" class="btn sm" disabled={busy} onClick={() => setDeleting(false)}>Keep palette</button>
      </div>}
    </fieldset>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
