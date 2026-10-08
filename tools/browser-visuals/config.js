import fs from 'node:fs';
import path from 'node:path';

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${label} configuration cannot be read`); }
}

export function lightshowConfig(file) {
  const cfg = readJson(file, 'Party Visuals').lightshow;
  let url;
  try { url = new URL(cfg?.url); } catch { throw new Error('Invalid lightshow URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Lightshow URL must not contain credentials or query parameters');
  if (typeof cfg.tokenFile !== 'string' || !cfg.tokenFile) throw new Error('Party Visuals tokenFile is required');
  const tokenPath = path.resolve(path.dirname(file), '..', cfg.tokenFile);
  let token;
  try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch { throw new Error('Lightshow token file cannot be read'); }
  if (!token) throw new Error('Lightshow token file is empty');
  return { origin: url.origin, socketPath: `${url.pathname.replace(/\/$/, '')}/socket.io`, token };
}

export function options(args, env = process.env) {
  const result = { fixtureId: 53, width: 68, height: 42, fps: 10, fit: 'cover', preview: false, curtain: false, output: 'browser-pixel-preview.ppm', controlsUrl: 'http://127.0.0.1:9090/bundles/party-visuals/api/state' };
  const names = { '--fixture': 'fixtureId', '--width': 'width', '--height': 'height', '--fps': 'fps', '--fit': 'fit', '--output': 'output', '--browser-profile': 'browserProfile', '--visualizer-url': 'visualizerUrl', '--controls-url': 'controlsUrl', '--nodecg-config': 'nodecgConfig', '--parent-pid': 'parentPid' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { result.help = true; continue; }
    if (args[i] === '--preview' || args[i] === '--dry-run') { result.preview = true; continue; }
    if (args[i] === '--curtain') { result.curtain = true; continue; }
    const key = names[args[i]], value = args[++i];
    if (!key || !value || value.startsWith('--')) throw new Error('Unknown or incomplete option; use --help');
    result[key] = ['fixtureId', 'width', 'height', 'fps', 'parentPid'].includes(key) ? Number(value) : value;
  }
  if (result.help) return result;
  if (!Number.isInteger(result.fixtureId) || result.fixtureId < 0 || ![result.width, result.height].every(x => Number.isInteger(x) && x > 0 && x <= 256) || result.width * result.height > 4096) throw new Error('Invalid fixture or pixel grid');
  if (!Number.isFinite(result.fps) || result.fps < 1 || result.fps > 10) throw new Error('FPS must be between 1 and 10');
  if (!['cover', 'contain'].includes(result.fit)) throw new Error('Invalid image fit');
  if (result.parentPid !== undefined && (!Number.isInteger(result.parentPid) || result.parentPid < 1)) throw new Error('Invalid parent process');
  if (!result.browserProfile || !path.isAbsolute(result.browserProfile)) throw new Error('An absolute dedicated browser profile path is required');
  const visualizer = validatedUrl(result.visualizerUrl);
  const route = new URL(visualizer.hash.slice(1), 'http://route.invalid');
  if (visualizer.search || route.pathname !== '/now-playing' || !route.searchParams.get('player') || [...route.searchParams.keys()].some(key => !['player', 'frameless'].includes(key))) throw new Error('Visualizer URL must select a now-playing player without credentials');
  const controls = validatedUrl(result.controlsUrl);
  if (controls.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(controls.hostname) || controls.search || controls.hash || controls.pathname !== '/bundles/party-visuals/api/state') throw new Error('Controls must use the loopback Party Visuals state endpoint');
  if (result.preview && result.curtain) throw new Error('Preview cannot enable curtain output');
  result.nodecgConfig ??= env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'PartyVisuals', 'EclipseGraphics', 'cfg', 'party-visuals.json');
  if (result.curtain && !result.nodecgConfig) throw new Error('Curtain mode requires the Party Visuals configuration path');
  return result;
}

function validatedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid configured URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Configured URLs must not contain credentials');
  return url;
}
