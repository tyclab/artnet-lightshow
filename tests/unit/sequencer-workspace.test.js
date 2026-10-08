import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sequencer, validateSequence } from '../../src/server/sequencer.ts';
import { SequenceWorkspace } from '../../src/server/sequence-workspace.ts';
import { SequenceHistory } from '../../src/server/sequence-history.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { playingState } from '../../public-src/now-playing.js';
import { nowPlaying } from '../../public-src/preview-inputs.js';

const spec = presetById('ldj.FadeCycle').spec;
const lane = { id: 'a', kind: 'shared', name: 'All', mute: false, solo: false };
const show = () => validateSequence({ id: 'show', name: 'Show', lanes: [lane], clips: [
  { id: 'c1', laneId: 'a', startBeat: 0, lengthBeats: 8, presetId: 'fade' },
  { id: 'c2', laneId: 'a', startBeat: 8, lengthBeats: 8, presetId: 'fade' },
] });
const rig = (extra = {}) => new Sequencer({ resolve: (id) => id === 'fade' ? spec : null, fixtureIds: () => [1],
  pad: () => ({ presetId: 'fade', targets: 'shared', lengthBeats: 4 }), admit: () => {}, ...extra });
function workspace(t, sequencer = rig(), saved = () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sequence-workspace-'));
  const file = path.join(dir, 'sequence-workspace.json');
  const w = new SequenceWorkspace(file, sequencer, saved).open();
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, w, s: sequencer };
}

test('clip names survive pattern capture without renaming the preset', () => {
  const s = rig();
  const next = show(); next.clips[0].name = 'Opening colours';
  s.load(next);
  assert.equal(s.captureWithBounds(0, 4, ['a'], 'Opening').pattern.lanes[0].clips[0].name, 'Opening colours');
  assert.equal(s.current().clips[0].presetId, 'fade');
});

test('clip groups reject missing or repeated members', () => {
  for (const clipIds of [['c1', 'missing'], ['c1', 'c1']]) {
    assert.throws(() => validateSequence({ ...show(), clipGroups: [{ id: 'g', clipIds }] }), { status: 400 });
  }
  assert.throws(() => validateSequence({ ...show(), clipGroups: [
    { id: 'g', clipIds: ['c1', 'c2'] }, { id: 'g2', clipIds: ['c1', 'c2'] },
  ] }), { status: 400 });
});

test('old shows do not acquire optional editor fields', () => {
  const next = show();
  assert.equal(Object.hasOwn(next, 'clipGroups'), false);
  assert.equal(Object.hasOwn(next.clips[0], 'name'), false);
});

test('undo and redo replay one whole grouped edit', () => {
  const s = rig(); s.load(show());
  const next = s.current(); next.clips.forEach((clip) => { clip.startBeat += 2; });
  next.clipGroups = [{ id: 'g', clipIds: ['c1', 'c2'] }];
  s.load(next);
  assert.deepEqual(s.replay('undo', s.revision()).clips.map((clip) => clip.startBeat), [0, 8]);
  assert.deepEqual(s.replay('redo', s.revision()), next);
});

test('new edits clear redo while preset recompilation adds no history', () => {
  let current = spec;
  const s = rig({ resolve: () => current }); s.load(show());
  s.load({ ...s.current(), name: 'Edited' }); s.replay('undo', s.revision());
  current = presetById('hd.neonDomino').spec;
  s.load(s.current());
  assert.deepEqual(s.status().history, { canUndo: false, canRedo: true });
  s.load({ ...s.current(), name: 'Another edit' });
  assert.equal(s.status().history.canRedo, false);
});

test('stale clients cannot replay another editor’s newest operation', () => {
  const s = rig(); s.load(show()); const revision = s.revision();
  s.load({ ...s.current(), name: 'Another browser' });
  assert.throws(() => s.replay('undo', revision), { status: 409 });
  assert.equal(s.current().name, 'Another browser');
});

test('refused history replay preserves the document and both stacks', () => {
  let refuse = false;
  const s = rig({ admit: () => { if (refuse) throw Object.assign(new Error('gate'), { status: 409 }); } });
  s.load(show()); s.load({ ...s.current(), name: 'Changed' }); s.play();
  refuse = true;
  assert.throws(() => s.replay('undo', s.revision()), { status: 409 });
  assert.equal(s.current().name, 'Changed');
  assert.deepEqual(s.status().history, { canUndo: true, canRedo: false });
});

test('loop controls participate in document history', () => {
  const s = rig(); s.load(show()); s.setLoop({ on: true, startBeat: 0, endBeat: 8 });
  assert.equal(s.replay('undo', s.revision()).loop, null);
});

test('prepared edits are single-use and reject stale documents', () => {
  const s = rig(); s.load(show());
  const prepared = s.prepareLoad({ ...s.current(), name: 'Prepared' });
  assert.equal(s.commitPrepared(prepared).name, 'Prepared');
  assert.throws(() => s.commitPrepared(prepared), { status: 409 });
  const stale = s.prepareLoad({ ...s.current(), name: 'Stale' });
  s.load({ ...s.current(), name: 'Concurrent' });
  assert.throws(() => s.commitPrepared(stale), { status: 409 });
  assert.equal(s.current().name, 'Concurrent');
});

test('history bounds retained document bytes', () => {
  const history = new SequenceHistory(50, 100);
  history.commit(show(), { ...show(), name: 'Changed' });
  assert.equal(history.status().canUndo, false);
});

test('restart restores edits without playback or start settings', (t) => {
  const saved = show(); const { w, s, file } = workspace(t, rig(), () => saved);
  s.load(saved); s.seek(2.5); s.load({ ...s.current(), name: 'Unfinished', bpm: 200, musicMode: 'reactive' });
  w.flush();
  const applied = []; const modes = [];
  const next = rig({ apply: (patch) => applied.push(patch), musicMode: (mode) => modes.push(mode) });
  const restored = new SequenceWorkspace(file, next, () => saved).open(); t.after(() => restored.close());
  assert.equal(next.current().name, 'Unfinished');
  assert.equal(next.status().beat, 2.5);
  assert.equal(next.status().playing, false);
  assert.equal(next.frame({ beatPos: 100, bpm: 120, source: 'tap', epoch: 0 }).transport, null);
  assert.deepEqual([applied, modes], [[], []]);
  assert.equal(restored.status().dirty, true);
  assert.equal(restored.status().recovered, true);
});

test('pending take restores in review and ignores new pad hits', (t) => {
  const { w, s, file } = workspace(t);
  s.load(show()); s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
  s.onPadHit({ bank: 0, slot: 0, startBeat: 2 }); w.flush();
  const next = rig(); const restored = new SequenceWorkspace(file, next, () => null).open(); t.after(() => restored.close());
  assert.equal(next.recording().phase, 'review');
  assert.equal(next.pendingTake().take[0].open, false);
  assert.equal(next.onPadHit({ bank: 0, slot: 0, startBeat: 4 }), null);
  const kept = next.stopRecording(true);
  assert.equal(kept.added.length, 1);
  assert.equal(next.recording(), null);
  restored.flush();
  assert.equal(JSON.parse(fs.readFileSync(file)).take, null);
});

test('a take invalidated by an edit stays unkeepable after recovery', (t) => {
  const { w, s, file } = workspace(t);
  s.load(show()); s.startRecording({ mode: 'overdub' });
  s.onPadHit({ bank: 0, slot: 0, startBeat: 2 }); s.load({ ...s.current(), name: 'Edited during take' }); w.flush();
  const next = rig(); const restored = new SequenceWorkspace(file, next, () => null).open(); t.after(() => restored.close());
  assert.throws(() => next.stopRecording(true), { status: 409 });
  assert.equal(next.recording().hits, 1);
});

test('corrupt workspace survives edits until explicit recovery', (t) => {
  const { w, file, dir } = workspace(t); w.close(); fs.writeFileSync(file, '{broken');
  const next = rig(); const restored = new SequenceWorkspace(file, next, () => null).open(); t.after(() => restored.close());
  next.load(show()); restored.flush();
  assert.equal(restored.status().blocked, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  restored.startFresh();
  assert.equal(restored.status().blocked, false);
  const backup = fs.readdirSync(dir).find((name) => name.includes('.recovery-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{broken');
});

test('failed autosave preserves the last valid workspace', (t) => {
  const { w, s, file } = workspace(t); s.load(show()); w.flush();
  const before = fs.readFileSync(file, 'utf8');
  w.writeJson = () => { throw new Error('disk full'); };
  s.load({ ...s.current(), name: 'Still in memory' });
  assert.equal(w.flush(), false);
  assert.equal(w.status().pending, true);
  assert.equal(w.status().error, 'disk full');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('rapid document edits coalesce into one autosave', async (t) => {
  const { w, s } = workspace(t); let writes = 0;
  const write = w.writeJson.bind(w); w.writeJson = (data) => { writes++; write(data); };
  s.load(show()); s.load({ ...s.current(), name: 'Second' }); s.load({ ...s.current(), name: 'Third' });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(writes, 1);
  assert.equal(w.status().pending, false);
});

test('six-eight status reaches global now-playing without quarter-note labels', () => {
  const s = rig(); s.load({ ...show(), timeSignature: { beats: 6, unit: 8 } }); s.seek(2.5);
  const state = { sequence: s.status() };
  assert.equal(playingState(state).sequence.beatSize, 0.5);
  assert.match(nowPlaying(state), /bar 1 beat 6/);
});

test('random initial palettes include user palettes and do not reroll on resume', () => {
  const patches = [];
  const s = rig({ paletteIds: () => ['user-red', 'deleted'], palette: (id) => id === 'user-red' ? ['#ff0000'] : null,
    apply: (patch) => patches.push(patch) });
  s.load({ ...show(), options: { randomizeInitialPalette: true } });
  s.play(); s.frame({ beatPos: 0, bpm: 120, source: 'tap', epoch: 0 });
  s.pause(); s.frame({ beatPos: 1, bpm: 120, source: 'tap', epoch: 0 }); s.play();
  assert.equal(patches.filter((patch) => patch.paletteOverrideId === 'user-red').length, 1);
  s.stop(); s.frame({ beatPos: 2, bpm: 120, source: 'tap', epoch: 0 }); s.play();
  assert.equal(patches.filter((patch) => patch.paletteOverrideId === 'user-red').length, 2);
});

test('immediate commands apply without starting playback or changing the take', () => {
  const patches = [];
  const s = rig({ apply: (patch) => patches.push(patch) });
  s.load({ ...show(), commands: [{ id: 'tempo', atBeat: 10, type: 'tempo', value: 144 }, { id: 'jump', atBeat: 11, type: 'goto', value: 4 }] });
  s.startRecording({ mode: 'overdub' }); s.reviewRecording(); const take = s.pendingTake();
  s.executeCommand('tempo'); s.executeCommand('jump');
  assert.deepEqual(patches, [{ bpm: 144 }]);
  assert.equal(s.status().beat, 4);
  assert.equal(s.status().playing, false);
  assert.deepEqual(s.pendingTake(), take);
  assert.throws(() => s.executeCommand('missing'), { status: 404 });
});

test('missing recovery targets preserve the workspace without loading it', (t) => {
  const { w, s, file } = workspace(t);
  const next = show(); next.clips[0].targets = [99]; s.load(next); w.flush();
  const before = fs.readFileSync(file, 'utf8');
  const restored = rig(); const saved = new SequenceWorkspace(file, restored, () => null).open(); t.after(() => saved.close());
  assert.equal(restored.current(), null);
  assert.equal(saved.status().blocked, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('shutdown flush captures the current playhead without frame autosaves', (t) => {
  const { w, s, file } = workspace(t);
  s.load(show()); s.play(); s.frame({ beatPos: 10, bpm: 120, source: 'tap', epoch: 0 }); w.flush();
  s.frame({ beatPos: 14, bpm: 120, source: 'tap', epoch: 0 });
  assert.equal(w.status().pending, false);
  w.close();
  assert.equal(JSON.parse(fs.readFileSync(file)).beat, 4);
});

test('a loop or show-setup change keeps a running take keepable; a clip edit does not', async () => {
  const { DEFAULT_PADS } = await import('../../src/server/pads.ts');
  const { HD_MASTER_DEFAULTS } = await import('../../src/shared/effects/types.ts');
  const take = (edit) => {
    const s = rig();
    s.load({ ...show(), performance: { master: { ...HD_MASTER_DEFAULTS }, pads: structuredClone(DEFAULT_PADS), activePadLayoutId: null } });
    s.startRecording({ mode: 'overdub', countInBeats: 0, quantise: 1 });
    s.onPadHit({ bank: 0, slot: 0, startBeat: 2, lengthBeats: 2 });
    edit(s);
    return () => s.stopRecording(true);
  };
  assert.doesNotThrow(take((s) => s.setLoop({ on: true, startBeat: 0, endBeat: 8 })));
  assert.doesNotThrow(take((s) => {
    const current = s.current();
    s.load({ ...current, performance: { ...current.performance, master: { ...current.performance.master, sensitivity: 0.3 } } });
  }));
  assert.throws(take((s) => s.load({ ...s.current(), clips: s.current().clips.slice(1) })), { status: 409 });
});

test('a loop change keeps clips whose preset was deleted since load', () => {
  let present = true;
  const s = rig({ resolve: (id) => present && id === 'fade' ? spec : null });
  s.load(show());
  present = false;
  assert.deepEqual(s.setLoop({ on: true, startBeat: 0, endBeat: 8 }), { on: true, startBeat: 0, endBeat: 8 });
  assert.equal(s.current().loop.endBeat, 8);
});
