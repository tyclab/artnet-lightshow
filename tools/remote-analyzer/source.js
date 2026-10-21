import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS_PATHS, analysisVersion, entriesFromLsTree, fingerprint } from '../../src/analysis-version.ts';

const KEPT = 3;

export function runGit(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.find((a) => !a.startsWith('-')) ?? ''}: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout);
    });
  });
}

/**
 * The analysis code the server runs, from the repository the server's image is built from. The server only names
 * a version (a digest of those files); the code itself comes from the repository, never from the server, and a
 * checkout is used only once its own digest matches.
 */
export class CodeSource {
  constructor({ dataDir, repo, fixed = null, searchCommits = 400, git = runGit, log = () => {} }) {
    Object.assign(this, { repo, fixed, searchCommits, git, log });
    this.root = path.join(dataDir, 'code');
    this.mirror = path.join(dataDir, 'repo.git');
    this.index = path.join(this.root, 'fingerprints.json');
  }

  async resolve(version) {
    if (this.fixed) return { dir: this.fixed, version: analysisVersion(this.fixed), commit: null };
    const digest = /^\d+\.\d+\+([0-9a-f]{16})$/.exec(String(version))?.[1];
    if (!digest) throw new Error(`the server names no analysis version this worker can look up (${version})`);
    const dir = path.join(this.root, digest);
    if (fs.existsSync(dir) && analysisVersion(dir) === version) return { dir, version, commit: this._known()[digest] ?? null };
    await this._sync();
    const commit = await this._find(digest);
    if (!commit) throw new Error(`no recent commit of ${this.repo} has analysis ${version}`);
    await this._export(commit, dir, version);
    this._prune(dir);
    return { dir, version, commit };
  }

  _known() {
    try { return JSON.parse(fs.readFileSync(this.index, 'utf8')).byDigest ?? {}; } catch { return {}; }
  }

  async _sync() {
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(path.join(this.mirror, 'HEAD'))) {
      this.log(`Cloning ${this.repo}`);
      await this.git(['clone', '--mirror', '--quiet', this.repo, this.mirror]);
    } else {
      await this.git(['--git-dir', this.mirror, 'fetch', '--prune', '--quiet', 'origin']);
    }
  }

  async _find(digest) {
    let cache;
    try { cache = JSON.parse(fs.readFileSync(this.index, 'utf8')); } catch { cache = {}; }
    const byCommit = cache.byCommit ?? {};
    const commits = (await this.git(['--git-dir', this.mirror, 'rev-list', `--max-count=${this.searchCommits}`, '--all'])).split('\n').filter(Boolean);
    let found = null;
    for (const commit of commits) {
      if (!byCommit[commit]) {
        const listing = await this.git(['--git-dir', this.mirror, 'ls-tree', '-r', commit, '--', ...ANALYSIS_PATHS]);
        byCommit[commit] = fingerprint(entriesFromLsTree(listing)).slice(0, 16);
      }
      if (byCommit[commit] === digest) { found = commit; break; }
    }
    const byDigest = { ...(cache.byDigest ?? {}), ...(found ? { [digest]: found } : {}) };
    fs.writeFileSync(this.index, JSON.stringify({ byCommit, byDigest }));
    return found;
  }

  async _export(commit, dir, version) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const files = entriesFromLsTree(await this.git(['--git-dir', this.mirror, 'ls-tree', '-r', commit, '--', ...ANALYSIS_PATHS])).map((e) => e.path);
    const indexFile = `${tmp}.index`;
    try {
      await this.git(['--git-dir', this.mirror, '--work-tree', tmp, 'checkout', commit, '--', ...files], { env: { GIT_INDEX_FILE: indexFile } });
    } finally {
      fs.rmSync(indexFile, { force: true });
    }
    if (analysisVersion(tmp) !== version) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`the checkout of ${commit} does not hash to ${version}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    this.log(`Analysis ${version} is commit ${commit.slice(0, 12)} of ${this.repo}`);
  }

  _prune(keep) {
    const dirs = fs.readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name)).map((d) => path.join(this.root, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const dir of dirs.filter((d) => d !== keep).slice(KEPT - 1)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
