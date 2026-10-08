import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { options, obsConfig, lightshowConfig } from './config.js';
import { connectObs, sceneCapture } from './obs.js';
import { StateMirror } from './state.js';
import { LeasePump } from './pump.js';
import { ppm } from './bmp.js';

const help = `Usage: node cli.js [--preview|--dry-run] [options]
  --scene NAME          OBS scene only (default: Party Visuals)
  --fixture ID          Existing RGB DDP grid fixture (default: 53)
  --width N --height N  Logical grid dimensions (default: 68 x 42)
  --fps N               1..10 frames/second (default: 10)
  --fit cover|contain   Center crop or black letterbox (default: cover)
  --obs-config PATH     OBS WebSocket config.json (default: Windows APPDATA)
  --nodecg-config PATH  Party Visuals config (default: Windows LOCALAPPDATA)
  --output PATH         Preview PPM file (default: obs-pixel-preview.ppm)
Preview reads OBS only and never contacts the lightshow or claims a fixture.
Live mode never arms outputs or changes the rig. Ctrl+C releases its transient lease.
Credentials are read from existing config/token files, never command arguments.
`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function preview(settings) {
  const obs = await connectObs(obsConfig(settings.obsConfig));
  try {
    const capture = await sceneCapture(obs, settings), image = await capture();
    await fs.writeFile(settings.output, ppm(image), { mode: 0o600 });
    console.log(`Preview saved: ${image.width} x ${image.height} logical RGB pixels. No lightshow connection.`);
  } finally { obs.close(); }
}

export async function live(settings) {
  const { io } = await import('socket.io-client');
  const config = lightshowConfig(settings.nodecgConfig), mirror = new StateMirror();
  const socket = io(config.origin, { path: config.socketPath, auth: { token: config.token, protocol: 2 }, transports: ['websocket'], autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000, timeout: 3000 });
  const request = (event, payload) => new Promise((resolve, reject) => {
    if (!socket.connected) { reject(new Error('Lightshow disconnected')); return; }
    const ack = (error, response) => error ? reject(new Error('Lightshow acknowledgement timed out')) : resolve(response);
    const send = socket.timeout(600).volatile;
    if (payload === undefined) send.emit(event, ack); else send.emit(event, payload, ack);
  });
  let stopped = false, syncing = false, obs = null, capture = null, obsRetryAt = 0, lastStatus = '';
  const report = status => { if (status !== lastStatus) { lastStatus = status; console.log(status); } };
  const pump = new LeasePump({
    transport: { get connected() { return socket.connected; }, get id() { return socket.id; }, request },
    capture: async () => { if (!obs?.connected || !capture) throw new Error('OBS unavailable'); return capture(); },
    target: () => mirror.target(settings), ...settings, report,
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
  const stop = () => { stopped = true; void pump.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const syncTimer = setInterval(() => void fresh(), 750);
  socket.connect();
  try {
    while (!stopped) {
      const started = performance.now();
      if (!obs?.connected && started >= obsRetryAt) {
        try {
          let connection = null;
          connection = await connectObs(obsConfig(settings.obsConfig), () => {
            if (connection && obs === connection) { capture = null; void pump.invalidate(); }
          });
          obs = connection;
          capture = await sceneCapture(obs, settings);
        } catch { obs?.close(); obs = null; capture = null; obsRetryAt = performance.now() + 3000; report('OBS connection unavailable'); }
      }
      if (!stopped && obs?.connected && capture) await pump.step();
      else await pump.invalidate();
      const frameWait = pump.nextCaptureAt - performance.now();
      await sleep(Math.max(1, frameWait > 0 ? frameWait : 1000 / settings.fps));
    }
  } finally {
    clearInterval(syncTimer); await pump.stop(); socket.disconnect(); obs?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    report('Stopped; pixel lease released or expiring');
  }
}

export async function main(args = process.argv.slice(2)) {
  const settings = options(args);
  if (settings.help) { console.log(help); return; }
  if (settings.preview) await preview(settings); else await live(settings);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('OBS pixel client failed. Check configuration paths, authenticated services and --help.'); process.exitCode = 1; });
}
