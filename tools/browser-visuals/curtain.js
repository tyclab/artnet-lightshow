import { lightshowConfig } from './config.js';
import { StateMirror } from './state.js';
import { LeasePump } from './pump.js';

export async function connectCurtain(settings, capture, sourceReady, report) {
  const { io } = await import('socket.io-client');
  const config = lightshowConfig(settings.nodecgConfig), mirror = new StateMirror();
  const socket = io(config.origin, { path: config.socketPath, auth: { token: config.token, protocol: 2 }, transports: ['websocket'], autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000, timeout: 3000 });
  const request = (event, payload) => new Promise((resolve, reject) => {
    if (!socket.connected) { reject(new Error('Lightshow disconnected')); return; }
    const ack = (error, response) => error ? reject(new Error('Lightshow acknowledgement timed out')) : resolve(response);
    const send = socket.timeout(600).volatile;
    if (payload === undefined) send.emit(event, ack); else send.emit(event, payload, ack);
  });
  let stopped = false, syncing = false;
  const pump = new LeasePump({
    transport: { get connected() { return socket.connected; }, get id() { return socket.id; }, request },
    capture, ...settings, report,
    target: () => sourceReady() ? mirror.target(settings) : { ok: false, reason: 'Browser display or controls unavailable' },
  });
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
  socket.on('connect', () => { mirror.reset(); void pump.invalidate(); void fresh(); });
  socket.on('disconnect', () => { mirror.reset(); void pump.invalidate(); });
  socket.on('connect_error', () => { mirror.reset(); report('Lightshow connection unavailable'); });
  socket.on('snapshot', snapshot => { if (socket.connected) mirror.snapshot(snapshot); });
  socket.on('patch', patch => {
    if (!mirror.patch(patch)) void fresh();
    if (!mirror.target(settings).ok) void pump.invalidate();
  });
  const syncTimer = setInterval(() => void fresh(), 750);
  socket.connect();
  return {
    pump,
    async stop() { stopped = true; clearInterval(syncTimer); await pump.stop(); socket.disconnect(); },
  };
}
