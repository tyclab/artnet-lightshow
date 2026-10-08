import test from 'node:test';
import assert from 'node:assert/strict';
import { groupClips, moveClips, moveShortfall, removeClips, selectedClipIds, ungroupClips } from '../../public-src/sequence-groups.js';

const sequence = () => ({ snap: 1,
  lanes: [{ id: 'a', kind: 'shared' }, { id: 'b', kind: 'shared' }, { id: 't', kind: 'track', fixtureId: 4 }],
  clips: [{ id: 'one', laneId: 'a', startBeat: 0.25, lengthBeats: 2, targets: [4] },
    { id: 'two', laneId: 'b', startBeat: 4.75, lengthBeats: 2, targets: 'lane' },
    { id: 'three', laneId: 't', startBeat: 8, lengthBeats: 2, targets: 'lane' }],
  clipGroups: [{ id: 'g', clipIds: ['one', 'two'] }],
});

test('a selected group expands to all existing members', () => {
  assert.deepEqual(selectedClipIds(sequence(), ['one', 'missing']), ['one', 'two']);
});

test('group movement clamps one shared delta at the timeline start', () => {
  const next = moveClips(sequence(), ['two'], -8);
  assert.deepEqual(next.clips.map((clip) => clip.startBeat), [0, 4.5, 8]);
});

test('group movement snaps the delta without changing relative offsets', () => {
  const next = moveClips(sequence(), ['one'], 1.3);
  assert.deepEqual(next.clips.map((clip) => clip.startBeat), [1.25, 5.75, 8]);
});

test('group lane movement clamps every member and retains explicit targets', () => {
  const next = moveClips(sequence(), ['one'], 0, 9);
  assert.deepEqual(next.clips.map((clip) => clip.laneId), ['b', 't', 't']);
  assert.deepEqual(next.clips[0].targets, [4]);
});

test('grouping a group with another clip creates one disjoint group', () => {
  const next = groupClips(sequence(), ['two', 'three'], 'new');
  assert.deepEqual(next.clipGroups, [{ id: 'new', clipIds: ['one', 'two', 'three'] }]);
});

test('ungroup preserves clips and removes only selected membership', () => {
  const before = sequence();
  const next = ungroupClips(before, ['one']);
  assert.deepEqual(next.clipGroups, []);
  assert.equal(next.clips, before.clips);
});

test('group deletion removes its members and dangling membership', () => {
  const next = removeClips(sequence(), ['two']);
  assert.deepEqual(next.clips.map((clip) => clip.id), ['three']);
  assert.deepEqual(next.clipGroups, []);
});

test('a clamped group move is reported, a complete one is not', () => {
  const before = sequence();
  assert.equal(moveShortfall(before, moveClips(before, ['one'], 1), 'one', 1, 0), null);
  const clamped = moveClips(before, ['one'], 0, 9);
  assert.match(moveShortfall(before, clamped, 'one', 0, 9), /moved 0 beats and 1 lanes/);
  const blocked = moveClips(before, ['two'], -8);
  assert.match(moveShortfall(before, blocked, 'two', -8, 0), /moved -0.25 beats and 0 lanes/);
});
