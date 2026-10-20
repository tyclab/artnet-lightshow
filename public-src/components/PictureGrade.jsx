import { api, pick } from '../state.js';
import { useDraft } from '../draft.js';
import { PICTURE_GRADE_DEFAULTS } from '../../src/shared/picture-grade.ts';

const SLIDERS = [
  ['whiteLimit', 'White limit', 0, 100, 'How much of the white is taken out: pale areas turn to their colour, white only dims.'],
  ['saturation', 'Saturation', 0, 200, 'How strongly the remaining colour shows; 100 % keeps it.'],
  ['ceiling', 'Ceiling', 10, 100, 'The brightest a lamp gets from the picture, before the master and its trim.'],
  ['hueCeiling', 'Hue ceiling', 10, 100, 'The same for Hue lamps, which wash colours out with their own white LEDs when bright.'],
];

// Ten saves a second while a slider moves: each one is a settings write and a state broadcast.
const settleEvery = (fn) => setTimeout(fn, 100);
const save = (patch) => api('/api/picture/grade', { method: 'POST', body: JSON.stringify(patch) });

function GradeSlider({ id, label, min, max, hint, value, disabled }) {
  const [pct, onPct, commitPct] = useDraft(Math.round(value * 100), (v) => save({ [id]: v / 100 }), settleEvery);
  return (
    <label class="picture-grade-slider">
      <span class="picture-grade-label">{label}</span>
      <input type="range" min={min} max={max} step="1" value={pct} disabled={disabled} aria-valuetext={`${pct} percent`}
        onInput={(e) => onPct(parseInt(e.target.value, 10))} onChange={(e) => commitPct(parseInt(e.target.value, 10))} />
      <span class="picture-grade-value">{pct}%</span>
      <small class="setting-help">{hint}</small>
    </label>
  );
}

/** The room picture's colour grade, live while the visualizer paints the room; stored as picture.grade. */
export function PictureGrade() {
  const s = pick(['picture']);
  if (s.picture?.source !== 'visualizer') return null;
  const grade = { ...PICTURE_GRADE_DEFAULTS, ...(s.picture.grade || {}) };
  return (
    <section class="card picture-grade" aria-label="Picture colour grade">
      <fieldset>
        <legend>Picture colour grade</legend>
        <label class="picture-grade-toggle">
          <input type="checkbox" checked={grade.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          {grade.enabled ? 'Graded: less white, more colour' : 'Off: the picture as sent'}
        </label>
        {SLIDERS.map(([id, label, min, max, hint]) => (
          <GradeSlider key={id} id={id} label={label} min={min} max={max} hint={hint} value={grade[id]} disabled={!grade.enabled} />
        ))}
        <button type="button" class="btn" onClick={() => save({ ...PICTURE_GRADE_DEFAULTS })}>Use defaults</button>
      </fieldset>
    </section>
  );
}
