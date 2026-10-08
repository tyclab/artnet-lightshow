import { useEffect, useState } from 'preact/hooks';
import { api } from '../state.js';

export function PlaylistGenerator({ onCreate }) {
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState('universal');
  const [lengthBeats, setLength] = useState('32');
  const [includeRapid, setRapid] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true;
    api('/api/sequence/generator').then((r) => { if (active && r.ok) setTemplates(r.templates); });
    return () => { active = false; };
  }, []);
  const generate = async () => {
    setBusy(true); setError('');
    try {
      const r = await api('/api/sequence/generator', { method: 'POST', body: JSON.stringify({ template, lengthBeats: Number(lengthBeats), includeRapid }) });
      if (r.ok) setPreview(r); else setError(r.error || 'Could not generate playlist');
    } finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true);
    try { const r = await onCreate(preview.sequence); if (r?.ok) setPreview(null); }
    finally { setBusy(false); }
  };
  return <details class="card playlist-generator"><summary>Starter playlists and generator</summary>
    <fieldset disabled={busy}>
      <label>Playlist template<select value={template} onChange={(e) => { setTemplate(e.target.value); setPreview(null); }}>
        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
      <label>Beats per row<input type="number" min="1" max="1024" step="1" value={lengthBeats}
        onInput={(e) => { setLength(e.target.value); setPreview(null); }} /></label>
      <label><input type="checkbox" checked={includeRapid} onChange={(e) => { setRapid(e.target.checked); setPreview(null); }} />Include rapid effects</label>
      <button type="button" class="btn" onClick={generate}>Preview playlist</button>
      {preview && <div>
        <p>{preview.sequence.clips.length} rows · {preview.rapid} rapid effects · {preview.skipped.length} omitted</p>
        <p class="setting-help">Creates a stopped, editable playlist. Save it to keep it in the library; Play starts it. Rapid effects still require acknowledgement.</p>
        {!!preview.skipped.length && <details><summary>Omitted effects</summary><ul>{preview.skipped.map((p) => <li key={p.id}>{p.name}: {p.reason}</li>)}</ul></details>}
        <button type="button" class="btn primary" onClick={create}>Create playlist</button>
      </div>}
      {error && <p role="status">{error}</p>}
    </fieldset>
  </details>;
}
