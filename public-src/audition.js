import { effect, signal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { stateSig, librarySig, stagePreviewSig, field, pick } from './state.js';
import { previewOptions, resolverOf } from './preview-inputs.js';
import { createPreviewSampler } from '../src/shared/preview.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM, DEMO_DURATION_MS } from '../src/shared/demo-track.ts';

export const auditionSig = signal({ active: false, playing: false, position: 0, id: 'v2.grooveWave', spec: null, name: null, acknowledged: false });
let timer = null;
let last = 0;

export function setAudition(patch) {
  const next = { ...auditionSig.peek(), ...patch };
  if (stateSig.peek().armed) { next.active = false; next.playing = false; }
  auditionSig.value = next;
  if (timer !== null) { clearInterval(timer); timer = null; }
  if (!next.active || !next.playing) return;
  last = performance.now();
  timer = setInterval(() => {
    const now = performance.now(), current = auditionSig.peek();
    const position = Math.min(DEMO_DURATION_MS, current.position + Math.min(250, now - last));
    last = now;
    auditionSig.value = { ...current, position, playing: position < DEMO_DURATION_MS };
    if (position >= DEMO_DURATION_MS) { clearInterval(timer); timer = null; }
  }, 1000 / 30);
}

effect(() => {
  if (field('armed').value && auditionSig.peek().active) setAudition({ active: false, playing: false });
});

export function startAudition(id, spec = null, name = null) {
  if (stateSig.peek().armed) return;
  stagePreviewSig.value = { ...stagePreviewSig.peek(), rehearsal: false, playing: false, edit: false };
  setAudition({ id, spec, name, active: true, playing: true, position: 0 });
}

export function useAuditionSampler(space, enabled = true) {
  const s = pick(['armed', 'hardware', 'profiles', 'safety', 'hueStrobe']), a = auditionSig.value, library = librarySig.value;
  useEffect(() => { if (s.armed && a.active) setAudition({ active: false, playing: false }); }, [s.armed, a.active]);
  const active = enabled && a.active && !s.armed;
  const previous = useRef(null);
  // Wire fields and editor drafts are replaced, never mutated; demo ticks leave these dependencies unchanged.
  const prepared = useMemo(() => {
    if (!active) return previous.current;
    const options = previewOptions(s, { library });
    return previous.current = { options, space, key: JSON.stringify([a.id, a.spec, a.acknowledged, options.hardware, options.profiles,
      options.safety, options.hueStrobe, library.user, space?.revision]) };
  }, [active, a.id, a.spec, a.acknowledged, s.hardware, s.profiles, s.safety, s.hueStrobe, library.user, space?.revision]);
  const sampler = useMemo(() => {
    if (!prepared) return null;
    const { options, space } = prepared;
    const resolve = resolverOf(library.user);
    return createPreviewSampler([{ timeMs: 0, action: 'patch', data: {
      pattern: a.id, bpm: DEMO_BPM, colorA: 0, colorB: 6, colorC: 4, colorD: 8,
      basePalette: { colours: ['#00BFFF', '#FF5090', '#FFA500', '#8C56FF'] },
    } }], null, {
      hardware: options.hardware, profiles: options.profiles, hueStrobe: options.hueStrobe, space,
      safety: { ...options.safety, acknowledged: a.acknowledged || !!options.safety?.acknowledged },
      audioSource: DEMO_AUDIO_SOURCE, resolveEffect: (id) => id === a.id && a.spec ? a.spec : resolve(id),
    });
  }, [prepared?.key, prepared?.space]);
  return active ? sampler : null;
}
