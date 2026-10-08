import { canonical } from '../src/shared/effects/layer.ts';

const pending = new Set();

export function sequenceChanged(current, saved) {
  return !!current && (!saved || canonical(current) !== canonical(saved));
}

export function clipAuditionTargets(clip, lanes, fixtures) {
  const lane = lanes.find((entry) => entry.id === clip?.laneId);
  if (!lane) return { targets: null, reason: 'Audition unavailable: this clip has no lane.' };
  const patched = new Set(fixtures.map((fixture) => fixture.id));
  const targets = lane.kind === 'track'
    ? clip.targets === 'lane' || clip.targets.includes(lane.fixtureId) ? [lane.fixtureId] : []
    : clip.targets === 'lane' ? [...patched] : clip.targets;
  if (!targets.length || targets.some((id) => !patched.has(id))) {
    return { targets: null, reason: 'Audition unavailable: check the clip’s fixture targets in Rig.' };
  }
  return { targets, reason: null };
}

export async function trackSequenceEdit(operation) {
  let settled;
  const done = new Promise((resolve) => { settled = resolve; });
  pending.add(done);
  try { return await operation(); } finally { pending.delete(done); settled(); }
}

export async function settleSequenceEdits() {
  while (pending.size) await Promise.allSettled([...pending]);
}

export async function confirmSequenceReplacement(request, confirm = (message) => window.confirm(message)) {
  // A blurred field may still be saving when the operator chooses another transport.
  await settleSequenceEdits();
  const [loaded, shelf] = await Promise.all([request('/api/sequence'), request('/api/sequences')]);
  if (!loaded?.ok || !shelf?.ok) return false;
  const current = loaded.sequence;
  if (!current) return true;
  const saved = shelf.sequences.find((s) => s.id === current.id);
  const recording = !!loaded.status?.recording;
  if (!sequenceChanged(current, saved) && !recording) return true;
  return confirm(`Discard unsaved changes to “${current.name}”${recording ? ' and its pending take' : ''}? ${recording ? 'Keep the take and save' : 'Save'} the sequence first to keep your work.`);
}
