import { useState } from 'preact/hooks';
import { api, librarySig, pick } from '../state.js';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';
import { isRandom, pickerValue } from './PaletteEditor.jsx';
import { gradientSettings } from './GradientEditor.jsx';

export function replaceRgb(entry, rgb) {
  const before = isRandom(entry) ? { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 } : parseHex(entry);
  const { r, g, b } = parseHex(rgb);
  return toHex({ ...before, r, g, b });
}

export function shuffleColours(colours, random = Math.random) {
  const next = [...colours];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

export function VisualizerColours() {
  const s = pick(['pattern', 'paletteOverride', 'overridePalette', 'basePalette', 'colorPresets', 'colorA', 'colorB']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const library = librarySig.value;
  const preset = [...(library.builtin || []), ...(library.user || [])].find((p) => p.id === s.pattern);
  if (preset?.spec?.kind !== 'ldj.visualizer') return null;
  const spec = preset.spec;
  const body = s.overridePalette ?? (s.paletteOverride?.length ? { colours: s.paletteOverride }
    : spec.palette?.length ? { colours: spec.palette, ...gradientSettings(spec) }
      : s.basePalette ?? { colours: [s.colorB, s.colorA].map((id) => toHex(s.colorPresets?.[id] || { r: 255, g: 255, b: 255 })) });
  const apply = async (colours) => {
    setBusy(true); setError('');
    try {
      const r = await api('/api/palette-override', { method: 'PUT', body: JSON.stringify({ ...body, colours }) });
      if (!r.ok) setError(r.error || 'Could not change colours');
    } finally { setBusy(false); }
  };
  return <section class="card visualizer-colours" aria-label="Lighting visualizer colours">
    <fieldset disabled={busy}><legend>Live visualizer colours</legend>
      <div class="palette-tools">{body.colours.map((colour, index) => <label key={index}>
        {index === 0 ? 'Background' : index === 1 ? 'Hit colour' : `Colour ${index + 1}`}
        <input type="color" value={pickerValue(colour)} onChange={(e) => apply(body.colours.map((c, i) => i === index ? replaceRgb(c, e.target.value) : c))} />
      </label>)}</div>
      <button type="button" class="btn" disabled={body.colours.length < 2} onClick={() => apply(shuffleColours(body.colours))}>Shuffle visualizer colours</button>
      <p class="setting-help">Changes the shared palette override immediately. White, amber and UV channels are retained; Edit palette above exposes all channels and gradients.</p>
      {spec.params.autoColours && <p class="setting-help">This preset also chooses colours automatically. Turn off Auto colours in its effect editor to hold your choices.</p>}
      {error && <p role="status">{error}</p>}
    </fieldset>
  </section>;
}
