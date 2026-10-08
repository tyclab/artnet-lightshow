import test from 'node:test';
import assert from 'node:assert/strict';
import { clipAuditionTargets, confirmSequenceReplacement, sequenceChanged, trackSequenceEdit } from '../../public-src/sequence-workspace.js';

const sequence = { id: 'set', name: 'Set', clips: [] };
const request = (current, saved, status = {}) => async (path) => path === '/api/sequence'
  ? { ok: true, sequence: current, status } : { ok: true, sequences: saved };

test('saved content compares independently of object key order', () => {
  assert.equal(sequenceChanged(sequence, { clips: [], name: 'Set', id: 'set' }), false);
});

test('new unsaved sequence replacement can be cancelled', async () => {
  let asked = 0;
  assert.equal(await confirmSequenceReplacement(request(sequence, []), () => { asked++; return false; }), false);
  assert.equal(asked, 1);
});

test('saved sequences can be replaced without a discard prompt', async () => {
  assert.equal(await confirmSequenceReplacement(request(sequence, [sequence]), () => assert.fail()), true);
});

test('modified saved sequences require discard confirmation', async () => {
  const modified = { ...sequence, clips: [{ id: 'new' }] };
  let asked = 0;
  assert.equal(await confirmSequenceReplacement(request(modified, [sequence]), () => { asked++; return true; }), true);
  assert.equal(asked, 1);
});

test('pending takes require confirmation even when the sequence is saved', async () => {
  let asked = 0;
  assert.equal(await confirmSequenceReplacement(request(sequence, [sequence], { recording: {} }), () => { asked++; return false; }), false);
  assert.equal(asked, 1);
});

test('failed workspace reads prevent replacement', async () => {
  assert.equal(await confirmSequenceReplacement(async () => ({ ok: false }), () => assert.fail()), false);
});

test('replacement waits for an in-flight field edit before comparing', async () => {
  let settle, current = sequence, reads = 0, asked = 0;
  const edit = trackSequenceEdit(async () => {
    await new Promise((resolve) => { settle = resolve; });
    current = { ...sequence, name: 'Edited' };
  });
  const replacing = confirmSequenceReplacement(async (path) => {
    reads++;
    return request(current, [sequence])(path);
  }, () => { asked++; return false; });
  assert.equal(reads, 0);
  settle();
  await edit;
  assert.equal(await replacing, false);
  assert.equal(asked, 1);
});

const fixtures = [{ id: 2 }, { id: 7 }];
const lanes = [{ id: 'shared', kind: 'shared' }, { id: 'track', kind: 'track', fixtureId: 7 }];

test('track auditions target only their fixture', () => {
  assert.deepEqual(clipAuditionTargets({ laneId: 'track', targets: 'lane' }, lanes, fixtures).targets, [7]);
});

test('shared auditions retain explicit fixture targets', () => {
  assert.deepEqual(clipAuditionTargets({ laneId: 'shared', targets: [2] }, lanes, fixtures).targets, [2]);
});

test('shared lane auditions resolve to the current patched fixtures', () => {
  assert.deepEqual(clipAuditionTargets({ laneId: 'shared', targets: 'lane' }, lanes, fixtures).targets, [2, 7]);
});

test('a track excluded by clip targets cannot audition elsewhere', () => {
  assert.equal(clipAuditionTargets({ laneId: 'track', targets: [2] }, lanes, fixtures).targets, null);
});

test('unresolved audition targets never fall back to the whole rig', () => {
  for (const clip of [undefined, { laneId: 'gone', targets: 'lane' }, { laneId: 'shared', targets: [9] }]) {
    assert.equal(clipAuditionTargets(clip, lanes, fixtures).targets, null);
  }
});
