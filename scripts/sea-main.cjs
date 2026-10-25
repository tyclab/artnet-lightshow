// The SEA invokes this script for both supervisor and server; retain the first invocation’s environment.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function dataDirFor({ root, platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.LIGHTSHOW_DATA_DIR && env.LIGHTSHOW_DATA_DIR.trim()) return env.LIGHTSHOW_DATA_DIR;
  if (exists(p.join(root, 'portable'))) return p.join(root, 'data');
  // An install from before the rename keeps its data where it is until the new folder exists.
  const base = platform === 'win32' ? (env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? p.join(home, 'Library', 'Application Support')
    : (env.XDG_DATA_HOME || p.join(home, '.local', 'share'));
  const [fresh, former] = platform === 'linux' ? ['tycstation-lightshow', 'artnet-lightshow'] : ['TycStation Lightshow', 'ArtNet Lightshow'];
  const data = p.join(base, fresh);
  const old = p.join(base, former);
  return !exists(data) && exists(old) ? old : data;
}

function main() {
  const root = path.dirname(process.execPath);
  const app = path.join(root, 'app');

  if (process.argv.includes('--version')) {
    const { version } = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    console.log(`TycStation Lightshow ${version} (Node ${process.version})`);
    return;
  }

  const data = dataDirFor({ root });
  process.env.LIGHTSHOW_DATA_DIR = data;
  process.env.LIGHTSHOW_PACKAGED = '1';
  fs.mkdirSync(data, { recursive: true });
  process.chdir(data);
  if (process.env.LIGHTSHOW_SUPERVISED !== '1') process.title = 'TycStation Lightshow';

  import(pathToFileURL(path.join(app, 'server.js')).href).catch((err) => {
    console.error(`\nTycStation Lightshow could not start: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}

if (require('node:sea').isSea()) main();

module.exports = { dataDirFor };
