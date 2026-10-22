import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { stagePreviewSig, librarySig, api, pick } from './state.js';
import { createPreviewSampler } from '../src/shared/preview.ts';
import { buildUnitSpace } from '../src/shared/space.ts';
import { liveVoiceEvents, previewOptions } from './preview-inputs.js';

// Track identity resets rehearsal; remounting a view must not rewind it.
export function useRehearsalTrack(autoShow) {
  const t = autoShow && autoShow.track;
  const trackId = t ? `${t.id ?? ''}|${t.name ?? ''}|${t.artist ?? ''}` : null;
  useEffect(() => {
    if (stagePreviewSig.value.trackId === trackId) return;
    stagePreviewSig.value = { ...stagePreviewSig.value, playing: false, position: 0, rehearsal: false, trackId };
  }, [trackId]);
}

/** The rig's unit space from the Stage room, as the engine builds it; `given` is a room already loaded, else it is fetched. */
export function useUnitSpace(rig, rigDeps, given) {
  const [loaded, setLoaded] = useState(null);
  const fetches = given === undefined;
  useEffect(() => {
    if (!fetches) return undefined;
    let live = true;
    api('/api/stage/room').then((r) => { if (live && r && r.ok) setLoaded(r.room ?? null); });
    return () => { live = false; };
  }, [fetches]);
  const room = fetches ? loaded : given;
  return useMemo(() => buildUnitSpace(rig, room), [...rigDeps, room]);
}

export function useRehearsalSampler(data, space = null, enabled = true) {
  const s = pick(['sequence', 'hardware', 'profiles', 'safety', 'hueStrobe', 'paletteOverride', 'basePalette', 'overridePalette', 'voices']);
  const library = librarySig.value;
  const revision = s.sequence ? s.sequence.revision : null;
  const [table, setTable] = useState(null);
  const previous = useRef(null);
  // Only the latest table load may land so overlapping requests cannot restore a stale revision.
  useEffect(() => {
    let live = true;
    api('/api/sequence').then((r) => { if (live) setTable((r && r.ok && r.table) || null); });
    return () => { live = false; };
  }, [revision]);
  const prepared = useMemo(() => {
    if (!enabled) return previous.current;
    const options = { ...previewOptions(s, { table, library }), space };
    return previous.current = { options, key: JSON.stringify([space?.revision, s.voices, options.hueStrobe, options.hardware, options.profiles,
      options.paletteOverride, options.basePalette, options.overridePalette, options.safety, options.sequence && options.sequence.table.revision, library.user]) };
  }, [enabled, space, s.voices, s.hueStrobe, s.hardware, s.profiles, s.paletteOverride, s.basePalette,
    s.overridePalette, s.safety, s.sequence?.playing, s.sequence?.loop, table, library.user]);
  const sampler = useMemo(() => prepared ? createPreviewSampler([...(data?.timeline || []), ...liveVoiceEvents(s.voices)], data, prepared.options) : null, [data, prepared?.key]);
  return enabled ? sampler : null;
}
