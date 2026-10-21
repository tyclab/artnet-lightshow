import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { io as connect } from 'socket.io-client';
import { Agent } from './agent.js';
import { defaultPaths, loadConfig } from './config.js';
import { DesktopWatch, SystemHold, blockingApp, powershellPath } from './desktop.js';
import { probeGpu } from './gpu.js';
import { AnalysisProcess, PREFIX, ensureImage, ensureVenv, fetchModels, listModels, removeStale, workerArgs } from './runtime.js';
import { CodeSource } from './source.js';

const help = `Usage: node cli.js [run|prepare|check] [--config FILE] [--fetch-models]
  run       connect to the lightshow and analyse its tracks on this GPU (the default; what the service runs)
  prepare   fetch the server's analysis code, build the image and the CUDA environment, list the models, exit
            --fetch-models also downloads the models the server has and this PC lacks (copying them from the
            server instead keeps the exact weights)
  check     what this PC would answer now: GPU, desktop, configuration; no connection
Configuration: ${defaultPaths().config} (docs/remote-analysis.md). The token is read from LIGHTSHOW_WORKER_TOKEN
or tokenFile and never printed.
`;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (line) => console.log(`${stamp()} ${line}`);

export function createRuntime(config, { logLine = log } = {}) {
  const source = new CodeSource({ dataDir: config.dataDir, repo: config.repo, fixed: config.source, searchCommits: config.searchCommits, log: logLine });
  const pythonDir = path.join(config.dataDir, 'python');
  return {
    async prepare(version) {
      const code = await source.resolve(version);
      const image = await ensureImage({ image: config.image, log: logLine });
      const venv = await ensureVenv({ image, codeDir: code.dir, dataDir: config.dataDir, log: logLine });
      const models = await listModels({ image, codeDir: code.dir, venv, pythonDir, modelData: config.modelData });
      return { version: code.version, commit: code.commit, codeDir: code.dir, venv, pythonDir, image, models };
    },
    startProcess(prepared, env) {
      const name = `${PREFIX}-${config.name}-${Date.now().toString(36)}`;
      const args = workerArgs({
        name, image: prepared.image, codeDir: prepared.codeDir, venv: prepared.venv, pythonDir: prepared.pythonDir,
        modelData: config.modelData, jobsDir: path.join(config.dataDir, 'jobs'), memory: config.memory, env,
      });
      return new AnalysisProcess({ name, args, log: (line) => logLine(`[analysis] ${line}`) }).start();
    },
    fetchModels: (prepared, ids) => fetchModels({ ...prepared, modelData: config.modelData, ids }),
  };
}

function parseArgs(argv) {
  const out = { command: 'run', config: defaultPaths().config, fetchModels: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['run', 'prepare', 'check'].includes(arg)) out.command = arg;
    else if (arg === '--config' && argv[i + 1]) out.config = path.resolve(argv[++i]);
    else if (arg === '--fetch-models') out.fetchModels = true;
    else if (arg === '--help' || arg === '-h') out.command = 'help';
    else throw new Error(`Unknown option ${arg}; see --help`);
  }
  return out;
}

async function check(config) {
  const card = await probeGpu();
  const desktop = new DesktopWatch({ log });
  desktop.run();
  await new Promise((resolve) => setTimeout(resolve, powershellPath() ? 8000 : 0));
  const reading = desktop.latest();
  desktop.stop();
  console.log(JSON.stringify({
    server: config.server.base, name: config.name, token: 'set', dataDir: config.dataDir, modelData: config.modelData,
    gpu: card, desktop: reading, blockedBy: blockingApp(reading, config.allowFullscreen), maxOtherVramMiB: config.maxOtherVramMiB,
  }, null, 2));
}

async function prepareOnly(config, { fetch }) {
  const runtime = createRuntime(config);
  const socket = connect(`${config.server.origin}/analysis-worker`, { path: config.server.socketPath, auth: { token: config.token }, transports: ['websocket'], reconnection: false, timeout: 15_000 });
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const view = await socket.timeout(15_000).emitWithAck('hello', { protocol: 1, name: config.name, version: null, models: null, device: null, available: false, reason: 'preparing' });
    if (!view?.ok) throw new Error(view?.error || 'the server did not answer');
    const prepared = await runtime.prepare(view.version);
    const lacks = (view.models ?? []).filter((m) => !prepared.models.includes(m));
    const extra = prepared.models.filter((m) => !(view.models ?? []).includes(m));
    log(`Analysis ${prepared.version}${prepared.commit ? ` (commit ${prepared.commit.slice(0, 12)})` : ''}; environment ${path.basename(prepared.venv)}`);
    log(`Models here: ${prepared.models.join(', ') || 'none'}; the server has ${(view.models ?? []).join(', ') || 'none it could list'}`);
    if (extra.length) log(`This PC has models the server lacks (${extra.join(', ')}): remove them, or the server will not send jobs`);
    if (lacks.length && fetch) {
      log(`Downloading ${lacks.join(', ')}`);
      await runtime.fetchModels(prepared, lacks);
    } else if (lacks.length) log(`Missing ${lacks.join(', ')}: copy them from the server or rerun with --fetch-models`);
  } finally { socket.close(); }
}

async function run(config) {
  const stale = await removeStale(PREFIX);
  if (stale) log(`Removed ${stale} analysis container(s) left from an earlier run`);
  const agent = new Agent(config, {
    runtime: createRuntime(config), gpu: () => probeGpu(),
    desktop: powershellPath() ? new DesktopWatch({ log }) : null,
    hold: powershellPath() ? new SystemHold({ log }) : null, log,
  });
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    await agent.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  log(`Remote analyzer ${config.name} for ${config.server.base}`);
  agent.start();
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === 'help') { console.log(help); return; }
  const config = loadConfig(args.config);
  if (args.command === 'check') await check(config);
  else if (args.command === 'prepare') await prepareOnly(config, { fetch: args.fetchModels });
  else await run(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(`Remote analyzer failed: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; });
}
