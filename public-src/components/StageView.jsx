import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { pick, connectedSig, dmxSig, stagePreviewSig } from '../state.js';
import { fmtTime, rigLights } from '../utils.js';
import { useDmxFeed } from '../use-dmx.js';
import { useTimeline } from '../use-timeline.js';
import { useRehearsalTrack, useRehearsalSampler } from '../rehearsal.js';
import { placeRig, roomRig, lightRGB, STAGE_W, STAGE_D, TRUSS_H } from '../stage3d/world.js';
import { buildRig, rigSignature } from '../../src/shared/rig.ts';
import { StageRoomPanel } from './StageRoomPanel.jsx';

const VIEWS = [
  { id: 'audience', label: 'Audience' },
  { id: 'above', label: 'Above' },
  { id: 'side', label: 'Side' },
];

const readHaze = () => {
  try {
    const v = Number(localStorage.getItem('lightshow.stage.haze'));
    return Number.isFinite(v) && localStorage.getItem('lightshow.stage.haze') !== null ? Math.max(0, Math.min(100, v)) : 60;
  } catch {
    return 60;
  }
};

export function StageView() {
  const s = pick(['fixtures', 'profiles', 'colorPresets', 'autoShow']);
  const connected = connectedSig.value;
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const { data } = useTimeline();
  const ui = stagePreviewSig.value;
  const rehearsing = ui.rehearsal && !!data;
  const durationMs = data && data.duration ? data.duration * 1000 : 0;
  const [status, setStatus] = useState('loading');   // loading | ready | nowebgl | error
  const [view, setView] = useState('audience');
  const [haze, setHaze] = useState(readHaze);
  const [roomState, setRoomState] = useState({ room: null, revision: null });
  const [cutaway, setCutaway] = useState(true);
  const room = roomState.room;
  const canvas = useRef(null);
  const scene = useRef(null);
  useRehearsalTrack(s.autoShow);
  useDmxFeed(!rehearsing);

  // The rig changes only when the patch does: compare its signature.
  const signature = rigSignature(fixtures, JSON.stringify(Object.keys(profiles)));
  const rig = useMemo(() => buildRig(fixtures, (f) => profiles[f.profileId] || null), [signature]);
  const placed = useMemo(() => room ? roomRig(fixtures, rig, room) : placeRig(fixtures, profiles, rig), [rig, room, fixtures, profiles]);
  const sample = useRehearsalSampler(data);

  // What the frame loop reads, without restarting it for every change.
  const live = useRef({});
  live.current = { fixtures, profiles, rig, sample, rehearsing, presets: s.colorPresets, durationMs };

  useEffect(() => {
    let cancelled = false;
    import('../stage3d/scene.js')
      .then(({ createStageScene }) => {
        if (cancelled || !canvas.current) return;
        try {
          scene.current = createStageScene(canvas.current, {
            haze: haze / 100, room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H }, lightRGB,
          });
          scene.current.resize();
          setStatus('ready');
        } catch {
          setStatus('nowebgl');
        }
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => {
      cancelled = true;
      if (scene.current) scene.current.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (status === 'ready') scene.current.setRig(placed, rig.units.length);
  }, [status, placed]);

  useEffect(() => { if (status === 'ready') scene.current.setRoom(room); }, [status, room]);
  useEffect(() => { if (status === 'ready') scene.current.setCutaway(cutaway); }, [status, cutaway]);

  useEffect(() => {
    try { localStorage.setItem('lightshow.stage.haze', String(haze)); } catch { /* private mode */ }
    if (scene.current) scene.current.setHaze(haze / 100);
  }, [haze]);

  useEffect(() => { if (scene.current) scene.current.view(view); }, [view, status]);

  // The frame loop: the display's rate. Live frames are read from the DMX
  // feed when a new one arrives; a rehearsal is sampled every frame, and a
  // playing one moves on by the time since the last.
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const box = canvas.current.parentElement;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scene.current && scene.current.resize()) : null;
    if (observer) observer.observe(box);
    let raf = 0;
    let lastDmx = null;
    let liveFrame = null;
    let lastNow = performance.now();
    let lastPublish = 0;
    let position = stagePreviewSig.value.position;
    const tick = (now) => {
      const cur = live.current;
      const st = stagePreviewSig.value;
      if (cur.rehearsing) {
        if (st.playing && cur.durationMs) {
          position = Math.min(cur.durationMs, position + Math.min(250, now - lastNow));
          // The scrubber follows at a tenth of the frame rate; the stage at all of it.
          if (now - lastPublish > 100 || position >= cur.durationMs) {
            lastPublish = now;
            stagePreviewSig.value = { ...st, position, playing: position < cur.durationMs };
          }
        } else {
          position = st.position;
        }
        scene.current.setLights(cur.sample(position, cur.fixtures, cur.presets, cur.rig));
      } else {
        position = st.position;
        const dmx = dmxSig.value;
        if (dmx !== lastDmx || !liveFrame) {
          lastDmx = dmx;
          // What is on the wire, as it is: the feed already carries overrides,
          // the masters and identify.
          const raw = cur.fixtures.map((f) => (f.override ? { ...f, override: null } : f));
          liveFrame = rigLights(raw, { profiles: cur.profiles, masterBlackout: false, masterDimmer: 255 }, dmx, cur.rig);
        }
        scene.current.setLights(liveFrame);
      }
      lastNow = now;
      scene.current.render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
    };
  }, [status]);

  const onKeyDown = (e) => {
    if (!scene.current) return;
    const step = e.shiftKey ? 0.35 : 0.1;
    const moves = {
      ArrowLeft: { turn: -step }, ArrowRight: { turn: step },
      ArrowUp: { tilt: -step }, ArrowDown: { tilt: step },
      '+': { zoom: 0.85 }, '=': { zoom: 0.85 }, '-': { zoom: 1.18 }, _: { zoom: 1.18 },
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    scene.current.nudge(move);
  };

  const setUi = (patch) => { stagePreviewSig.value = { ...stagePreviewSig.value, ...patch }; };
  const parts = rig.units.length;
  const bars = rig.cellMaps.filter(Boolean).length;
  const description = `The rig in 3D from ${view === 'audience' ? 'the audience' : view === 'above' ? 'above' : 'the side'}: `
    + `${fixtures.length} fixtures${bars ? `, ${bars} of them bars` : ''}, ${parts} lights, `
    + `${rehearsing ? `rehearsing the track at ${fmtTime(ui.position)}` : connected ? 'showing the live output' : 'offline'}.`;

  return (
    <div class="stage3d-view">
      <StageRoomPanel snapshot={roomState} coverage={room ? placed : null} fixtures={fixtures} rig={rig} onChange={setRoomState} />
      <div class="stage3d-tools" role="toolbar" aria-label="Stage view">
        <span class="panel-tag">{rehearsing ? 'Rehearsal' : connected ? 'Live output' : 'Offline'}</span>
        <div class="segmented" role="group" aria-label="Viewpoint">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" class={`segmented-btn ${view === v.id ? 'active' : ''}`} aria-pressed={view === v.id}
              onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        {room && <button type="button" class="btn sm" aria-pressed={cutaway} onClick={() => setCutaway(!cutaway)}>Cutaway walls</button>}
        <label class="stage3d-haze">
          <span>Haze</span>
          <input type="range" min="0" max="100" value={haze} aria-valuetext={`${haze} percent`}
            onInput={(e) => setHaze(Number(e.target.value))} />
        </label>
        <span class="stage3d-sep" aria-hidden="true" />
        <button type="button" class={`btn sm ${rehearsing ? 'active' : ''}`} aria-pressed={rehearsing} disabled={!data}
          title={data ? 'Play the loaded track\'s show here, at any moment of it' : 'Rehearsal needs an analysed track'}
          onClick={() => setUi({ rehearsal: !rehearsing, playing: false })}>{rehearsing ? 'Back to live' : 'Rehearse track'}</button>
        {rehearsing && <>
          <button type="button" class="btn sm" onClick={() => setUi({ position: ui.position >= durationMs ? 0 : ui.position, playing: !ui.playing })}>
            {ui.playing ? 'Pause' : 'Play'}
          </button>
          <input class="stage3d-scrub" type="range" min="0" max={durationMs} step="50" value={ui.position} aria-label="Rehearsal position"
            aria-valuetext={fmtTime(ui.position)} onInput={(e) => setUi({ position: Number(e.target.value) })} />
          <span class="stage3d-time">{fmtTime(ui.position)} / {fmtTime(durationMs)}</span>
        </>}
      </div>
      <div class="stage3d-wrap">
        <canvas ref={canvas} class="stage3d-canvas" tabIndex={0} role="img" aria-label={description} onKeyDown={onKeyDown} />
        {status === 'loading' && <p class="stage3d-note">Setting the stage…</p>}
        {status === 'nowebgl' && (
          <p class="stage3d-note" role="alert">The 3D stage needs WebGL, which this browser has turned off. The plan in the Manual
            and Rig views shows the same rig from above.</p>
        )}
        {status === 'error' && <p class="stage3d-note" role="alert">The 3D stage could not be loaded. Reload the page to try again.</p>}
        {status === 'ready' && !fixtures.length && <p class="stage3d-note">Nothing is patched yet: add fixtures in the Rig view.</p>}
        {status === 'ready' && room && fixtures.length > 0 && !placed.lamps.length && !placed.cells.length && <p class="stage3d-note">This room has no positions for the current fixtures. Review its bindings above.</p>}
      </div>
      <p class="look-note">
        Drag to look around, scroll or pinch to move closer; on the stage, the arrow keys turn and tilt and + and − move
        closer. {room ? `${room.name}: imported light positions; missing bindings are listed above. `
          : 'Generic venue: fixture heights follow the plan when set; otherwise groups supply approximate mounting heights. '}{rehearsing
          ? 'Rehearsing: the planned show, as the timeline has it; nothing goes out to the rig.'
          : 'Live: what is going out to the rig now.'}
      </p>
    </div>
  );
}
