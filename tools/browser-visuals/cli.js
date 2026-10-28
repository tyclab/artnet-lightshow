import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { options } from './config.js';
import { connectPage, captureCanvas, ppm } from './browser.js';
import { startTelemetry } from './telemetry.js';
import { displayHold } from './awake.js';
import { statusSnapshot, statusWriter } from './status.js';

const help = `Usage: node cli.js --browser-profile PATH --visualizer-url URL [options]
Default: display only, with no lightshow connection or fixture lease.
  --controls-url URL    Loopback Party Visuals api/state endpoint
  --curtain             Explicitly enable transient curtain pixel input
  --panels ID:WxH,...   Additional RGB DDP grids, e.g. 38:20x6,39:20x6
  --room                Paint every placed lamp from the picture (one colour per unit at its plan position)
  --room-width N --room-height N  Capture size the room picture is sampled from (default: 64 x 36)
  --preview             Save one local capture and exit, without a lease
  --output PATH         Preview PPM file (default: browser-pixel-preview.ppm)
  --fixture ID          Existing RGB DDP grid fixture (default: 53)
  --width N --height N  Logical grid dimensions (default: 68 x 42)
  --fps N               1..60 input frames/second, negotiated with server (default: 44)
  --fit cover|contain   Center crop or black letterbox (default: cover)
  --nodecg-config PATH  Party Visuals config (default: Windows LOCALAPPDATA)
  --parent-pid PID      Stop if the supervising launcher exits
  --telemetry-file PATH Optional bounded NDJSON log (otherwise summaries use stdout)
  --status-file PATH    Optional atomic readiness snapshot for a local controller
Chrome must use a dedicated profile with an ephemeral loopback debugging port.
Only the configured Music Assistant now-playing player page is accessed.
Wash on/off controls display visibility; wash intensity does not dim MilkDrop.
Pixel modes never arm outputs. Ctrl+C or stdin 'stop' releases every lease.
With pixel or room output on Windows, the displays stay awake while outputs are armed.
Credentials stay in this process and are never sent to the browser.
`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readControls(url, fetcher = fetch) {
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(600) });
    if (!response.ok) return { ok: false, visible: false };
    const text = await response.text();
    if (text.length > 65_536) return { ok: false, visible: false };
    const state = JSON.parse(text);
    if (typeof state.controls?.wash?.on !== 'boolean') return { ok: false, visible: false };
    return { ok: true, visible: state.controls.wash.on };
  } catch { return { ok: false, visible: false }; }
}

export function parentAlive(pid, kill = process.kill) {
  if (!pid) return true;
  try { kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function preview(settings) {
  const browser = await connectPage(settings.browserProfile, settings.visualizerUrl);
  try {
    const image = await captureCanvas(browser, settings);
    await fs.writeFile(settings.output, ppm(image), { mode: 0o600 });
    console.log(`Preview saved: ${image.width} x ${image.height} logical RGB pixels. No lightshow connection.`);
  } finally { await browser.close(); }
}

export async function run(settings, dependencies = {}) {
  const attach = dependencies.connectPage ?? connectPage, readState = dependencies.readControls ?? readControls;
  const stdin = dependencies.stdin ?? process.stdin, log = dependencies.log ?? console.log;
  const attachCurtain = dependencies.connectCurtain ?? (async (...args) => (await import('./curtain.js')).connectCurtain(...args));
  const attachRoom = dependencies.connectRoom ?? (async (...args) => (await import('./room.js')).connectRoom(...args));
  let stopped = false, browser = null, browserRetryAt = 0, ready = false, live = false, reason = null;
  let controls = { ok: false, visible: false }, controlsAt = -Infinity, lastStatus = '', input = '';
  const report = status => { if (status !== lastStatus) { lastStatus = status; log(status); } };
  // A visualizer Music Assistant faded out after playback stopped is idle: wait for it rather than fail captures.
  const source = () => stopped || !ready || !browser?.connected || !controls.ok || performance.now() - controlsAt >= 1500
    ? { ok: false, reason: 'Browser display or controls unavailable' } : live ? { ok: true } : { ok: false, reason: 'Visualizer idle', idle: true };
  const feeds = [], captures = new Map();
  const feedReport = name => {
    let previous;
    return status => { if (status !== previous) { previous = status; log(`${name}: ${status}`); } };
  };
  const capture = target => () => {
    const key = `${target.width}x${target.height}:${target.fit}`;
    const cached = captures.get(key);
    if (!cached || performance.now() - cached.at > 1000 / (target.fps ?? 44)) captures.set(key, { at: performance.now(), image: captureCanvas(browser, target, controls.visible) });
    return captures.get(key).image;
  };
  const panels = [...(settings.curtain ? [{ name: 'curtain', ...settings }] : []), ...(settings.panels ?? []).map(panel => ({ ...settings, ...panel, name: `panel:${panel.fixtureId}` }))];
  for (const panel of panels) feeds.push([panel.name, await attachCurtain(panel, capture(panel), source, feedReport(panel.name))]);
  if (settings.room) {
    const small = { ...settings, width: settings.roomWidth, height: settings.roomHeight, fit: 'cover' };
    feeds.push(['room', await attachRoom(settings, capture(small), source, feedReport('room'))]);
  }
  // Only an output mode learns whether the lightshow is armed.
  const hold = feeds.length ? dependencies.displayHold ?? displayHold(log) : null;
  const stop = () => { stopped = true; ready = false; for (const [, feed] of feeds) void feed.pump.stop(); };
  const onInput = chunk => {
    // Windows PowerShell's redirected stdin starts with a UTF-8 BOM.
    input = (input + chunk.toString()).replaceAll('﻿', '').slice(-100);
    if (/(^|\n)stop\r?\n/.test(input)) stop();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); stdin.on('data', onInput);
  const parentTimer = setInterval(() => { if (!parentAlive(settings.parentPid)) stop(); }, 1000);
  const stopTelemetry = startTelemetry(feeds.map(([name, feed]) => [name, feed.pump]), settings.telemetryFile, log, () => ({ displayHeld: hold ? hold.held : null }));
  const writeStatus = statusWriter(settings.statusFile, log);
  const snapshot = () => statusSnapshot({ connected: browser?.connected, ready, live, reason, visible: controls.visible, stopped, feeds });
  const statusTimer = settings.statusFile ? setInterval(() => { void writeStatus(snapshot()); }, 1000) : null;
  report(feeds.length ? `Browser display with ${feeds.map(([name]) => name).join(', ')} output` : 'Browser display only; no lightshow connection');
  try {
    while (!stopped) {
      const started = performance.now();
      // A timer can wake a hair early: a poll due this tick must not slip to the next one and act on stale controls.
      if (started - controlsAt >= 240) { controls = await readState(settings.controlsUrl); controlsAt = performance.now(); }
      if (!browser?.connected && started >= browserRetryAt) {
        try {
          browser = await attach(settings.browserProfile, settings.visualizerUrl, () => { ready = false; captures.clear(); for (const [, feed] of feeds) void feed.pump.invalidate(); });
        } catch { browser = null; browserRetryAt = performance.now() + 3000; report('Waiting for the dedicated Music Assistant browser'); }
      }
      if (!stopped && browser?.connected) {
        try {
          const shown = await browser.action({ mode: 'display', visible: controls.visible });
          ready = shown.ok; live = shown.live === true; reason = shown.reason ?? null;
          if (!feeds.length) report(!controls.ok ? 'Controls unavailable; display covered' : !ready ? 'Waiting for Music Assistant login or player page'
            : !controls.visible ? 'Music Assistant covered' : live ? 'Music Assistant visualizer visible'
              : reason === 'visualizer-idle' ? 'Visualizer idle; player artwork visible' : 'Visualizer unavailable; enable it in the player. Artwork remains visible');
        } catch { ready = false; await browser.close(); browser = null; browserRetryAt = performance.now() + 1000; }
      } else ready = false;
      hold?.update(feeds.some(([, feed]) => feed.armed()));
      captures.clear();
      const pumps = feeds.map(([, feed]) => feed.pump);
      await Promise.all(pumps.map(pump => pump.step()));
      await sleep(pumps.length ? Math.min(250, Math.max(1, Math.min(...pumps.map((pump) => Math.max(pump.nextCaptureAt, pump.retryAt))) - performance.now())) : 250);
    }
  } finally {
    hold?.stop();
    stopped = true; ready = false; live = false;
    if (statusTimer) clearInterval(statusTimer);
    stopTelemetry();
    clearInterval(parentTimer); await Promise.all(feeds.map(([, feed]) => feed.stop())); await browser?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); stdin.removeListener('data', onInput); stdin.pause();
    report('Browser helper stopped; any pixel lease released or expiring');
    if (settings.statusFile) await writeStatus(snapshot());
  }
}

export async function main(args = process.argv.slice(2)) {
  const settings = options(args);
  if (settings.help) { console.log(help); return; }
  if (settings.preview) await preview(settings); else await run(settings);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Browser visuals failed. Check dedicated profile, configured URLs and --help.'); process.exitCode = 1; });
}
