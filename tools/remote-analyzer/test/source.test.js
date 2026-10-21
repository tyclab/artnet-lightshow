import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeSource } from '../source.js';
import { analysisVersion } from '../../../src/analysis-version.ts';

const FILES = {
  'pyproject.toml': '[project]\n', 'uv.lock': 'version = 1\n', 'scripts/download-models.py': '', 'scripts/setup-panns.py': '',
  'src/analyze.py': '', 'src/analysis/version.py': "SCHEMA_VERSION = '2.2'\n", 'src/analysis/pipeline.py': 'v = 1\n', 'README.md': 'x\n',
};

function origin(t) {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'origin');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  const write = (files) => { for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), body); } };
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  write(FILES);
  git('add', '-A'); git('commit', '-qm', 'one');
  const first = analysisVersion(repo);
  write({ 'src/analysis/pipeline.py': 'v = 2\n' });
  git('commit', '-qam', 'two');
  const second = analysisVersion(repo);
  write({ 'README.md': 'docs only\n' });
  git('commit', '-qam', 'three');
  return { dir, repo, first, second, head: git('rev-parse', 'HEAD').trim() };
}

test('the server\'s version picks the commit with that analysis code, checked out and verified', async (t) => {
  const o = origin(t);
  if (!o) { t.skip('git is not installed'); return; }
  const source = new CodeSource({ dataDir: path.join(o.dir, 'data'), repo: o.repo });
  const older = await source.resolve(o.first);
  assert.equal(older.version, o.first);
  assert.equal(fs.readFileSync(path.join(older.dir, 'src/analysis/pipeline.py'), 'utf8'), 'v = 1\n');
  assert.equal(fs.existsSync(path.join(older.dir, 'README.md')), false, 'only the analysis files');
  const newer = await source.resolve(o.second);
  assert.equal(newer.commit, o.head, 'the newest commit with that code, a docs commit after it included');
  assert.equal(analysisVersion(newer.dir), o.second);
  assert.deepEqual(await source.resolve(o.second), { ...newer }, 'the second time from its folder');
  await assert.rejects(source.resolve('2.2+ffffffffffffffff'), /no recent commit/);
  await assert.rejects(source.resolve('../../etc'), /no analysis version/);
});

test('a fixed source is used as it is and reports its own version', async (t) => {
  const o = origin(t);
  if (!o) { t.skip('git is not installed'); return; }
  const source = new CodeSource({ dataDir: path.join(o.dir, 'data'), repo: 'unused', fixed: o.repo });
  assert.deepEqual(await source.resolve(o.first), { dir: o.repo, version: o.second, commit: null });
});
