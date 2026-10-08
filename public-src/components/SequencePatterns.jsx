import { useRef, useState } from 'preact/hooks';
import { api } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { canonical } from '../../src/shared/effects/layer.ts';

export function remapPattern(pattern, index, slot) {
  const original = pattern.lanes[index];
  return { ...pattern, lanes: pattern.lanes.map((lane, i) => i === index ? { ...lane, slot }
    : lane.kind === original.kind && lane.slot === slot ? { ...lane, slot: original.slot } : lane) };
}

function PatternEditor({ pattern, fixtures, lanes, onClose }) {
  const [draft, setDraft] = useState(pattern);
  const [deleting, setDeleting] = useState(false);
  const box = useRef(null);
  const latest = useRef(draft);
  latest.current = draft;
  const close = () => {
    if (canonical(latest.current) === canonical(pattern) || window.confirm('Discard your unsaved pattern edits?')) onClose();
  };
  useFocusTrap(box, true, close);
  const shared = lanes.filter((l) => l.kind === 'shared');
  const save = async () => {
    const result = await api(`/api/sequence/patterns/${encodeURIComponent(pattern.id)}`, { method: 'PUT', body: JSON.stringify(draft) });
    if (result.ok) onClose();
  };
  const remove = async () => {
    const result = await api(`/api/sequence/patterns/${encodeURIComponent(pattern.id)}`, { method: 'DELETE' });
    if (result.ok) onClose();
  };
  return <div class="confirm-veil" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div ref={box} class="confirm-panel seq-pattern-editor" role="dialog" aria-modal="true" aria-label="Edit pattern" tabIndex={-1}>
      <h2>Edit pattern</h2>
      <label class="seq-field">Pattern name
        <input value={draft.name} maxLength={80} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      </label>
      <p>Mapping is saved with the pattern. Track targets follow patch order when reused; clips already inserted stay as they are.</p>
      <div class="seq-inspector">
        {draft.lanes.map((lane, index) => <label key={index} class="seq-field">
          {`${lane.kind === 'track' ? 'Track' : 'Shared'} lane ${index + 1} target`}
          <select value={String(lane.slot)} onChange={(e) => setDraft(remapPattern(draft, index, Number(e.currentTarget.value)))}>
            {lane.kind === 'shared'
              ? [0, 1, 2].map((slot) => <option key={slot} value={slot}>{shared[slot]?.name || `Shared lane ${slot + 1} (created on insert)`}</option>)
              : <>
                {lane.slot >= fixtures.length && <option value={lane.slot}>Missing fixture in slot {lane.slot + 1}</option>}
                {fixtures.map((fixture, slot) => <option key={fixture.id} value={slot}>{fixture.label || `Fixture ${fixture.id}`}</option>)}
              </>}
          </select>
        </label>)}
      </div>
      <div class="confirm-actions">
        <button type="button" class="btn" onClick={close}>Cancel edits</button>
        <button type="button" class="btn" disabled={!draft.name.trim()} onClick={save}>Save pattern</button>
        <button type="button" class="btn danger" onClick={() => setDeleting(true)}>Delete pattern</button>
      </div>
      {deleting && <div role="alert">
        <p>Delete “{pattern.name}” from the library? Existing sequence clips stay; pads using this pattern will need another assignment.</p>
        <button type="button" class="btn danger" onClick={remove}>Delete it</button>
        <button type="button" class="btn" onClick={() => setDeleting(false)}>Keep pattern</button>
      </div>}
    </div>
  </div>;
}

export function SequencePatterns({ patterns, fixtures, lanes, beat, onInsert }) {
  const [editing, setEditing] = useState(null);
  const edit = async (id) => {
    const result = await api(`/api/sequence/patterns/${encodeURIComponent(id)}`);
    if (result.ok) setEditing(result.pattern);
  };
  return <>
    <div class="seq-patterns" role="group" aria-label="Patterns">
      {patterns.map((pattern) => <div key={pattern.id} class="seq-toolbar">
        <button type="button" class="seq-pattern" aria-label={`Insert ${pattern.name} at beat ${Math.floor(beat)}`}
          onClick={() => onInsert(pattern.id)}>{pattern.name}</button>
        <button type="button" class="seq-mini" aria-label={`Edit pattern ${pattern.name}`} onClick={() => edit(pattern.id)}>Edit pattern</button>
      </div>)}
    </div>
    {editing && <PatternEditor pattern={editing} fixtures={fixtures} lanes={lanes} onClose={() => setEditing(null)} />}
  </>;
}
