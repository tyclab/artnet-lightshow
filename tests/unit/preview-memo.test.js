import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';

const root = path.join(import.meta.dirname, '../..');
const built = await esbuild.build({
  stdin: { contents: `export { store, librarySig } from './public-src/state.js';
    export { startAudition, setAudition, useAuditionSampler } from './public-src/audition.js';
    export { useRehearsalSampler } from './public-src/rehearsal.js'; export { runner } from 'preact/hooks';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  alias: { 'socket.io-client': path.join(root, 'tests/helpers/fake-socket-io.js') },
  plugins: [{ name: 'persistent-hooks', setup(build) {
    build.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: 'hooks', namespace: 'audit' }));
    build.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({ contents: `
      let current;
      export function runner() { const slots=[]; return fn => { current={slots, at:0}; try{return fn();}finally{current=null;} }; }
      export function useMemo(fn,deps) { const i=current.at++, old=current.slots[i];
        if(old && old.deps.length===deps.length && deps.every((v,n)=>Object.is(v,old.deps[n]))) return old.value;
        const value=fn(); current.slots[i]={value,deps}; return value; }
      export function useEffect() {}
      export function useRef(value) { return useMemo(()=>({current:value}),[]); }
      export function useState(initial) { return [useMemo(()=>typeof initial==='function'?initial():initial,[]),()=>{}]; }
    ` }));
  } }],
});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-memo-'));
fs.writeFileSync(path.join(temporary, 'bundle.mjs'), built.outputFiles[0].text);
const ui = await import(path.join(temporary, 'bundle.mjs'));
const profile = { id: 'memo-rgb', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixtures = [{ id: 1, profileId: profile.id, address: 1, universe: 0, position: { x: 25, y: 50 } }];
const rig = buildRig(fixtures, () => profile), space = buildUnitSpace(rig, null);
const spec = { kind: 'v2.wash', params: {}, palette: ['#FF0000'], brightness: 1 };
const defaults = () => ({ armed: false, profiles: { [profile.id]: profile }, hardware: { technologies: {}, products: {} }, safety: {}, voices: [], hueStrobe: 'flash' });
const sample = (sampler) => sampler(100, fixtures, [{ r: 255, g: 255, b: 255 }], rig);
test.after(() => { ui.setAudition({ active: false, playing: false }); fs.rmSync(temporary, { recursive: true, force: true }); });

test('demo ticks keep the sampler and do not serialize unchanged wire fields', () => {
  ui.store.applySnapshot({ versions: {}, state: defaults() });
  ui.startAudition('draft:test', spec); ui.setAudition({ playing: false });
  const run = ui.runner(), first = run(() => ui.useAuditionSampler(space));
  const stringify = mock.method(JSON, 'stringify');
  try {
    for (let position = 1; position <= 30; position++) {
      ui.setAudition({ position });
      assert.equal(run(() => ui.useAuditionSampler(space)), first);
    }
    assert.equal(stringify.mock.callCount(), 0);
  } finally { stringify.mock.restore(); }
  assert.equal(sample(first)[0].r, 255);
});

test('replaced drafts, wire patches and room coordinates invalidate while identical snapshots retain progress', () => {
  const state = defaults(); ui.store.applySnapshot({ versions: { hardware: 0 }, state });
  ui.startAudition('draft:test', spec); ui.setAudition({ playing: false });
  const run = ui.runner(), first = run(() => ui.useAuditionSampler(space));
  ui.store.applySnapshot({ versions: { hardware: 0 }, state: JSON.parse(JSON.stringify(state)) });
  assert.equal(run(() => ui.useAuditionSampler(space)), first);
  const changed = JSON.parse(JSON.stringify(state.profiles)); changed[profile.id].channelMap = { red: 2, green: 1, blue: 0 };
  assert.equal(ui.store.applyPatch({ d: 'hardware', v: 1, set: { profiles: changed } }), 'ok');
  const patched = run(() => ui.useAuditionSampler(space)); assert.notEqual(patched, first);
  assert.notEqual(run(() => ui.useAuditionSampler({ ...space, revision: `${space.revision}:moved` })), patched);
  ui.setAudition({ spec: { ...spec, palette: ['#00FF00'] } });
  const green = run(() => ui.useAuditionSampler(space));
  assert.deepEqual(sample(green)[0], { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 });
  const added = [...fixtures, { ...fixtures[0], id: 2, address: 4 }];
  assert.equal(green(100, added, [{ r: 255, g: 255, b: 255 }], buildRig(added, () => profile)).length, 2);
});

test('inactive samplers do no serialization; enabling and re-enabling produces seekable frames', () => {
  ui.store.applySnapshot({ versions: {}, state: defaults() });
  ui.startAudition('draft:test', spec); ui.setAudition({ playing: false });
  const audition = ui.runner(), rehearsal = ui.runner();
  const timeline = { timeline: [{ timeMs: 0, action: 'patch', data: { pattern: 'v2.wash', basePalette: { colours: ['#FFFFFF'] } } }] };
  const stringify = mock.method(JSON, 'stringify');
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal(audition(() => ui.useAuditionSampler(space, false)), null);
      assert.equal(rehearsal(() => ui.useRehearsalSampler(timeline, space, false)), null);
    }
    assert.equal(stringify.mock.callCount(), 0);
  } finally { stringify.mock.restore(); }
  const first = audition(() => ui.useAuditionSampler(space, true));
  const expected = sample(first);
  assert.equal(audition(() => ui.useAuditionSampler(space, false)), null);
  const resumed = audition(() => ui.useAuditionSampler(space, true));
  assert.equal(resumed, first, 'changing views keeps the bounded seek history');
  assert.deepEqual(sample(resumed), expected);
  const planned = rehearsal(() => ui.useRehearsalSampler(timeline, space, true));
  assert.ok(sample(planned)[0].r > 0);
});
