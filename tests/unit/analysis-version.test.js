import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ANALYSIS_PATHS, analysisVersion, entriesFromLsTree, fingerprint, sourceEntries } from '../../src/analysis-version.ts';

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-version-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const FILES = {
  'pyproject.toml': '[project]\nname = "x"\n',
  'uv.lock': 'version = 1\n',
  'scripts/download-models.py': 'print(1)\n',
  'scripts/setup-panns.py': 'print(2)\n',
  'scripts/other.py': 'print(3)\n',
  'src/analyze.py': 'import analysis\n',
  'src/analysis/version.py': "SCHEMA_VERSION = '2.2'\nMIN_COMPATIBLE = '2.0'\n",
  'src/analysis/pipeline.py': 'def analyze(): pass\n',
  'src/analysis/document.schema.json': '{}\n',
  'src/analysis/notes.txt': 'not code\n',
  'src/analysis/__pycache__/pipeline.cpython-312.pyc': 'bytecode',
  'src/server.ts': 'export {};\n',
};

test('the version names the schema and a digest of the analysis code', (t) => {
  const dir = tree(FILES);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.match(analysisVersion(dir), /^2\.2\+[0-9a-f]{16}$/);
  assert.deepEqual(sourceEntries(dir).map((e) => e.path), [
    'pyproject.toml', 'scripts/download-models.py', 'scripts/setup-panns.py', 'src/analysis/document.schema.json',
    'src/analysis/pipeline.py', 'src/analysis/version.py', 'src/analyze.py', 'uv.lock',
  ], 'bytecode, notes and the rest of the repository do not count');
});

test('only files that decide a document change the version', (t) => {
  const dir = tree(FILES);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = analysisVersion(dir);
  fs.writeFileSync(path.join(dir, 'src/server.ts'), 'export const changed = 1;\n');
  fs.writeFileSync(path.join(dir, 'src/analysis/notes.txt'), 'edited\n');
  assert.equal(analysisVersion(dir), before);
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 2\n');
  assert.notEqual(analysisVersion(dir), before, 'the locked environment is part of it');
});

test('a commit gives the same fingerprint from git as its checkout gives from disk', (t) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { t.skip('git is not installed'); return; }
  const dir = tree(FILES);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '__pycache__/\n');
  git('add', '-A');
  git('commit', '-qm', 'x');
  const listed = entriesFromLsTree(git('ls-tree', '-r', 'HEAD', '--', ...ANALYSIS_PATHS));
  assert.equal(fingerprint(listed), fingerprint(sourceEntries(dir)));
});
