export function selectedClipIds(seq, ids) {
  const selected = new Set(ids);
  for (const group of seq.clipGroups || []) {
    if (group.clipIds.some((id) => selected.has(id))) group.clipIds.forEach((id) => selected.add(id));
  }
  return seq.clips.filter((clip) => selected.has(clip.id)).map((clip) => clip.id);
}

export function groupClips(seq, ids, id) {
  const clipIds = selectedClipIds(seq, ids);
  if (clipIds.length < 2) return seq;
  const selected = new Set(clipIds);
  return { ...seq, clipGroups: [...(seq.clipGroups || []).filter((group) => !group.clipIds.some((member) => selected.has(member))), { id, clipIds }] };
}

export function ungroupClips(seq, ids) {
  const selected = new Set(ids);
  return { ...seq, clipGroups: (seq.clipGroups || []).filter((group) => !group.clipIds.some((id) => selected.has(id))) };
}

export function removeClips(seq, ids) {
  const selected = new Set(selectedClipIds(seq, ids));
  const next = { ...seq, clips: seq.clips.filter((clip) => !selected.has(clip.id)) };
  if (seq.clipGroups) next.clipGroups = seq.clipGroups.map((group) => ({ ...group, clipIds: group.clipIds.filter((id) => !selected.has(id)) })).filter((group) => group.clipIds.length > 1);
  return next;
}

export function moveClips(seq, ids, beats, laneDelta = 0, snap = seq.snap) {
  const selected = new Set(selectedClipIds(seq, ids));
  const clips = seq.clips.filter((clip) => selected.has(clip.id));
  if (!clips.length || !Number.isFinite(beats) || !Number.isFinite(laneDelta)) return seq;
  const lanes = [...seq.lanes.filter((lane) => lane.kind === 'shared'), ...seq.lanes.filter((lane) => lane.kind === 'track')];
  const positions = clips.map((clip) => lanes.findIndex((lane) => lane.id === clip.laneId));
  const requested = snap > 0 ? Math.round(beats / snap) * snap : beats;
  const delta = Math.max(-Math.min(...clips.map((clip) => clip.startBeat)), Math.min(requested,
    Number.MAX_SAFE_INTEGER - Math.max(...clips.map((clip) => clip.startBeat + clip.lengthBeats))));
  const across = Math.max(-Math.min(...positions), Math.min(Math.trunc(laneDelta), lanes.length - 1 - Math.max(...positions)));
  return { ...seq, clips: seq.clips.map((clip) => selected.has(clip.id)
    ? { ...clip, startBeat: clip.startBeat + delta, laneId: lanes[lanes.findIndex((lane) => lane.id === clip.laneId) + across].id } : clip) };
}

/** Why a group move went shorter than asked, or null when every clip moved as requested. */
export function moveShortfall(before, after, id, beats, laneDelta, snap = before.snap) {
  const lanes = [...before.lanes.filter((lane) => lane.kind === 'shared'), ...before.lanes.filter((lane) => lane.kind === 'track')];
  const index = (seq) => lanes.findIndex((lane) => lane.id === seq.clips.find((clip) => clip.id === id)?.laneId);
  const start = (seq) => seq.clips.find((clip) => clip.id === id)?.startBeat;
  const wanted = snap > 0 ? Math.round(beats / snap) * snap : beats;
  const movedBeats = start(after) - start(before), movedLanes = index(after) - index(before);
  if (Math.abs(movedBeats - wanted) < 1e-9 && movedLanes === Math.trunc(laneDelta)) return null;
  return `The selection moved ${movedBeats} beats and ${movedLanes} lanes: another selected or grouped clip reached the start or the last lane.`;
}
