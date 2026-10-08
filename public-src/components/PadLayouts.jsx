import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const place = (pad) => `${pad.bank ? 'B' : 'A'}${pad.slot + 1}`;

export function PadLayouts({ onClose }) {
  const box = useRef(null);
  const closeRef = useRef(null);
  useFocusTrap(box, true, () => closeRef.current?.());
  const [setup, setSetup] = useState(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [allowMissing, setAllowMissing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requests = useRef(0);
  const refresh = async () => {
    const result = await api('/api/show-setup');
    if (result.ok) setSetup(result);
    else setError(result.error || 'Could not read the current setup');
    return result;
  };
  useEffect(() => { refresh(); return () => { requests.current++; }; }, []);
  const discard = () => !dirty || window.confirm('Discard the unsaved layout name or mapping?');
  const close = () => { if (!busy && discard()) onClose(); };
  closeRef.current = close;
  const load = async (next, mapping) => {
    const generation = ++requests.current;
    setError(''); setNotice(''); setDeleting(false); setAllowMissing(false);
    if (!next) { setId(''); setName(''); setPreview(null); setDirty(false); return; }
    setBusy(true);
    const result = await api(`/api/pad-layouts/${encodeURIComponent(next)}/preview`, json('POST', { mapping }));
    if (generation !== requests.current) return;
    setBusy(false);
    if (!result.ok) { setError(result.error || 'Could not open layout'); return; }
    if (setup && result.expected.id !== setup.expected.id) { setError('The loaded show changed. Close and reopen layouts before applying.'); return; }
    setId(next); if (!mapping) setName(result.layout.name);
    setSetup(result); setPreview(result); setDirty(!!mapping);
  };
  const mutate = async (path, method, body, message) => {
    setBusy(true); setError(''); setNotice('');
    const result = await api(path, json(method, body));
    setBusy(false);
    if (!result.ok) { setError(result.error || 'Could not save pad layout'); return false; }
    setDirty(false); setDeleting(false); setNotice(message);
    await refresh();
    return result;
  };
  const save = async (copy) => {
    const result = await mutate(copy || !id ? '/api/pad-layouts' : `/api/pad-layouts/${encodeURIComponent(id)}`,
      copy || !id ? 'POST' : 'PUT', { name: name.trim(), expected: setup.expected, ...(!copy && id ? { capture: true } : {}) }, 'Current pads saved as a reusable layout.');
    if (result) { setId(result.layout.id); setName(result.layout.name); setPreview(null); }
  };
  const apply = async () => {
    const result = await mutate(`/api/pad-layouts/${encodeURIComponent(id)}/apply`, 'POST', {
      expected: setup.expected, mapping: preview.preview.mapping, allowMissingContent: allowMissing,
    }, 'Pad layout applied.');
    if (result) { setPreview(null); setAllowMissing(false); }
  };
  const rename = async () => {
    const result = await mutate(`/api/pad-layouts/${encodeURIComponent(id)}`, 'PUT', { name: name.trim(), expected: setup.expected }, 'Layout renamed.');
    if (result) setPreview(null);
  };
  const remove = async () => {
    const result = await mutate(`/api/pad-layouts/${encodeURIComponent(id)}`, 'DELETE', { expected: setup.expected }, 'Layout deleted; current pad assignments are retained.');
    if (result) { setId(''); setName(''); setPreview(null); }
  };
  const active = setup?.layouts.find((layout) => layout.id === setup.performance.activePadLayoutId);
  const targetSlots = preview ? [...new Set(preview.layout.pads.flatMap((pad) => Array.isArray(pad.targetSlots) ? pad.targetSlots : []))].sort((a, b) => a - b) : [];
  return <div class="effect-sheet-veil" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={box} class="effect-sheet pad-layout-library" role="dialog" aria-modal="true" aria-label="Pad layouts" tabIndex={-1}>
      <h2>Pad layouts</h2>
      <p>{setup?.scoped ? 'Changes belong to the loaded show. Save its sequence to keep them.' : 'Changes apply to the global pad deck.'}</p>
      <p>Current layout: {active?.name || 'Custom assignments'}</p>
      <fieldset disabled={busy || !setup} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <label class="pad-field">Saved layout
          <select aria-label="Saved pad layout" value={id} onChange={(event) => {
            const next = event.currentTarget.value;
            event.currentTarget.value = id;
            if (discard()) load(next);
          }}><option value="">New layout</option>{setup?.layouts.map((layout) => <option key={layout.id} value={layout.id}>{layout.name}</option>)}</select>
        </label>
        <label class="pad-field">Layout name<input aria-label="Pad layout name" value={name} maxLength={80}
          onInput={(event) => { setName(event.currentTarget.value); setDirty(true); }} /></label>
        <div class="palette-tools">
          <button type="button" disabled={!name.trim()} onClick={() => save(false)}>Save current pads</button>
          {id && <>
            <button type="button" disabled={!name.trim()} onClick={() => save(true)}>Save as new layout</button>
            <button type="button" disabled={!name.trim()} onClick={rename}>Rename layout</button>
            <button type="button" onClick={() => setDeleting(true)}>Delete layout</button>
          </>}
        </div>
        {preview && <>
          <h3>Map saved fixture positions</h3>
          <p>Default mapping follows {preview.orderMode} in order. Shared-target pads still cover the shared rig.</p>
          {!targetSlots.length && <p>These pads need no fixture remapping.</p>}
          {targetSlots.map((slot) => <label class="pad-field" key={slot}>Slot {slot + 1}: {preview.layout.fixtureLabels[slot]}
            <select aria-label={`Layout fixture slot ${slot + 1}`} value={preview.preview.mapping[slot] ?? ''} onChange={(event) => {
              const mapping = [...preview.preview.mapping];
              mapping[slot] = event.currentTarget.value === '' ? null : Number(event.currentTarget.value);
              load(id, mapping);
            }}><option value="">Unmapped</option>{preview.order.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label || fixture.id}</option>)}</select>
          </label>)}
          {!!preview.preview.missingSlots.length && <p role="alert">Map every referenced fixture slot before applying.</p>}
          {!!preview.preview.missingContent.length && <label class="pad-choice">
            <input type="checkbox" checked={allowMissing} onChange={(event) => setAllowMissing(event.currentTarget.checked)} />
            Leave missing content unassigned: {preview.preview.missingContent.map((pad) => `${place(pad)} ${pad.label || pad.id}`).join(', ')}
          </label>}
          <button type="button" disabled={!!preview.preview.missingSlots.length || (!!preview.preview.missingContent.length && !allowMissing)} onClick={apply}>Apply pad layout</button>
        </>}
        {id && !preview && <button type="button" onClick={() => load(id)}>Preview and apply layout</button>}
        {deleting && <div role="alert" class="palette-tools"><span>Delete “{name}” from saved layouts?</span>
          <button type="button" onClick={remove}>Confirm delete layout</button>
          <button type="button" onClick={() => setDeleting(false)}>Keep layout</button>
        </div>}
      </fieldset>
      {dirty && <p role="status">Unsaved layout edits</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={close}>Close layouts</button>
    </section>
  </div>;
}
