import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatrixSelection, matrixPaletteCells, matrixShouldRelease, shuffledMatrixPalette } from '../../public-src/matrix-selection.js';

const seed = [1, 2, 3, 4];

test('Matrix palette slots keep all six emitters', () => {
  assert.deepEqual(matrixPaletteCells({ colours: ['#123', '#000000aa', '#123456789abc'] }, seed),
    ['#112233', '#000000aa', '#123456789abc']);
});

test('Matrix samples the selected full-channel gradient', () => {
  const body = { colours: ['#000000000000', '#123456789abc'], gradient: 'wash',
    gradients: [{ name: 'wash', space: 'rgb', wrap: false, stops: [{ at: 0, slot: 0 }, { at: 1, slot: 1 }] }] };
  const cells = matrixPaletteCells(body, seed);
  assert.equal(cells.length, 8);
  assert.equal(cells[0], '#000000');
  assert.equal(cells[7], '#123456789abc');
});

test('Matrix Random materializes once without changing the saved palette', () => {
  const body = { colours: [{ random: true }, { random: true }] };
  const a = matrixPaletteCells(body, seed), b = matrixPaletteCells(body, seed);
  assert.deepEqual(a, b);
  assert.notEqual(a[0], a[1]);
  assert.deepEqual(body.colours, [{ random: true }, { random: true }]);
});

test('Matrix shuffle chooses another palette when one exists', () => {
  const palettes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(shuffledMatrixPalette(palettes, 'b', () => 0).id, 'a');
  assert.equal(shuffledMatrixPalette(palettes, 'b', () => .99).id, 'c');
});

function bench() {
  const calls = [], states = [];
  const holds = { press: (...v) => calls.push(['press', ...v]), release: (...v) => calls.push(['release', ...v]), releaseAll: () => calls.push(['clear']) };
  return { calls, states, control: createMatrixSelection(holds, (state) => states.push(state)) };
}

test('Matrix lock retains released cells until unlocked', () => {
  const { control, calls, states } = bench();
  control.press('pointer', 0, '#ff0000');
  control.setLocked(true);
  control.release('pointer');
  assert.deepEqual(calls, [['press', 0, '#ff0000']]);
  assert.deepEqual(states.at(-1), { locked: true, cells: [0] });
  control.setLocked(false);
  assert.deepEqual(calls.at(-1), ['release', 0]);
});

test('Tapping a locked Matrix cell releases its existing lease', () => {
  const { control, calls, states } = bench();
  control.setLocked(true);
  control.press(1, 3, '#ff0000');
  control.release(1);
  control.press(2, 3, '#ff0000');
  assert.deepEqual(calls, [['press', 3, '#ff0000'], ['release', 3]]);
  assert.deepEqual(states.at(-1).cells, []);
});

test('Two pointers on one Matrix cell share one lease', () => {
  const { control, calls } = bench();
  control.press(1, 0, '#ff0000');
  control.press(2, 0, '#ff0000');
  control.release(1);
  assert.deepEqual(calls, [['press', 0, '#ff0000']]);
  control.release(2);
  assert.deepEqual(calls.at(-1), ['release', 0]);
});

test('Matrix cleanup clears lock and cannot revive old pointer releases', () => {
  const { control, calls, states } = bench();
  control.setLocked(true);
  control.press(1, 0, '#ff0000');
  control.clear();
  control.release(1);
  assert.deepEqual(calls, [['press', 0, '#ff0000'], ['clear']]);
  assert.deepEqual(states.at(-1), { locked: false, cells: [] });
});

test('Refused Matrix cells are removed from the locked selection', () => {
  const { control, states } = bench();
  control.setLocked(true);
  control.press(1, 0, '#ff0000');
  control.refused(0);
  assert.deepEqual(states.at(-1).cells, []);
});

for (const [field, before, after] of [['armed', true, false], ['running', true, false], ['paused', false, true],
  ['blackout', false, true], ['connected', true, false], ['voice', 'matrix-1', null]]) {
  test(`Matrix releases selection when ${field} changes to ${after}`, () => {
    assert.equal(matrixShouldRelease({ [field]: before }, { [field]: after }), true);
  });
}

test('A new Matrix voice and ordinary snapshots keep the selection', () => {
  assert.equal(Boolean(matrixShouldRelease(null, { armed: false })), false);
  assert.equal(Boolean(matrixShouldRelease({ voice: 'a' }, { voice: 'b' })), false);
});
