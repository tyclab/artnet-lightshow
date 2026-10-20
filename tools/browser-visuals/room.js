import { lightshowConfig } from './config.js';
import { StateMirror } from './state.js';
import { LeasePump, targetWithSource } from './pump.js';
import { requester } from './request.js';

/** One colour per rig unit: the small cover-fitted capture read at each unit's plan position
 * (percent of the stage plot; the plot's top is the room's front), a 3 x 3 box average so a
 * single bright pixel does not flicker a lamp. Matrix cells are sent black: the server ignores them. */
export function sampleUnits(image, units) {
  const out = new Uint8Array(units.length * 3);
  const { width, height, data } = image;
  units.forEach((unit, i) => {
    if (unit.grid) return;
    const cx = Math.min(width - 1, Math.max(0, Math.round((unit.x / 100) * (width - 1))));
    const cy = Math.min(height - 1, Math.max(0, Math.round((unit.y / 100) * (height - 1))));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const at = (y * width + x) * 3;
      r += data[at]; g += data[at + 1]; b += data[at + 2]; n++;
    }
    out[i * 3] = Math.round(r / n); out[i * 3 + 1] = Math.round(g / n); out[i * 3 + 2] = Math.round(b / n);
  });
  return out;
}

/** The room picture's wire protocol: one lease over the whole rig, bound to the rig signature. */
export const roomProtocol = {
  events: { claim: 'picture:claim', frame: 'picture:frame', release: 'picture:release' },
  claim: (pump, target) => ({ signature: target.signature }),
  accepts: (pump, response) => response.format === 'rgb24' && response.order === 'units' && response.ttlMs === 2000
    && Number.isFinite(response.maxFps) && response.maxFps >= 1 && Number.isInteger(response.units) && response.units === pump.units?.length,
  // One colour per unit, and the small picture itself for the screens in the Stage.
  frame: (pump, lease, payload) => ({ leaseId: lease.id, data: payload.data, image: payload.image }),
  release: (pump, lease) => ({ leaseId: lease.id }),
  image: (pump, image) => image && image.width === pump.width && image.height === pump.height && image.data instanceof Uint8Array
    && image.data.length === pump.width * pump.height * 3 && pump.units
    ? { data: sampleUnits(image, pump.units), image: { width: image.width, height: image.height, data: image.data } } : null,
};

/** The room target: fresh state, armed, acknowledged, and a unit list for the rig the server reports. */
export function roomTarget(state, units) {
  if (!state.ok) return state;
  if (!units) return { ok: false, reason: 'Waiting for the rig\'s unit positions' };
  return { ok: true, key: units.signature, signature: units.signature };
}

export async function connectRoom(settings, capture, source, report) {
  const { io } = await import('socket.io-client');
  const config = lightshowConfig(settings.nodecgConfig), mirror = new StateMirror();
  const socket = io(config.origin, { path: config.socketPath, auth: { token: config.token, protocol: 2 }, transports: ['websocket'], autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000, timeout: 3000 });
  const request = requester(socket);
  let stopped = false, syncing = false, units = null, unitsAt = -Infinity;
  const pump = new LeasePump({
    transport: { get connected() { return socket.connected; }, get id() { return socket.id; }, request },
    capture, fixtureId: 0, width: settings.roomWidth, height: settings.roomHeight, fps: settings.fps, now: () => performance.now(), report,
    protocol: roomProtocol,
    target: () => targetWithSource(source, () => roomTarget(mirror.base(), units)),
  });
  const refreshUnits = async () => {
    if (!socket.connected || stopped) return;
    try {
      const answer = await request('picture:units');
      if (answer?.ok && Array.isArray(answer.list) && typeof answer.signature === 'string') {
        if (!units || units.signature !== answer.signature) { units = { signature: answer.signature, list: answer.list }; pump.units = answer.list; await pump.invalidate(); }
        unitsAt = performance.now();
      }
    } catch { /* the next tick asks again */ }
  };
  const fresh = async () => {
    if (syncing || !socket.connected || stopped) return;
    syncing = true;
    const connectionId = socket.id;
    try {
      const snapshot = await request('sync');
      if (socket.id === connectionId && socket.connected && !stopped) mirror.snapshot(snapshot);
    } catch { mirror.reset(); await pump.invalidate(); }
    finally { syncing = false; }
  };
  socket.on('connect', () => { mirror.reset(); units = null; pump.units = null; void pump.invalidate(); void fresh(); void refreshUnits(); });
  socket.on('disconnect', () => { mirror.reset(); void pump.invalidate(); });
  socket.on('connect_error', () => { mirror.reset(); report('Lightshow connection unavailable'); });
  socket.on('snapshot', snapshot => { if (socket.connected) mirror.snapshot(snapshot); });
  socket.on('patch', patch => {
    if (!mirror.patch(patch)) void fresh();
    // A re-patched or re-placed rig changes the unit list: ask for it again at once.
    if (patch?.set && ('fixtures' in patch.set || 'profiles' in patch.set)) void refreshUnits();
  });
  const syncTimer = setInterval(() => { void fresh(); if (performance.now() - unitsAt > 30_000) void refreshUnits(); }, 750);
  socket.connect();
  return {
    pump,
    armed: () => socket.connected && mirror.armed(),
    async stop() { stopped = true; clearInterval(syncTimer); await pump.stop(); socket.disconnect(); },
  };
}
