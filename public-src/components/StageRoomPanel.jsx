import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../state.js';
import { bindingSources } from '../stage3d/world.js';

export const replaceStageRoom = (room, revision) => api('/api/stage/room', {
  method: room === null ? 'DELETE' : 'PUT',
  headers: { 'If-Match': revision },
  ...(room === null ? {} : { body: JSON.stringify(room) }),
});

export function withRoomBinding(room, binding, previousId = null) {
  const bindings = room.bindings.filter((entry) => entry.id !== previousId);
  if (binding) bindings.push(binding);
  return { ...room, bindings };
}

function SourceFields({ source, fixtures, rig, onChange, prefix = '' }) {
  const index = fixtures.findIndex((fixture) => fixture.id === source.fixtureId);
  return <>
    <label>{prefix ? `${prefix} fixture` : 'Fixture'}<select value={source.fixtureId} required
      onChange={(event) => onChange({ fixtureId: Number(event.target.value), unit: 0 })}>
      {index < 0 && <option value={source.fixtureId} disabled>Missing fixture {source.fixtureId}</option>}
      {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}
    </select></label>
    <label>{prefix ? `${prefix} cell` : 'Cell'}<input type="number" min="0" max={index >= 0 ? rig.ranges[index].count - 1 : 0}
      step="1" required value={source.unit ?? 0} onInput={(event) => onChange({ unit: event.target.value })} /></label>
  </>;
}

export function StageRoomPanel({ snapshot, coverage, fixtures, rig, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const editor = useRef(null);
  const originalDraft = useRef(null);
  const request = useRef(0);
  const { room, revision } = snapshot;
  const hasChanges = draft && JSON.stringify(draft) !== originalDraft.current;
  const hasDraft = draft !== null;
  useEffect(() => { if (hasDraft) editor.current?.scrollIntoView({ block: 'nearest' }); }, [editingId, hasDraft]);
  const discardDraft = () => !hasChanges || window.confirm('Discard the unsaved light position?');
  const refresh = async () => {
    if (!discardDraft()) return;
    const version = ++request.current;
    setBusy(true);
    const result = await api('/api/stage/room');
    if (version !== request.current) return;
    setBusy(false);
    if (result.ok) { onChange(result); setDraft(null); setEditingId(null); setError(''); }
    else setError(result.error || 'The room could not be loaded.');
  };
  useEffect(() => { refresh(); return () => { request.current++; }; }, []);
  const read = async (file) => {
    if (!file) return;
    setPending(null);
    try {
      if (file.size > 1024 * 1024) throw new Error('Room files must be at most 1 MB.');
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.version !== 1 || typeof parsed.name !== 'string') throw new Error('Choose a version 1 room file.');
      setPending(parsed);
      setError('');
    } catch (err) { setError(err.message); }
  };
  const save = async (next) => {
    const version = ++request.current;
    setBusy(true);
    const result = await replaceStageRoom(next, revision);
    if (version !== request.current) return;
    setBusy(false);
    if (result.ok) { onChange(result); setPending(null); setDraft(null); setEditingId(null); setError(''); return true; }
    else setError(`${result.error || 'The room could not be saved.'} Reload the room before retrying a changed revision.`);
    return false;
  };
  const edit = (binding = null, fixtureId = fixtures[0]?.id) => {
    if (!discardDraft()) return;
    setEditingId(binding?.id || null);
    const next = binding ? window.structuredClone(binding)
      : { fixtureId, unit: 0, position: { x: 0, y: 0, z: 0 }, label: '', confidence: 'estimated' };
    originalDraft.current = JSON.stringify(next);
    setDraft(next);
  };
  const replaceRoom = (next) => {
    const warning = [hasChanges && 'Discard the unsaved light position?', room?.bindings.length > 0
      && 'Replace the room and its saved light positions? Download the room first to keep a copy.'].filter(Boolean).join('\n');
    if (!warning || window.confirm(warning)) return save(next);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(room, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'stage-room.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const submitBinding = async (event) => {
    event.preventDefault();
    const binding = { ...draft, id: editingId || `binding-${Date.now()}`,
      position: Object.fromEntries(Object.entries(draft.position).map(([key, value]) => [key, Number(value)])) };
    if (binding.sources) binding.sources = binding.sources.map((source) => ({ ...source, unit: Number(source.unit), weight: Number(source.weight) }));
    else binding.unit = Number(binding.unit);
    if (!binding.label) delete binding.label;
    if (await save(withRoomBinding(room, binding, editingId))) { setDraft(null); setEditingId(null); }
  };
  const sourceChange = (index, patch) => setDraft({ ...draft, sources: draft.sources.map((source, i) => i === index ? { ...source, ...patch } : source) });
  const changeMode = (aggregate) => {
    if (aggregate) {
      const { fixtureId, unit, ...common } = draft;
      setDraft({ ...common, aggregation: 'weightedMean', sources: [{ fixtureId, unit, weight: 1 }] });
    } else {
      if (draft.sources.length > 1 && !window.confirm('Keep only the first source for this light position?')) return false;
      const { sources, aggregation: _aggregation, ...common } = draft;
      setDraft({ ...common, fixtureId: sources[0].fixtureId, unit: sources[0].unit });
    }
    return true;
  };
  const nextSource = draft && fixtures.flatMap((fixture, index) => Array.from({ length: rig.ranges[index].count }, (_, unit) => ({ fixtureId: fixture.id, unit, weight: 1 })))
    .find((candidate) => !bindingSources(draft).some((source) => source.fixtureId === candidate.fixtureId && Number(source.unit) === candidate.unit));
  const invalidSource = draft && bindingSources(draft).some((source) => !fixtures.some((fixture) => fixture.id === source.fixtureId) || !(Number(source.weight) > 0));
  return <details class="stage-room-panel">
    <summary>Room · {room?.name || (revision === null ? 'Loading…' : 'Generic venue')}</summary>
    <p class="setting-help">Room imports change this preview only. Fixture patch positions and physical output stay unchanged.</p>
    {room && <p class="stage-room-status">
      {room.bounds.width.toFixed(2)} × {room.bounds.depth.toFixed(2)} × {room.bounds.height.toFixed(2)} m
      {' · '}{room.source?.name || 'Imported room'}{room.source?.revision ? ` · revision ${room.source.revision}` : ''}
      {room.source?.confidence !== 'measured' ? ' · estimated geometry' : ' · measured geometry'}
    </p>}
    {coverage && <>
      <p class="stage-room-status">{coverage.lamps.length + coverage.cells.length} light positions
        {' · '}{coverage.estimated} estimated{' · '}{coverage.missing.length} fixtures without positions
        {' · '}{coverage.partial.length} partly positioned{' · '}{coverage.unresolved.length} unmatched bindings
        {' · '}{coverage.incomplete.length} incomplete averages</p>
      {(coverage.missing.length > 0 || coverage.partial.length > 0 || coverage.unresolved.length > 0) && <ul class="stage-room-unplaced">
        {coverage.missing.map((fixture) => <li key={`missing-${fixture.id}`}>{fixture.label}: no room position <button class="btn sm" type="button" disabled={busy} onClick={() => edit(null, fixture.id)}>Place</button></li>)}
        {coverage.partial.map((fixture) => <li key={`partial-${fixture.id}`}>{fixture.label}: some cells have no room position <button class="btn sm" type="button" disabled={busy} onClick={() => edit(null, fixture.id)}>Place cell</button></li>)}
        {coverage.unresolved.map((binding) => <li key={`binding-${binding.id}`}>{binding.label || binding.id}: its output sources are unavailable</li>)}
      </ul>}
      {coverage.incomplete.length > 0 && <ul class="stage-room-unplaced">
        {coverage.incomplete.map(({ binding, missingSources }) => <li key={binding.id}>{binding.label || binding.id}: {missingSources} missing sources contribute black to this incomplete average.</li>)}
      </ul>}
      {coverage.shared.length > 0 && <details class="stage-room-topology">
        <summary>{coverage.shared.length} shared output channels</summary>
        <p class="setting-help">These positions share output channels, so their colours cannot be controlled independently. Room bindings change only the preview.</p>
        <ul class="stage-room-unplaced">{coverage.shared.map((output) => <li key={`${output.fixtureId}:${output.unit}`}>
          {fixtures.find((fixture) => fixture.id === output.fixtureId)?.label || output.fixtureId}, cell {output.unit}: {output.bindings.join(' + ')}
        </li>)}</ul>
      </details>}
    </>}
    {room && <details class="stage-room-bindings">
      <summary>Light positions</summary>
      <p class="setting-help">Coordinates are metres from the floor centre: X across, Z along its depth, Y above the floor. A cell number starts at zero.</p>
      <ul class="stage-room-unplaced">
        {room.bindings.map((binding) => <li key={binding.id}>
          {binding.label || fixtures.find((fixture) => fixture.id === binding.fixtureId)?.label || binding.id}
          {' · '}{binding.sources ? `${binding.sources.length} sources, estimated colour average` : `cell ${binding.unit ?? 0}`}{' · '}{binding.confidence} position
          <button class="btn sm" type="button" disabled={busy} onClick={() => edit(binding)}>Edit</button>
          <button class="btn sm" type="button" disabled={busy} onClick={async () => {
            if (!discardDraft()) return;
            if (await save(withRoomBinding(room, null, binding.id))) { setDraft(null); setEditingId(null); }
          }}>Remove</button>
        </li>)}
      </ul>
      <button class="btn" type="button" disabled={busy || !fixtures.length} onClick={() => edit()}>Add light position</button>
    </details>}
    {room && draft && <form ref={editor} class="stage-room-editor" onSubmit={submitBinding}>
      <fieldset disabled={busy} class="stage-room-editor-fields">
      <label>Colour preview<select value={draft.sources ? 'average' : 'single'} onChange={(event) => {
        if (!changeMode(event.target.value === 'average')) event.currentTarget.value = draft.sources ? 'average' : 'single';
      }}>
        <option value="single">Single output</option><option value="average">Weighted colour average</option>
      </select></label>
      {!draft.sources && <SourceFields source={draft} fixtures={fixtures} rig={rig} onChange={(patch) => setDraft({ ...draft, ...patch })} />}
      {draft.sources && <div class="stage-room-sources">
        <p class="setting-help">One physical light, averaged from these outputs. Use positive weights, such as segment lengths. Missing sources contribute black; this does not recreate segment geometry.</p>
        {draft.sources.map((source, index) => <div class="stage-room-source" key={index}>
          <SourceFields source={source} fixtures={fixtures} rig={rig} prefix={`Source ${index + 1}`} onChange={(patch) => sourceChange(index, patch)} />
          <label>Source {index + 1} weight<input type="number" min="0" step="any" required value={source.weight} onInput={(event) => sourceChange(index, { weight: event.target.value })} /></label>
          <button class="btn sm" type="button" disabled={draft.sources.length === 1} onClick={() => setDraft({ ...draft, sources: draft.sources.filter((_, i) => i !== index) })}>Remove source {index + 1}</button>
        </div>)}
        <button class="btn" type="button" disabled={!nextSource || draft.sources.length >= 64} onClick={() => setDraft({ ...draft, sources: [...draft.sources, nextSource] })}>Add source</button>
      </div>}
      {['x', 'z', 'y'].map((axis) => <label key={axis}>{axis === 'y' ? 'Height Y' : `Floor ${axis.toUpperCase()}`} (m)
        <input type="number" step="any" required value={draft.position[axis]}
          min={axis === 'y' ? 0 : -room.bounds[axis === 'x' ? 'width' : 'depth'] / 2}
          max={axis === 'y' ? room.bounds.height : room.bounds[axis === 'x' ? 'width' : 'depth'] / 2}
          onInput={(event) => setDraft({ ...draft, position: { ...draft.position, [axis]: event.target.value } })} />
      </label>)}
      <label>Label<input maxLength="120" value={draft.label || ''} onInput={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
      <label>Position confidence<select value={draft.confidence} onChange={(event) => setDraft({ ...draft, confidence: event.target.value })}>
        <option value="estimated">Estimated</option><option value="measured">Measured</option>
      </select></label>
      <div class="stage-room-actions"><button class="btn active" type="submit" disabled={busy || invalidSource}>Save position</button>
        <button class="btn" type="button" onClick={() => { if (discardDraft()) setDraft(null); }}>Cancel</button></div>
      </fieldset>
    </form>}
    <div class="stage-room-actions">
      <label class="btn stage-room-file">Choose room JSON<input type="file" accept=".json,application/json" aria-label="Choose room JSON" disabled={busy}
        onChange={(event) => { read(event.target.files?.[0]); event.target.value = ''; }} /></label>
      {pending && <button class="btn active" type="button" disabled={busy || revision === null} onClick={() => replaceRoom(pending)}>Use {pending.name}</button>}
      <button class="btn" type="button" disabled={busy} onClick={refresh}>Reload room</button>
      {room && <>
        <button class="btn" type="button" disabled={busy} onClick={download}>Download room JSON</button>
        <button class="btn" type="button" disabled={busy} onClick={() => replaceRoom(null)}>Use generic venue</button>
      </>}
    </div>
    {error && <p role="alert" class="stage-room-error">{error}</p>}
    {busy && <p role="status">Loading room…</p>}
  </details>;
}
