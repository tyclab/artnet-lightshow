import { emissionOf } from '../../../src/shared/emission.ts';
import { FixtureHardware } from './Hardware.jsx';
import { pick, connectedSig, emitFixture, fixtureAckSig, latestSent } from '../../state.js';
import { stagePositions } from '../../../src/shared/stage.ts';
import { buildRig, lineOf } from '../../../src/shared/rig.ts';
import { clamp, geometryOf, round1 } from '../../stage-geometry.js';
import { rigSelectionSig, identifyFixtures } from '../../rig-ui.js';
import { FieldInput } from './FieldInput.jsx';
import { hasNoAddress, isHueLamp } from '../../../src/shared/placement.ts';
import { hueChannels, hueChannelsLabel } from '../../../src/shared/hue-lamp.ts';
import { hueBridgeLabel } from '../../utils.js';

/**
 * The selected fixture, every property of it in one place: what it is, where
 * it is patched, where it stands on the plan and — for a bar — which way it
 * runs. Several selected: what they are, and identifying them together.
 */
export function Inspector() {
  const s = pick(['fixtures', 'profiles', 'identify', 'hueBridges', 'hardware']);
  const connected = connectedSig.value;
  void fixtureAckSig.value;
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const selected = rigSelectionSig.value.filter((id) => fixtures.some((f) => f.id === id));
  const identifying = new Set((s.identify && s.identify.ids) || []);

  if (!selected.length) {
    return (
      <aside class="panel inspector" aria-labelledby="inspector-title">
        <header class="panel-head"><h2 class="panel-title" id="inspector-title">Fixture</h2></header>
        <p class="panel-empty">Select a fixture on the plan or in the patch to see and change it here. Drag across the
          plan to select several.</p>
      </aside>
    );
  }
  if (selected.length > 1) {
    const chosen = fixtures.filter((f) => selected.includes(f.id));
    return (
      <aside class="panel inspector" aria-labelledby="inspector-title">
        <header class="panel-head"><h2 class="panel-title" id="inspector-title">{chosen.length} fixtures</h2></header>
        <ul class="inspector-list">{chosen.map((f) => <li key={f.id}>{f.label}</li>)}</ul>
        <div class="inspector-actions">
          <button type="button" class="btn sm" disabled={!connected} onClick={() => identifyFixtures(selected)}>Identify all</button>
          <button type="button" class="btn sm" onClick={() => { rigSelectionSig.value = []; }}>Clear selection</button>
        </div>
      </aside>
    );
  }

  const index = fixtures.findIndex((f) => f.id === selected[0]);
  const fix = fixtures[index];
  const profile = profiles[fix.profileId];
  const rig = buildRig(fixtures, (f) => profiles[f.profileId] || null);
  const placed = stagePositions(fixtures)[index];
  const point = latestSent(fix.id, 'position', placed);
  const bar = !!rig.cellMaps[index];
  const grid = rig.grids[index];
  const shaped = emissionOf(fix, profile, bar);
  const emission = latestSent(fix.id, 'emission', shaped);
  const linear = bar || emission.kind === 'strip';
  const unplaced = fixtures.filter((f) => !f.position).length;
  const drawn = linear ? lineOf(fix, grid ? grid.columns : Math.max(2, rig.ranges[index].count), fix.position ? 0 : unplaced) : null;
  const lineNow = () => drawn && { ...drawn, ...latestSent(fix.id, 'geometry', { length: drawn.length, angle: drawn.angle }) };
  const line = lineNow();
  const send = (patch) => emitFixture({ id: fix.id, ...patch });
  const place = (patch) => {
    const at = latestSent(fix.id, 'position', placed);
    send({ position: { x: clamp(round1(patch.x ?? at.x)), y: clamp(round1(patch.y ?? at.y)) } });
  };
  const shape = (patch) => send({ emission: { ...latestSent(fix.id, 'emission', shaped), ...patch } });
  const trimPct = Math.round(((fix.maxBrightness ?? 255) / 255) * 100);
  const addressless = hasNoAddress(fix);
  const hueLamp = isHueLamp(fix);
  const wled = !!(fix.output && fix.output.protocol === 'ddp');
  const openrgb = !!(fix.output && fix.output.protocol === 'openrgb');

  return (
    <aside class="panel inspector" aria-labelledby="inspector-title">
      <header class="panel-head">
        <h2 class="panel-title" id="inspector-title">Fixture {index + 1}</h2>
        {identifying.has(fix.id) && <span class="panel-tag">Identifying</span>}
      </header>
      <div class="inspector-grid">
        <label for="insp-label">Label</label>
        <FieldInput id="insp-label" value={fix.label} maxLength={64} onCommit={(label) => send({ label })} />
        <span class="inspector-key">Profile</span>
        <span class="inspector-value">{profile ? `${profile.name}${profile.modeName ? ` — ${profile.modeName}` : ''}` : fix.profileId}
          {profile && <small> · {profile.channelCount} ch{bar ? `, ${grid ? `${grid.columns} × ${grid.rows}` : rig.ranges[index].count} cells` : ''}</small>}</span>
        {wled && <><span class="inspector-key">Resolution</span>
          <span class="inspector-value">{rig.ranges[index].count} effect cells → {fix.output.leds || rig.ranges[index].count} physical LEDs.
            {fix.output.leds > rig.ranges[index].count ? ' Each cell repeats across several LEDs; fine spatial motion needs a pixel profile.' : ' Every LED retains its own animation value.'}</span></>}
        <span class="inspector-key">Output</span>
        <span class="inspector-value">{wled ? `WLED at ${fix.output.host}, over DDP`
          : openrgb ? `OpenRGB device #${fix.output.device}${profile ? ` (${profile.name})` : ''} at ${fix.output.host}${fix.output.port ? `:${fix.output.port}` : ''}, over the SDK`
            : hueLamp ? `Hue ${hueChannelsLabel(hueChannels(fix.output))} of ${hueBridgeLabel(s.hueBridges, fix.output.bridge)}` : 'DMX (Art-Net, sACN)'}</span>
        {!addressless && <>
          <label for="insp-universe">Universe</label>
          <FieldInput id="insp-universe" type="number" min="0" max="32767" value={fix.universe ?? 0} onCommit={(v) => send({ universe: v })} />
          <label for="insp-address">Address</label>
          <FieldInput id="insp-address" type="number" min="1" max="512" value={fix.address} onCommit={(v) => send({ address: v })} />
        </>}
        <label for="insp-x">Across</label>
        <FieldInput id="insp-x" type="number" min="0" max="100" step="0.5" value={round1(point.x)} onCommit={(x) => place({ x })} />
        <label for="insp-y">Depth</label>
        <FieldInput id="insp-y" type="number" min="0" max="100" step="0.5" value={round1(point.y)} onCommit={(y) => place({ y })} />
        <label for="insp-emission">Light shape</label>
        <select id="insp-emission" value={emission.kind} disabled={!connected}
          onChange={(e) => shape({ kind: e.target.value })}>
          <option value="bulb">Bulb / diffuse</option><option value="strip">Strip / panel</option><option value="beam">Directional beam</option>
        </select>
        {emission.kind === 'beam' && <>
          <label for="insp-pan">Beam pan</label>
          <FieldInput id="insp-pan" type="number" min="-180" max="180" step="5" value={emission.pan ?? (fix.group === 'floor' ? 180 : 0)}
            onCommit={(pan) => shape({ pan })} />
          <label for="insp-tilt">Beam tilt</label>
          <FieldInput id="insp-tilt" type="number" min="-90" max="90" step="5" value={emission.tilt ?? (fix.group === 'floor' ? 78 : -68)}
            onCommit={(tilt) => shape({ tilt })} />
          <label for="insp-beam-angle">Beam spread</label>
          <FieldInput id="insp-beam-angle" type="number" min="1" max="160" step="1" value={emission.beamAngle ?? 22}
            onCommit={(beamAngle) => shape({ beamAngle })} />
        </>}
        {linear && <>
          <label for="insp-length">Length</label>
          <FieldInput id="insp-length" type="number" min="1" max="100" step="0.5" value={round1(line.length)}
            onCommit={(length) => send({ geometry: geometryOf(length, lineNow().angle) })} />
          <label for="insp-angle">Angle</label>
          <FieldInput id="insp-angle" type="number" min="-180" max="180" step="5" value={round1(line.angle)}
            onCommit={(angle) => send({ geometry: geometryOf(lineNow().length, angle) })} />
        </>}
        <label for="insp-trim">Trim</label>
        <span class="inspector-trim">
          <input id="insp-trim" type="range" min="0" max="255" value={fix.maxBrightness ?? 255}
            aria-valuetext={`${trimPct} percent`} onChange={(e) => send({ maxBrightness: parseInt(e.target.value, 10) })} />
          <span>{trimPct}%</span>
        </span>
      </div>
      {emission.kind === 'beam' && <p class="setting-help">Angles are degrees: pan 0 points toward the audience; tilt 0 is horizontal and +90 points upward. Spread is the full cone angle.</p>}
      <FixtureHardware fixture={fix} profile={profile} settings={s.hardware} send={send} />
      {hueLamp && <p class="setting-help">A lamp of the entertainment area of the Hue bridge "{hueBridgeLabel(s.hueBridges, fix.output.bridge)}",
        added from Rig → Outputs → Philips Hue: it takes no DMX channels, and each section is sent its rendered colour.</p>}
      <p class="setting-help">{fix.position ? '' : 'Not placed yet: drawn at its default spot. '}
        {bar ? 'At angle 0 its first cell is on the left and its last on the right; 180 is the other way round, and 90 runs from the back of the stage towards the audience.' : ''}</p>
      <div class="inspector-actions">
        <button type="button" class={`btn sm ${identifying.has(fix.id) ? 'active' : ''}`} disabled={!connected}
          onClick={() => identifyFixtures([fix.id])}>Identify</button>
        {bar && <button type="button" class="btn sm" disabled={!connected}
          title="Turn it end for end: for a bar hung the other way round"
          onClick={() => { const now = lineNow(); send({ geometry: geometryOf(now.length, now.angle + 180) }); }}>Reverse</button>}
        {(fix.position || fix.geometry) && <button type="button" class="btn sm" disabled={!connected}
          onClick={() => send({ position: null, geometry: null })}>Reset place</button>}
      </div>
    </aside>
  );
}
