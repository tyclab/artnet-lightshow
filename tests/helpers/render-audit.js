// Components rendered in Node through a hooks stand-in whose slots persist
// between calls (effects do not run), inside a signals effect: every signal a
// render reads is then a subscription a test can see. `count` maps shared
// modules to a function whose calls StagePreview makes are counted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.join(import.meta.dirname, '..', '..');

const HOOKS = `
  let current;
  export function runner() { const slots = []; return (fn) => { current = { slots, at: 0 }; try { return fn(); } finally { current = null; } }; }
  export function useMemo(fn, deps) { const i = current.at++, old = current.slots[i];
    if (old && old.deps.length === deps.length && deps.every((v, n) => Object.is(v, old.deps[n]))) return old.value;
    const value = fn(); current.slots[i] = { value, deps }; return value; }
  export function useCallback(fn, deps) { return useMemo(() => fn, deps); }
  export function useEffect() {}
  export function useLayoutEffect() {}
  export function useRef(value) { return useMemo(() => ({ current: value }), []); }
  export function useState(initial) { return [useMemo(() => (typeof initial === 'function' ? initial() : initial), []), () => {}]; }
  export function useReducer(reducer, initial, init) { return [useMemo(() => (init ? init(initial) : initial), []), () => {}]; }
`;

export async function loadAudited(exports, { count = {} } = {}) {
  const names = Object.values(count);
  const built = await esbuild.build({
    stdin: { contents: `${exports}\nexport { effect } from '@preact/signals';\nexport { runner } from 'preact/hooks';\nexport { calls } from 'call-counts';`, resolveDir: root },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    jsx: 'automatic', jsxImportSource: 'preact', loader: { '.js': 'jsx' },
    alias: { 'socket.io-client': path.join(root, 'tests/helpers/fake-socket-io.js') },
    plugins: [{ name: 'render-audit', setup(build) {
      build.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: 'hooks', namespace: 'audit' }));
      build.onResolve({ filter: /^call-counts$/ }, () => ({ path: 'counts', namespace: 'audit' }));
      build.onResolve({ filter: /\.ts$/ }, (args) => {
        const file = path.relative(root, path.resolve(args.resolveDir, args.path));
        return args.importer.endsWith('StagePreview.jsx') && count[file] ? { path: file, namespace: 'counted' } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace: 'counted' }, (args) => ({ resolveDir: root, loader: 'js', contents: `
        import * as real from './${args.path}';
        import { calls } from 'call-counts';
        export * from './${args.path}';
        export function ${count[args.path]}(...args) { calls.${count[args.path]}++; return real.${count[args.path]}(...args); }` }));
      build.onLoad({ filter: /^counts$/, namespace: 'audit' }, () => ({ contents: `export const calls = ${JSON.stringify(Object.fromEntries(names.map((n) => [n, 0])))};` }));
      build.onLoad({ filter: /^hooks$/, namespace: 'audit' }, () => ({ contents: HOOKS }));
    } }],
  });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'render-audit-'));
  fs.writeFileSync(path.join(temporary, 'bundle.mjs'), built.outputFiles[0].text);
  const ui = await import(path.join(temporary, 'bundle.mjs'));
  fs.rmSync(temporary, { recursive: true, force: true });
  return ui;
}

/** Render `component` in an effect; `renders` counts the times a signal it read woke it. */
export function mount(ui, component, props = {}) {
  const run = ui.runner();
  const seen = { renders: 0, tree: null };
  const stop = ui.effect(() => { seen.renders++; seen.tree = run(() => component(props)); });
  return { seen, stop, again: () => run(() => component(props)) };
}
