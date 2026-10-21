import { api, pick } from '../state.js';
import { useDraft } from '../draft.js';
import { saveSettings } from '../setup-state.js';
import { PICTURE_BLACK_POINT_DEFAULT, PICTURE_GRADE_DEFAULTS } from '../../src/shared/picture-grade.ts';

const SLIDERS = [
  ['whiteLimit', 'White limit', 0, 100, 'How much of the white is taken out: pale areas turn to their colour, white only dims.'],
  ['saturation', 'Saturation', 0, 200, 'How strongly the remaining colour shows; 100 % keeps it.'],
  ['ceiling', 'Ceiling', 10, 100, 'The brightest a lamp gets from the picture, before the master and its trim.'],
  ['hueCeiling', 'Hue ceiling', 10, 100, 'The same for Hue lamps, which wash colours out with their own white LEDs when bright.'],
];
const BLACK_POINT_PCT = Math.round(PICTURE_BLACK_POINT_DEFAULT * 100);

// Ten saves a second while a slider moves: each one is a settings write and a state broadcast.
const settleEvery = (fn) => setTimeout(fn, 100);
const save = (patch) => api('/api/picture/grade', { method: 'POST', body: JSON.stringify(patch) });
const savePicture = (patch) => saveSettings({ picture: patch });

function LevelSlider({ id, label, min, max, hint, value, disabled, onSave, marks }) {
  const [pct, onPct, commitPct] = useDraft(Math.round(value * 100), (v) => onSave(v / 100), settleEvery);
  return (
    <label class="picture-grade-slider">
      <span class="picture-grade-label">{label}</span>
      <input type="range" min={min} max={max} step="1" value={pct} disabled={disabled} aria-label={label}
        aria-valuetext={`${pct} percent`} aria-describedby={`picture-grade-${id}-help`} list={marks ? `picture-grade-${id}-marks` : undefined}
        onInput={(e) => onPct(parseInt(e.target.value, 10))} onChange={(e) => commitPct(parseInt(e.target.value, 10))} />
      <span class="picture-grade-value">{pct}%</span>
      {marks && <datalist id={`picture-grade-${id}-marks`}>{marks.map((m) => <option key={m} value={m} label="default" />)}</datalist>}
      <small class="setting-help" id={`picture-grade-${id}-help`}>{hint}</small>
    </label>
  );
}

/** The room picture's lift and colour grade, live while the visualizer paints the room; stored under picture. */
export function PictureGrade() {
  const s = pick(['picture']);
  if (s.picture?.source !== 'visualizer') return null;
  const grade = { ...PICTURE_GRADE_DEFAULTS, ...(s.picture.grade || {}) };
  const decode = !!s.picture.decode, blackPoint = s.picture.blackPoint ?? PICTURE_BLACK_POINT_DEFAULT;
  return (
    <section class="card picture-grade" aria-label="Picture colour grade">
      <fieldset>
        <legend>Picture levels</legend>
        <LevelSlider id="blackPoint" label="Black point" min={0} max={50} value={blackPoint} marks={[BLACK_POINT_PCT]}
          onSave={(v) => savePicture({ blackPoint: v })}
          hint={`The level under which a lamp stays dark, so the screen's near-black pixels do not light the room; above it a colour ramps up to its own level. ${BLACK_POINT_PCT} % is the default.`} />
        <label class="picture-grade-toggle">
          <input type="checkbox" checked={decode} onChange={(e) => savePicture({ decode: e.target.checked })} />
          {decode ? 'sRGB decode (on): a byte drives the linear light it stands for' : 'sRGB decode (off): a byte drives the lamp as sent'}
        </label>
        <small class="setting-help">Only for outputs with no gamma of their own: a WLED board applies one already, and a decode on top makes the room far too dim.</small>
      </fieldset>
      <fieldset>
        <legend>Picture colour grade</legend>
        <label class="picture-grade-toggle">
          <input type="checkbox" checked={grade.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          {grade.enabled ? 'Graded: the sliders below apply' : 'Off: the picture\'s own colours'}
        </label>
        {SLIDERS.map(([id, label, min, max, hint]) => (
          <LevelSlider key={id} id={id} label={label} min={min} max={max} hint={hint} value={grade[id]} disabled={!grade.enabled}
            onSave={(v) => save({ [id]: v })} />
        ))}
        <button type="button" class="btn" onClick={() => save({ ...PICTURE_GRADE_DEFAULTS })}>Use defaults</button>
      </fieldset>
    </section>
  );
}
