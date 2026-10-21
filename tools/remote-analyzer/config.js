import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REPO = 'https://github.com/tyclab/artnet-lightshow.git';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEYS = ['server', 'tokenFile', 'name', 'dataDir', 'modelData', 'source', 'repo', 'image', 'memory', 'gpuMemory',
  'maxOtherVramMiB', 'allowFullscreen', 'idleStopMin', 'searchCommits'];

export function defaultPaths(env = process.env, home = os.homedir()) {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return { config: path.join(config, 'lightshow-remote-analyzer', 'config.json'), data: path.join(data, 'lightshow-remote-analyzer') };
}

function absolute(value, label, base) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a path`);
  return path.resolve(base, value);
}

function integer(value, label, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}

/** The worker's configuration; the token comes from LIGHTSHOW_WORKER_TOKEN or tokenFile and is never logged. */
export function loadConfig(file, { env = process.env, hostname = os.hostname(), home = os.homedir() } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Remote analyzer configuration ${file} cannot be read`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The configuration must be a JSON object');
  const unknown = Object.keys(raw).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown configuration keys: ${unknown.join(', ')}`);
  const dir = path.dirname(path.resolve(file));

  let url;
  try { url = new URL(raw.server); } catch { throw new Error('server must be the lightshow URL, e.g. http://10.27.2.42:3000'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The server URL must not carry credentials or a query');
  }
  const prefix = url.pathname.replace(/\/$/, '');

  let token = env.LIGHTSHOW_WORKER_TOKEN?.trim() || '';
  if (!token && raw.tokenFile) {
    try { token = fs.readFileSync(absolute(raw.tokenFile, 'tokenFile', dir), 'utf8').trim(); } catch { throw new Error('The worker token file cannot be read'); }
  }
  if (!token) throw new Error('No worker token: set tokenFile or LIGHTSHOW_WORKER_TOKEN');

  const name = raw.name ?? hostname.split('.')[0].toLowerCase();
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('name must be letters, digits, dots, dashes or underscores');
  const dataDir = absolute(raw.dataDir, 'dataDir', dir) ?? defaultPaths(env, home).data;
  const repo = raw.repo ?? DEFAULT_REPO;
  if (typeof repo !== 'string' || !(/^https:\/\/[^\s@]+$/.test(repo) || path.isAbsolute(repo))) throw new Error('repo must be an https URL or an absolute path');
  if (raw.image !== undefined && (typeof raw.image !== 'string' || !/^[a-z0-9][a-z0-9._/:@-]{0,255}$/.test(raw.image))) throw new Error('image must be a Docker image reference');
  const memory = raw.memory ?? '16g';
  if (typeof memory !== 'string' || !/^\d{1,5}[mg]$/.test(memory)) throw new Error('memory must be a Docker size such as 16g');
  const gpuMemory = raw.gpuMemory ?? 'auto';
  if (!['auto', 'offload', 'resident'].includes(gpuMemory)) throw new Error('gpuMemory must be auto, offload or resident');
  const allow = raw.allowFullscreen ?? ['chrome', 'msedge', 'firefox'];
  if (!Array.isArray(allow) || !allow.every((app) => typeof app === 'string' && /^[\w .-]{1,64}$/.test(app))) throw new Error('allowFullscreen must list process names');

  return {
    server: { origin: url.origin, base: `${url.origin}${prefix}`, socketPath: `${prefix}/socket.io` },
    token, name, dataDir, repo,
    modelData: absolute(raw.modelData, 'modelData', dir) ?? path.join(dataDir, 'model-data'),
    source: absolute(raw.source, 'source', dir) ?? null,
    image: raw.image ?? null,
    memory, gpuMemory,
    // GamerTyc's desktop with the party visuals idles at 2.4-3.3 GB of 8; a job peaks at ~3.1 GB more.
    maxOtherVramMiB: integer(raw.maxOtherVramMiB, 'maxOtherVramMiB', 0, 1 << 20, 4096),
    allowFullscreen: allow.map((app) => app.toLowerCase().replace(/\.exe$/, '')),
    idleStopMin: integer(raw.idleStopMin, 'idleStopMin', 0, 1440, 15),
    searchCommits: integer(raw.searchCommits, 'searchCommits', 1, 5000, 400),
  };
}
