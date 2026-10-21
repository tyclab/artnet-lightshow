import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Which code made an analysis document: the Python package and its launcher,
 * the scripts that provision its models, and the locked environment. A remote
 * worker runs these at the same version or its results are refused.
 */
export const ANALYSIS_PATHS = [
  'pyproject.toml', 'uv.lock', 'scripts/download-models.py', 'scripts/setup-panns.py', 'src/analyze.py', 'src/analysis',
] as const;

const PACKAGE = 'src/analysis/';
const ROOT = path.join(import.meta.dirname, '..');

export interface SourceEntry {
  path: string;
  blob: string;
}

export function counts(relative: string): boolean {
  if (!relative.startsWith(PACKAGE)) return (ANALYSIS_PATHS as readonly string[]).includes(relative);
  return /\.(py|json)$/.test(relative) && !relative.split('/').includes('__pycache__');
}

/** Git's object id for a file's bytes, so a commit can be matched from `git ls-tree` without a checkout. */
export function blobId(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function fingerprint(entries: readonly SourceEntry[]): string {
  const hash = crypto.createHash('sha256');
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) hash.update(`${entry.blob} ${entry.path}\n`);
  return hash.digest('hex');
}

function walk(root: string, relative: string, out: SourceEntry[]): void {
  const full = path.join(root, relative);
  let stat: fs.Stats;
  try { stat = fs.statSync(full); } catch (_) { return; }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) walk(root, `${relative}/${name}`, out);
  } else if (stat.isFile() && counts(relative)) {
    out.push({ path: relative, blob: blobId(fs.readFileSync(full)) });
  }
}

export function sourceEntries(root: string = ROOT): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const relative of ANALYSIS_PATHS) walk(root, relative, out);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Entries from `git ls-tree -r <commit> -- ANALYSIS_PATHS`. */
export function entriesFromLsTree(text: string): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const line of text.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m && counts(m[2])) out.push({ path: m[2], blob: m[1] });
  }
  return out;
}

function schemaVersion(root: string): string {
  try {
    const source = fs.readFileSync(path.join(root, 'src', 'analysis', 'version.py'), 'utf8');
    return /^SCHEMA_VERSION\s*=\s*['"](\d+\.\d+)['"]/m.exec(source)?.[1] ?? '0.0';
  } catch (_) {
    return '0.0';
  }
}

/** `<schema>+<code digest>`, e.g. `2.2+3f9a1c0d2b7e4a55`. */
export function analysisVersion(root: string = ROOT): string {
  return `${schemaVersion(root)}+${fingerprint(sourceEntries(root)).slice(0, 16)}`;
}
