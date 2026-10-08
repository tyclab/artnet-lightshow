import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capturePadLayout, previewPadLayout } from '../../src/server/pad-layouts.ts';
import { PadStore } from '../../src/server/pads.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { validateSequence } from '../../src/server/sequencer.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';

const fixtures = [{ id: 17, label: 'Left' }, { id: 42, label: 'Right' }];
function bench(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'show-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pads = new PadStore(path.join(dir, 'pads.json'));
  return { dir, pads, shelf: new SequenceStore(path.join(dir, 'sequences.json')) };
}

for (const targets of [[17, 42], [], 'shared']) {
  test(`Layout remapping preserves ${JSON.stringify(targets)} targets`, (t) => {
    const { pads } = bench(t);
    const entries = pads.layout(); entries[0].targets = targets;
    const saved = capturePadLayout(entries, fixtures, 'layout', 'Two lamps');
    const next = previewPadLayout(saved, [{ id: 9, label: 'Front' }, { id: 3, label: 'Back' }], () => true);
    assert.deepEqual(next.pads[0].targets, Array.isArray(targets) ? targets.map((id) => id === 17 ? 9 : 3) : targets);
    assert.deepEqual(next.missingSlots, []);
  });
}

test('Layout capture refuses targets outside the current show order', (t) => {
  const { pads } = bench(t);
  const entries = pads.layout(); entries[0].targets = [99];
  assert.throws(() => capturePadLayout(entries, fixtures, 'layout', 'Missing'), { status: 409 });
});

test('Layout preview names unavailable fixture slots', (t) => {
  const { pads } = bench(t);
  const entries = pads.layout(); entries[0].targets = [42];
  const layout = capturePadLayout(entries, fixtures, 'layout', 'Missing');
  const preview = previewPadLayout(layout, [fixtures[0]], () => true);
  assert.deepEqual(preview.missingSlots, [1]);
  assert.deepEqual(preview.pads[0].targets, []);
});

test('Explicit layout remapping follows selected fixture identities', (t) => {
  const { pads } = bench(t);
  const entries = pads.layout(); entries[0].targets = [17];
  const layout = capturePadLayout(entries, fixtures, 'layout', 'Mapped');
  assert.deepEqual(previewPadLayout(layout, fixtures, () => true, [42, 17]).pads[0].targets, [42]);
});

test('Missing layout content becomes an explicit unassigned pad', (t) => {
  const { pads } = bench(t);
  const layout = capturePadLayout(pads.layout(), fixtures, 'layout', 'Missing');
  const preview = previewPadLayout(layout, fixtures, (content) => content.id !== 'energy.whiteStrobe');
  assert.equal(preview.pads[0].content, null);
  assert.equal(preview.pads[1].content.id, 'energy.colorStrobe');
  assert.equal(preview.missingContent[0].id, 'energy.whiteStrobe');
});

test('Scoped pad edits retain global pads and avoid global file writes', (t) => {
  const { pads } = bench(t);
  const global = pads.layout();
  let performance = { master: { ...HD_MASTER_DEFAULTS }, pads: pads.layout(), activePadLayoutId: null };
  pads.setScope(() => performance, (next, activePadLayoutId) => { performance = { ...performance, pads: next, activePadLayoutId }; });
  pads.set(0, 0, { ...pads.get(0, 0), label: 'Show-only pad' });
  assert.equal(pads.get(0, 0).label, 'Show-only pad');
  assert.equal(fs.existsSync(pads.file), false);
  performance = null;
  assert.deepEqual(pads.layout(), global);
});

test('Scoped setup is optional in legacy sequences', () => {
  const legacy = validateSequence({ id: 'old', name: 'Old', mode: 'arrangement' });
  assert.equal(Object.hasOwn(legacy, 'performance'), false);
});

test('A named layout survives shelf reload with its remapping data', (t) => {
  const { pads, shelf } = bench(t);
  const entries = pads.layout(); entries[0].targets = [42];
  const layout = capturePadLayout(entries, fixtures, 'layout', 'Reusable');
  shelf.savePadLayout(layout);
  assert.deepEqual(new SequenceStore(shelf.file).load().padLayout('layout'), layout);
});

test('Deleting a layout detaches saved shows but retains pad snapshots', (t) => {
  const { pads, shelf } = bench(t);
  shelf.savePadLayout(capturePadLayout(pads.layout(), fixtures, 'layout', 'Reusable'));
  shelf.save({ id: 'show', name: 'Show', mode: 'arrangement', performance: {
    master: { ...HD_MASTER_DEFAULTS }, pads: pads.layout(), activePadLayoutId: 'layout',
  } });
  shelf.removePadLayout('layout');
  const restored = new SequenceStore(shelf.file).load();
  assert.equal(restored.padLayout('layout'), null);
  assert.equal(restored.get('show').performance.activePadLayoutId, null);
  assert.deepEqual(restored.get('show').performance.pads, pads.layout());
});

test('A failed layout write retains the prior library snapshot', (t) => {
  const { pads, shelf } = bench(t);
  const layout = capturePadLayout(pads.layout(), fixtures, 'layout', 'Before');
  shelf.savePadLayout(layout);
  shelf.writeJson = () => { throw new Error('disk full'); };
  assert.throws(() => shelf.savePadLayout({ ...layout, name: 'After' }), { status: 500 });
  assert.equal(shelf.padLayout('layout').name, 'Before');
});
