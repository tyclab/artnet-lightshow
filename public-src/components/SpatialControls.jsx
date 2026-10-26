import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../state.js';
import { z } from 'zod';
import { ColourSliders } from './ColourSliders.jsx';
import { kindOf } from '../../src/shared/effects/registry.ts';
import { mappingOf, MAPPING_LABELS } from '../../src/shared/effects/mapping.ts';

const words = (value) => value.replace(/([a-z])(?=[A-Z])/g, '$1 ').replace(/^./, (c) => c.toUpperCase());
const LABELS = { 'fromPoint.x': 'Start X (metres)', 'fromPoint.y': 'Start height (metres)', 'fromPoint.z': 'Start Z (metres)',
  'toPoint.x': 'End X (metres)', 'toPoint.y': 'End height (metres)', 'toPoint.z': 'End Z (metres)',
  elevationDeg: 'Elevation (degrees)', azimuthDeg: 'Azimuth (degrees)', fromAnchor: 'Start anchor', toAnchor: 'End anchor',
  segmentM: 'Segment length (metres)', placeM: 'Room group spacing (metres)' };
const BASIC_FIELDS = new Set(['colour', 'colourMode', 'shape', 'profile', 'mode', 'speed', 'width', 'trail', 'cycleBeats',
  'stepBeats', 'turnsPerBar', 'density', 'selection', 'flashesPerSecond', 'softness']);

function SchemaField({ schema: raw, value, path, setParam }) {
  const variants = raw.anyOf || [], nullable = variants.some((s) => s.type === 'null');
  const alternatives = variants.filter((s) => s.type !== 'null');
  const schema = alternatives.length && alternatives.every((s) => s.const !== undefined)
    ? { enum: alternatives.map((s) => s.const) } : alternatives[0] || raw;
  const label = LABELS[path] || words(path.split('.').at(-1));
  const id = `spatial-${path.replaceAll('.', '-')}`;
  const change = (value) => setParam(path, value);
  if (schema.type === 'object') return <fieldset class="spatial-fields"><legend>{label}</legend>
    {nullable && <label><input type="checkbox" checked={value != null} onChange={(e) => change(e.currentTarget.checked ? Object.fromEntries(Object.keys(schema.properties || {}).map((k) => [k, 0])) : null)} />Use explicit {label.toLowerCase()}</label>}
    {(!nullable || value != null) && Object.entries(schema.properties || {}).map(([key, child]) => <SchemaField key={key} schema={child} value={value?.[key]} path={path ? `${path}.${key}` : key} setParam={setParam} />)}
  </fieldset>;
  if (schema.type === 'array' && schema.items?.enum) return <fieldset class="spatial-fields"><legend>{label}</legend>
    {schema.items.enum.map((item) => <label key={item}><input type="checkbox" checked={(value || []).includes(item)}
      onChange={(e) => change(e.currentTarget.checked ? [...(value || []), item] : (value || []).filter((v) => v !== item))} />{words(item)}</label>)}
  </fieldset>;
  if (schema.type === 'array') return <fieldset class="spatial-fields"><legend>{label}</legend>
    {(value || []).map((item, i) => <div key={i}><SchemaField schema={schema.items || { type: 'number' }} value={item} path={`${path}.${i}`} setParam={setParam} />
      <button type="button" class="btn sm" aria-label={`Remove ${label} ${i + 1}`} onClick={() => change(value.filter((_, n) => n !== i))}>Remove</button></div>)}
    <button type="button" class="btn sm" disabled={(value?.length || 0) >= (schema.maxItems || 32)} onClick={() => change([...(value || []), schema.items?.type === 'string' ? '' : 1])}>Add {label.toLowerCase()}</button>
  </fieldset>;
  if (schema.type === 'boolean') return <label class="insp-check"><input type="checkbox" checked={!!value} onChange={(e) => change(e.currentTarget.checked)} />{label}</label>;
  if (schema.enum) return <div class="insp-field"><label for={id}>{label}</label><select id={id} value={value} onChange={(e) => change(schema.enum.find((item) => String(item) === e.currentTarget.value))}>
    {schema.enum.map((item) => <option key={item} value={item}>{words(String(item))}</option>)}
  </select></div>;
  if (schema.type === 'number' || schema.type === 'integer') return <div class="insp-field"><label for={id}>{label}</label>
    <input id={id} type={schema.minimum === 0 && schema.maximum === 1 ? 'range' : 'number'} value={value ?? ''} step={schema.type === 'integer' ? 1 : 0.05} min={schema.minimum} max={schema.maximum}
      onInput={(e) => { const text = e.currentTarget.value; if (text === '') { if (nullable) change(null); return; } const n = Number(text); if (Number.isFinite(n)) change(n); }} />
  </div>;
  if (schema.type === 'string' && /colour$/i.test(path) && /^#[0-9a-f]{6}$/i.test(value)) return <div class="spatial-colour"><label for={id}>{label}</label><input id={id} type="color" value={value} onInput={(e) => change(e.currentTarget.value)} /><ColourSliders value={value} label={label} onChange={change} /></div>;
  if (schema.type === 'string') return <div class="insp-field"><label for={id}>{label}</label><input id={id} type="text" list={/Anchor$/.test(path) ? 'spatial-room-anchors' : undefined} value={value ?? ''} placeholder={nullable ? 'Automatic' : ''}
    onInput={(e) => change(nullable && !e.currentTarget.value ? null : e.currentTarget.value)} /></div>;
  return null;
}

export function SpatialControls({ spec, setParam, advancedControls }) {
  const [anchors, setAnchors] = useState([]);
  useEffect(() => {
    let current = true;
    api('/api/stage/room').then((result) => { if (current && result.ok) setAnchors((result.room?.anchors || []).map((anchor) => anchor.id)); });
    return () => { current = false; };
  }, []);
  const schema = useMemo(() => {
    const kind = kindOf(spec.kind);
    return kind ? z.toJSONSchema(kind.schema, { unrepresentable: 'any' }) : null;
  }, [spec.kind]);
  const particles = spec.kind === 'v2.particles', mode = spec.params?.mode;
  const mapping = mappingOf(spec);
  const path = spec.kind === 'v2.sweep' || particles && mode === 'orbs';
  const fields = Object.entries(schema?.properties || {}).filter(([key]) => key !== 'space' && (!particles
    || mode === 'orbs' || !['toAnchor', 'toPoint', ...(mode === 'rain' ? ['fromAnchor', 'fromPoint'] : [])].includes(key)));
  const draw = (entries) => <div class="insp-grid">{entries.map(([key, child]) => <SchemaField key={key} schema={child} value={spec.params?.[key]} path={key} setParam={setParam} />)}</div>;
  return <div class="spatial-controls">
    <datalist id="spatial-room-anchors">{anchors.map((id) => <option key={id} value={id} />)}</datalist>
    {spec.kind === 'v2.visualizer' && <p class="look-note">Uses the incoming room picture's colours and motion to animate the room. Choose Colour + motion as the room source and keep the picture sender running. Without a picture feed this effect goes dark. Audition supplies a demo picture signal.</p>}
    {mapping && <div class="effect-mapping-control">
      <label for="spatial-space">Mapping</label>
      <select id="spatial-space" value={mapping} onChange={(e) => setParam('space', e.currentTarget.value)}>
        {Object.entries(MAPPING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <p class="look-note">{mapping === 'room'
        ? 'Follows the lights’ physical positions, including room depth and height. Room bindings make this different from the layout.'
        : 'Follows the Rig plot like a flat picture. The top of the plot is up; no room setup is needed.'} The Stage view switch only changes how you see the preview.</p>
    </div>}
    {!mapping && <p class="look-note">{spec.kind === 'v2.step'
      ? spec.params?.order === 'path' ? 'Follows each strip’s LED order. Room positions do not change this effect.' : 'Uses a random light order. Room positions do not change this effect.'
      : spec.kind === 'v2.zones' ? 'Groups lights by their technology or assigned group. Room positions do not change this effect.'
      : spec.kind === 'v2.scatter' ? 'Chooses individual pixels at random. Room positions do not change this effect.'
      : 'All lights change together. Room positions do not change this effect.'}</p>}
    {draw(fields.filter(([key]) => BASIC_FIELDS.has(key)))}
    <details class="insp-advanced"><summary>Advanced</summary>
    {mapping && <p class="look-note">Room coordinates use metres: X across, Y height above the floor, Z depth. Layout mapping uses the plotted cells.</p>}
    {path && <p class="look-note">{spec.kind === 'v2.sweep' && 'Elevation 0° travels horizontally; 90° climbs floor to ceiling. '}Start and end points or named room anchors define a diagonal path, including its height. For example, a floor start and a high corner end make the animation climb across the room.
      Plan mode maps explicit X and Z continuously across the room's width and depth; named anchors use the nearest lamp's plot position. Height is ignored on a horizontal or diagonal projection. If both endpoints project to one spot, height becomes travel from the bottom to the top of the plot.</p>}
    {particles && mode === 'fireworks' && <p class="look-note">The start point or anchor sets the launch position. Fireworks rise under gravity and burst at height. In Plan mode, an explicit start uses X across the plot and height from bottom to top; Z depth is ignored. Named anchors use the nearest lamp's plot position.</p>}
    {particles && mode === 'rain' && <p class="look-note">Rain falls through the room's full height. In Plan mode it falls down the plot from its top edge.</p>}
    {draw(fields.filter(([key]) => !BASIC_FIELDS.has(key)))}
    {advancedControls}
    </details>
  </div>;
}
