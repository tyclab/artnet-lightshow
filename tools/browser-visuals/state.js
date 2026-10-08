import { createHash } from 'node:crypto';

export class StateMirror {
  constructor(now = () => performance.now()) { this.now = now; this.reset(); }
  reset() { this.state = null; this.versions = null; this.receivedAt = -Infinity; }
  snapshot(snapshot) {
    if (snapshot?.protocol !== 2 || !snapshot.state || !snapshot.versions || !Object.values(snapshot.versions).every(Number.isInteger)) { this.reset(); return false; }
    this.state = { ...snapshot.state };
    this.versions = new Map(Object.entries(snapshot.versions));
    this.receivedAt = this.now();
    return true;
  }
  patch(patch) {
    if (!this.versions || typeof patch?.d !== 'string' || !Number.isInteger(patch.v) || !patch.set || typeof patch.set !== 'object') { this.reset(); return false; }
    const version = this.versions.get(patch.d);
    if (!Number.isInteger(version)) { this.reset(); return false; }
    if (patch.v <= version) return true;
    if (patch.v !== version + 1) { this.reset(); return false; }
    this.state = { ...this.state, ...patch.set };
    for (const key of Array.isArray(patch.del) ? patch.del : []) delete this.state[key];
    this.versions.set(patch.d, patch.v);
    return true;
  }
  target({ fixtureId, width, height }) {
    const state = this.state;
    if (!state || this.now() - this.receivedAt >= 1500) return { ok: false, reason: 'Waiting for fresh state' };
    if (!state.clock || ![state.clock.bpm, state.clock.beatPos, state.clock.at].every(Number.isFinite) || state.clock.bpm <= 0) return { ok: false, reason: 'Waiting for clock state' };
    if (state.armed !== true) return { ok: false, reason: 'Outputs disarmed' };
    if (state.safety?.photosensitivityAcknowledged !== true) return { ok: false, reason: 'Photosensitivity acknowledgement required' };
    const fixture = Array.isArray(state.fixtures) && state.fixtures.find(f => f.id === fixtureId);
    const profile = fixture && state.profiles?.[fixture.profileId];
    if (!fixture || fixture.output?.protocol !== 'ddp' || typeof fixture.output.host !== 'string' || !profile || profile.zoned || profile.grid?.columns !== width || profile.grid?.rows !== height || profile.cells?.length !== width * height) return { ok: false, reason: 'Target is not the expected full RGB DDP grid' };
    const seen = new Set();
    for (let i = 0; i < profile.cells.length; i++) {
      const cell = profile.cells[i], at = cell.at ?? { x: i % width, y: Math.floor(i / width) };
      const index = at.y * width + at.x;
      if (![at.x, at.y].every(Number.isInteger) || at.x < 0 || at.x >= width || at.y < 0 || at.y >= height || seen.has(index) || !['red', 'green', 'blue'].every(c => Number.isInteger(cell.channelMap?.[c]) && cell.channelMap[c] >= 0)) return { ok: false, reason: 'Target RGB grid mapping is invalid' };
      seen.add(index);
    }
    const key = createHash('sha256').update(JSON.stringify({ profile, output: fixture.output })).digest('hex');
    return { ok: true, key };
  }
}
