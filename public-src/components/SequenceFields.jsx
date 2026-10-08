import { useMemo, useState } from 'preact/hooks';

/** A number typed in, or undefined for text that is none (an empty field included). */
export function parseNumber(text) {
  const v = Number(text);
  return String(text).trim() !== '' && Number.isFinite(v) ? v : undefined;
}

/** A typed field's text: its own while focused, the stored value otherwise. */
export function createTextDraft() {
  let text = null;
  return {
    shown: (stored) => (text === null ? String(stored ?? '') : text),
    focus(stored) { text = String(stored ?? ''); },
    input(t) { text = t; },
    commit(parse, onCommit) {
      const t = text;
      text = null;
      if (t === null) return;
      const v = parse(t);
      if (v !== undefined) onCommit(v);
    },
  };
}

// The live status redraws this view many times a second; the text being typed
// stays until blur or Enter commits it.
export function Field({ value, parse = (t) => t, onCommit, ...rest }) {
  const draft = useMemo(createTextDraft, []);
  const [, redraw] = useState(0);
  const done = () => { draft.commit(parse, onCommit); redraw((n) => n + 1); };
  return (
    <input {...rest} value={draft.shown(value)}
      onFocus={() => draft.focus(value)}
      onInput={(e) => { draft.input(e.currentTarget.value); redraw((n) => n + 1); }}
      onBlur={done}
      onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />
  );
}

export function NumberField({ label, value, step = 1, min, max, onChange }) {
  return (
    <label class="seq-field">
      <span>{label}</span>
      <Field type="number" value={value} step={step} min={min} max={max} parse={parseNumber} onCommit={onChange} />
    </label>
  );
}

