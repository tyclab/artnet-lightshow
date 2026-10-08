import fs from 'node:fs';
import path from 'node:path';

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${label} configuration cannot be read`); }
}

export function obsConfig(file) {
  const cfg = readJson(file, 'OBS');
  if (cfg.server_enabled !== true || cfg.auth_required !== true || typeof cfg.server_password !== 'string' || !cfg.server_password) throw new Error('OBS requires its authenticated WebSocket server enabled');
  if (!Number.isInteger(cfg.server_port) || cfg.server_port < 1 || cfg.server_port > 65535) throw new Error('Invalid OBS port');
  return { port: cfg.server_port, password: cfg.server_password };
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
  const result = { fixtureId: 53, width: 68, height: 42, fps: 10, scene: 'Party Visuals', fit: 'cover', preview: false, output: 'obs-pixel-preview.ppm' };
  const names = { '--fixture': 'fixtureId', '--width': 'width', '--height': 'height', '--fps': 'fps', '--scene': 'scene', '--fit': 'fit', '--output': 'output', '--obs-config': 'obsConfig', '--nodecg-config': 'nodecgConfig' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { result.help = true; continue; }
    if (args[i] === '--preview' || args[i] === '--dry-run') { result.preview = true; continue; }
    const key = names[args[i]], value = args[++i];
    if (!key || !value || value.startsWith('--')) throw new Error('Unknown or incomplete option; use --help');
    result[key] = ['fixtureId', 'width', 'height', 'fps'].includes(key) ? Number(value) : value;
  }
  if (result.help) return result;
  if (!Number.isInteger(result.fixtureId) || result.fixtureId < 0 || ![result.width, result.height].every(x => Number.isInteger(x) && x > 0 && x <= 256) || result.width * result.height > 4096) throw new Error('Invalid fixture or pixel grid');
  if (!Number.isFinite(result.fps) || result.fps < 1 || result.fps > 10) throw new Error('FPS must be between 1 and 10');
  if (!['cover', 'contain'].includes(result.fit) || !result.scene.trim()) throw new Error('Invalid scene or fit');
  result.obsConfig ??= env.APPDATA && path.join(env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
  result.nodecgConfig ??= env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'PartyVisuals', 'EclipseGraphics', 'cfg', 'party-visuals.json');
  if (!result.obsConfig || (!result.preview && !result.nodecgConfig)) throw new Error('Configuration paths required outside Windows; use --help');
  return result;
}
