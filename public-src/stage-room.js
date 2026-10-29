import { api } from './state.js';

// The room last loaded or saved, kept between views: a mount revalidates it (304 while its revision stands)
// and keeps the same object, so the scene built from it is not rebuilt nor its shaders compiled again.
let known = null;

export const knownRoom = () => known;

export function rememberRoom(result) {
  if (result && result.ok && 'revision' in result) known = { room: result.room ?? null, revision: result.revision };
  return known;
}

/** `{ ok, room, revision }`: the kept object while unchanged; a save or load that landed meanwhile wins. */
export async function loadRoom() {
  const held = known;
  const result = await api('/api/stage/room', held ? { headers: { 'If-None-Match': `"${held.revision}"` } } : undefined);
  if (!result.ok) return result;
  if (known !== held) return { ok: true, ...known };
  if (held && (result.notModified || result.revision === held.revision)) return { ok: true, ...held };
  return { ok: true, ...rememberRoom(result) };
}
