import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../state.js';
import { BpmCaptureSession, CAPTURE_MS } from '../bpm-capture.js';

export function BpmCapture({ onApply, destination = 'show tempo' }) {
  const [run, setRun] = useState(0);
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [factor, setFactor] = useState(1);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const cancel = useRef(() => {});
  useEffect(() => {
    if (!run) return;
    const session = new BpmCaptureSession(), started = performance.now();
    let live = true, pending = false;
    const stop = () => { live = false; clearInterval(timer); setActive(false); };
    const tick = async () => {
      if (pending || !live) return;
      pending = true;
      try {
        const input = await api('/api/performance/input');
        if (!live) return;
        const ms = performance.now() - started;
        session.add(input, ms); setElapsed(Math.min(ms, CAPTURE_MS));
        const next = session.result(); setResult(next);
        if (ms >= CAPTURE_MS) { stop(); setMessage(next.ready ? 'Capture ready. Check half/double before applying.' : 'No stable tempo captured. Check the input in Sources and try again.'); }
      } finally { pending = false; }
    };
    const timer = setInterval(tick, 250);
    cancel.current = stop;
    tick();
    return () => { live = false; clearInterval(timer); };
  }, [run]);
  const bpm = result?.bpm == null ? null : Math.round(result.bpm * factor * 10) / 10;
  const apply = async () => {
    setSaving(true);
    try { const r = await onApply(bpm); setMessage(r?.ok === false ? r.error || 'Could not apply tempo' : `Applied ${bpm} BPM to ${destination}.`); }
    finally { setSaving(false); }
  };
  return <details class="card bpm-capture"><summary>Capture tempo from audio</summary>
    <p class="setting-help">Listens to the configured microphone or loopback for 12 seconds. Choose the input in <a href="#sources">Sources</a>. Applying uses a fixed tempo.</p>
    <button type="button" class="btn" disabled={active || saving} onClick={() => { setActive(true); setElapsed(0); setResult(null); setFactor(1); setMessage(''); setRun((n) => n + 1); }}>Start tempo capture</button>
    {active && <><button type="button" class="btn" onClick={() => { cancel.current(); setResult(null); setMessage('Capture cancelled.'); }}>Cancel capture</button>
      <progress aria-label="Tempo capture progress" value={elapsed} max={CAPTURE_MS} /></>}
    {result && <p>{bpm ?? '—'} BPM · {Math.round(result.confidence * 100)}% stable locked samples</p>}
    {!active && result?.ready && <fieldset disabled={saving}>
      <label>Detected tempo division<select value={factor} onChange={(e) => setFactor(Number(e.target.value))}>
        <option value="0.5">Half</option><option value="1">Detected</option><option value="2">Double</option>
      </select></label>
      <button type="button" class="btn" disabled={bpm < 20 || bpm > 300} onClick={apply}>Use captured tempo</button>
    </fieldset>}
    {message && <p role="status">{message}</p>}
  </details>;
}
