import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOCKERFILE = path.join(import.meta.dirname, 'Dockerfile');
export const PREFIX = 'lsremote';
const VENVS_KEPT = 2;

export function docker(args, { input, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { maxBuffer: 64 << 20, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0]}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export function imageTag(dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')) {
  return `lightshow-remote-analyzer:${crypto.createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)}`;
}

export async function ensureImage({ image = null, run = docker, log = () => {} } = {}) {
  if (image) return image;
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const tag = imageTag(text);
  try { await run(['image', 'inspect', tag]); return tag; } catch {}
  log(`Building ${tag}`);
  await run(['build', '--quiet', '-t', tag, '-'], { input: text });
  return tag;
}

/** One environment per locked dependency set: a new uv.lock gets a new one, built beside the old. */
export function venvKey(codeDir) {
  const hash = crypto.createHash('sha256');
  for (const name of ['pyproject.toml', 'uv.lock']) hash.update(fs.readFileSync(path.join(codeDir, name))).update('\0');
  return `${hash.digest('hex').slice(0, 16)}-cu128`;
}

const user = () => `${os.userInfo().uid}:${os.userInfo().gid}`;

// The server image's layout, so the environment and models work as they do on the server.
function dataMounts({ codeDir, venv, pythonDir, modelData, writable = false }) {
  const mode = writable ? '' : ':ro';
  const out = ['-v', `${codeDir}:/app:ro`, '-v', `${venv}:/data/.venv:ro`, '-v', `${pythonDir}:/data/.uv/python:ro`,
    '-v', `${path.join(modelData, 'models')}:/data/models${mode}`, '-v', `${path.join(modelData, '.cache')}:/data/.cache${mode}`];
  if (fs.existsSync(path.join(modelData, 'panns_data'))) out.push('-v', `${path.join(modelData, 'panns_data')}:/home/analyzer/panns_data${mode}`);
  return out;
}

const MODEL_ENV = ['-e', 'ARTNET_MODEL_DIR=/data/models', '-e', 'TORCH_HOME=/data/.cache/torch', '-e', 'HF_HOME=/data/.cache/huggingface',
  '-e', 'HOME=/home/analyzer', '-e', 'USER=analyzer', '-e', 'LOGNAME=analyzer', '-e', 'PYTHONDONTWRITEBYTECODE=1',
  '-e', 'NUMBA_CACHE_DIR=/tmp/numba'];

export async function ensureVenv({ image, codeDir, dataDir, run = docker, log = () => {} }) {
  const venvs = path.join(dataDir, 'venvs');
  const venv = path.join(venvs, venvKey(codeDir));
  // pyvenv.cfg, not bin/python: that links to the interpreter at its path inside the container.
  if (fs.existsSync(path.join(venv, 'pyvenv.cfg'))) return venv;
  const tmp = `${venv}.tmp`;
  for (const dir of [venvs, path.join(dataDir, 'python'), path.join(dataDir, 'uv-cache')]) fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  log(`Building the CUDA analysis environment ${path.basename(venv)} (a few GB the first time)`);
  await run(['run', '--rm', '--name', `${PREFIX}-venv-${process.pid}`, '--user', user(),
    '-v', `${codeDir}:/app:ro`, '-v', `${tmp}:/data/.venv`, '-v', `${path.join(dataDir, 'python')}:/data/.uv/python`,
    '-v', `${path.join(dataDir, 'uv-cache')}:/data/.uv/cache`,
    '-e', 'HOME=/tmp', '-e', 'UV_PROJECT_ENVIRONMENT=/data/.venv', '-e', 'UV_PYTHON_INSTALL_DIR=/data/.uv/python',
    '-e', 'UV_CACHE_DIR=/data/.uv/cache', '-e', 'UV_PYTHON_PREFERENCE=only-managed', '-e', 'UV_LINK_MODE=copy', '-e', 'NO_COLOR=1',
    '--entrypoint', 'uv', image, 'sync', '--locked', '--extra', 'cu128', '--python', '3.12', '--project', '/app']);
  fs.renameSync(tmp, venv);
  const old = fs.readdirSync(venvs).filter((name) => /^[0-9a-f]{16}-cu128$/.test(name)).map((name) => path.join(venvs, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of old.slice(VENVS_KEPT)) fs.rmSync(dir, { recursive: true, force: true });
  return venv;
}

export function parseModelListing(text) {
  for (const line of String(text).split('\n')) {
    try {
      const listing = JSON.parse(line);
      if (Array.isArray(listing.models)) return listing.models.filter((m) => m.present).map((m) => m.id).sort();
    } catch {}
  }
  throw new Error('the model listing was unreadable');
}

export async function listModels({ image, codeDir, venv, pythonDir, modelData, run = docker }) {
  const out = await run(['run', '--rm', '--network', 'none', '--user', user(), '--tmpfs', '/home/analyzer:uid=' + os.userInfo().uid,
    ...dataMounts({ codeDir, venv, pythonDir, modelData }), ...MODEL_ENV,
    '--entrypoint', '/data/.venv/bin/python', image, '/app/scripts/download-models.py', '--list', '--json'], { timeoutMs: 120_000 });
  return parseModelListing(out);
}

/** Download the server's models this PC lacks (network on); copying them from the server keeps the exact weights. */
export async function fetchModels({ image, codeDir, venv, pythonDir, modelData, ids, run = docker }) {
  for (const sub of ['models', '.cache']) fs.mkdirSync(path.join(modelData, sub), { recursive: true });
  await run(['run', '--rm', '--user', user(), '--tmpfs', '/home/analyzer:uid=' + os.userInfo().uid,
    ...dataMounts({ codeDir, venv, pythonDir, modelData, writable: true }), ...MODEL_ENV,
    '--entrypoint', '/data/.venv/bin/python', image, '/app/scripts/download-models.py', '--only', ids.join(','), '--missing']);
}

/**
 * The analysis worker's container: the GPU through WSL's paravirtualised device, no network, everything but the
 * job folder read-only. ARTNET_PINNED_GB=0: pinned host memory under WSL2 slows numpy tenfold.
 */
export function workerArgs({ name, image, codeDir, venv, pythonDir, modelData, jobsDir, memory = '16g', env = {} }) {
  const settings = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return ['run', '-i', '--rm', '--name', name, '--init', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp', '--tmpfs', `/home/analyzer:uid=${os.userInfo().uid}`,
    '--memory', memory, '--memory-swap', memory, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', user(),
    '--device', '/dev/dxg', '-v', '/usr/lib/wsl:/usr/lib/wsl:ro', '-e', 'LD_LIBRARY_PATH=/usr/lib/wsl/lib',
    ...dataMounts({ codeDir, venv, pythonDir, modelData }), '-v', `${jobsDir}:/jobs:ro`, ...MODEL_ENV,
    '-e', 'HF_HUB_OFFLINE=1', '-e', 'TRANSFORMERS_OFFLINE=1', '-e', 'ARTNET_PINNED_GB=0', ...settings,
    '--entrypoint', 'nice', image, '-n', '10', '/data/.venv/bin/python', '/app/src/analyze.py', '--worker'];
}

/** The NDJSON worker of src/analysis/cli.py in its container: one request at a time. */
export class AnalysisProcess {
  constructor({ name, args, start = spawn, kill = (n) => docker(['kill', n]).catch(() => {}), log = () => {} }) {
    Object.assign(this, { name, args, startProcess: start, killContainer: kill, log });
    this.child = null; this.pending = null; this.buffer = ''; this.nextId = 1; this.exited = false;
    this.ready = new Promise((resolve, reject) => { this._ready = resolve; this._notReady = reject; });
    this.ready.catch(() => {});
  }
  start() {
    const child = this.startProcess('docker', this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._stdout(chunk));
    let err = '';
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-8192);
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.includes('[analyzer] worker ready')) this._ready();
        this.log(line.length > 300 ? `${line.slice(0, 300)}…` : line);
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => this._exit(`docker could not start: ${e.message}`));
    child.on('exit', (code, signal) => this._exit(`the analysis container exited (${signal || `code ${code}`})`));
    return this;
  }
  request(source, targetDurationSec) {
    if (this.exited) return Promise.reject(new Error('the analysis container is not running'));
    if (this.pending) return Promise.reject(new Error('the analysis container is busy'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.child.stdin.write(`${JSON.stringify({ id, source, targetDurationSec })}\n`);
    });
  }
  _stdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { this.log(`unreadable worker line: ${line.slice(0, 120)}`); continue; }
      const pending = this.pending;
      if (!pending || reply.id !== pending.id) continue;
      this.pending = null;
      pending.resolve(reply);
    }
  }
  _exit(reason) {
    if (this.exited) return;
    this.exited = true;
    this._notReady(new Error(reason));
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(reason));
  }
  async stop() {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch {}
    await this.killContainer(this.name);
    try { this.child.kill('SIGKILL'); } catch {}
  }
}

export async function removeStale(prefix, run = docker) {
  const ids = (await run(['ps', '-aq', '--filter', `name=^${prefix}-`]).catch(() => '')).split('\n').filter(Boolean);
  if (ids.length) await run(['rm', '-f', ...ids]).catch(() => {});
  return ids.length;
}
