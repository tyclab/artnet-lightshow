import { NumberField } from './SequenceFields.jsx';

const AUTOMATION_MODES = ['none', 'target', 'triangle', 'sawtooth', 'sine'];

// The server's units: tempo in BPM 20 to 300, the master 0 to 255, whole periods 1 to 512.
const AUTOMATION_RANGE = { tempo: { lo: 20, hi: 300, min: 120, max: 130 }, brightness: { lo: 0, hi: 255, min: 0, max: 255 } };

export function automationStart(name, mode) {
  const r = AUTOMATION_RANGE[name];
  const a = { mode, period: 8, min: r.min, max: r.max, growing: true };
  if (mode === 'target') a.target = r.max;
  return a;
}

export function AutomationEditor({ name, kind, unit, value, onChange }) {
  const a = value || automationStart(kind, 'none');
  const range = AUTOMATION_RANGE[kind];
  const set = (patch) => {
    const next = { ...a, ...patch };
    if (next.mode === 'target' && !Number.isFinite(next.target)) next.target = next.max;
    if (next.mode !== 'target') delete next.target;
    onChange(next.mode === 'none' ? null : next);
  };
  return (
    <div class="seq-automation">
      <label class="seq-field"><span>{name}</span>
        <select aria-label={`${name} automation mode`} value={a.mode} onChange={(e) => set({ mode: e.currentTarget.value })}>
          {AUTOMATION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select></label>
      <NumberField label={`period in ${unit}`} value={a.period} step={1} min={1} onChange={(v) => set({ period: Math.min(512, Math.max(1, Math.round(v))) })} />
      <NumberField label="min" value={a.min} min={range.lo} max={range.hi} step={1} onChange={(v) => set({ min: v })} />
      <NumberField label="max" value={a.max} min={range.lo} max={range.hi} step={1} onChange={(v) => set({ max: v })} />
      {a.mode === 'target' && <NumberField label="target" value={a.target} min={range.lo} max={range.hi} step={1} onChange={(v) => set({ target: v })} />}
      {a.mode !== 'none' && a.mode !== 'target' && <label class="seq-field"><span>Direction</span>
        <select aria-label={`${name} automation direction`} value={a.growing ? 'up' : 'down'} onChange={(e) => set({ growing: e.target.value === 'up' })}>
          <option value="up">Increasing first</option><option value="down">Decreasing first</option>
        </select></label>}
    </div>
  );
}
