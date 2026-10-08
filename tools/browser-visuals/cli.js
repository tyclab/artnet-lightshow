import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { options } from './config.js';
import { connectPage, captureCanvas, ppm } from './browser.js';

const help = `Usage: node cli.js --browser-profile PATH --visualizer-url URL [options]
Default: display only, with no lightshow connection or fixture lease.
  --controls-url URL    Loopback Party Visuals api/state endpoint
  --curtain             Explicitly enable transient curtain pixel input
  --preview             Save one local capture and exit, without a lease
  --output PATH         Preview PPM file (default: browser-pixel-preview.ppm)
  --fixture ID          Existing RGB DDP grid fixture (default: 53)
  --width N --height N  Logical grid dimensions (default: 68 x 42)
  --fps N               1..10 frames/second (default: 10)
  --fit cover|contain   Center crop or black letterbox (default: cover)
  --nodecg-config PATH  Party Visuals config (default: Windows LOCALAPPDATA)
  --parent-pid PID      Stop if the supervising launcher exits
Chrome must use a dedicated profile with an ephemeral loopback debugging port.
Only the configured Music Assistant now-playing player page is accessed.
Wash on/off controls display visibility; wash intensity does not dim MilkDrop.
Curtain mode never arms outputs. Ctrl+C or stdin 'stop' releases its lease.
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
  let stopped = false, browser = null, curtain = null, browserRetryAt = 0, ready = false;
  let controls = { ok: false, visible: false }, controlsAt = -Infinity, lastStatus = '', input = '';
  const report = status => { if (status !== lastStatus) { lastStatus = status; log(status); } };
  const sourceReady = () => !stopped && ready && browser?.connected && controls.ok && performance.now() - controlsAt < 1500;
  if (settings.curtain) {
    const { connectCurtain } = await import('./curtain.js');
    curtain = await connectCurtain(settings, () => captureCanvas(browser, settings, controls.visible), sourceReady, report);
  }
  const stop = () => { stopped = true; ready = false; void curtain?.pump.stop(); };
  const onInput = chunk => {
    // Windows PowerShell's redirected stdin starts with a UTF-8 BOM.
    input = (input + chunk.toString()).replaceAll('﻿', '').slice(-100);
    if (/(^|\n)stop\r?\n/.test(input)) stop();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); stdin.on('data', onInput);
  const parentTimer = setInterval(() => { if (!parentAlive(settings.parentPid)) stop(); }, 1000);
  report(settings.curtain ? 'Browser display with optional curtain output' : 'Browser display only; no lightshow connection');
  try {
    while (!stopped) {
      const started = performance.now();
      if (started - controlsAt >= 250) { controls = await readState(settings.controlsUrl); controlsAt = performance.now(); }
      if (!browser?.connected && started >= browserRetryAt) {
        try {
          browser = await attach(settings.browserProfile, settings.visualizerUrl, () => { ready = false; void curtain?.pump.invalidate(); });
        } catch { browser = null; browserRetryAt = performance.now() + 3000; report('Waiting for the dedicated Music Assistant browser'); }
      }
      if (!stopped && browser?.connected) {
        try {
          ready = (await browser.action({ mode: 'display', visible: controls.visible })).ok;
          if (!settings.curtain) report(!controls.ok ? 'Controls unavailable; display covered' : ready ? controls.visible ? 'Music Assistant visible' : 'Music Assistant covered' : 'Waiting for Music Assistant login or player page');
        } catch { ready = false; await browser.close(); browser = null; browserRetryAt = performance.now() + 1000; }
      } else ready = false;
      if (curtain) await curtain.pump.step();
      await sleep(settings.curtain ? Math.max(10, curtain.pump.nextCaptureAt - performance.now(), 1000 / settings.fps) : 250);
    }
  } finally {
    clearInterval(parentTimer); await curtain?.stop(); await browser?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); stdin.removeListener('data', onInput); stdin.pause();
    report('Browser helper stopped; any pixel lease released or expiring');
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
