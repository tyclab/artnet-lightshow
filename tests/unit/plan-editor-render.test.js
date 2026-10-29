// The Rig view's plan under a live feed: what one render of PlanEditor reads
// and rebuilds (tests/helpers/render-audit.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAudited, mount as mountComponent } from '../helpers/render-audit.js';

const ui = await loadAudited(`export { store, dmxSig, connectedSig } from './public-src/state.js';
  export { rigSelectionSig } from './public-src/rig-ui.js';
  export { PlanEditor } from './public-src/components/setup/PlanEditor.jsx';`,
{ importer: 'PlanEditor.jsx', count: { 'src/shared/rig.ts': 'buildRig', 'src/shared/stage.ts': 'stagePositions' } });

const BAR = { id: 'plan-bar', name: 'Bar', channelCount: 384, channelMap: {},
  cells: Array.from({ length: 128 }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const PAR = { id: 'plan-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixtures = [
  { id: 1, label: 'Bar 1', universe: 1, address: 1, profileId: BAR.id, position: { x: 30, y: 40 } },
  { id: 2, label: 'Bar 2', universe: 2, address: 1, profileId: BAR.id, position: { x: 70, y: 40 } },
  { id: 3, label: 'Par', universe: 3, address: 1, profileId: PAR.id, position: { x: 50, y: 80 } },
];
const state = () => ({ fixtures, profiles: { [BAR.id]: BAR, [PAR.id]: PAR }, masterBlackout: false, masterDimmer: 255, identify: null,
  bpm: 120, clock: { source: 'tap', bpm: 120 } });
const frame = (value) => ({ 1: new Uint8Array(512).fill(value), 2: new Uint8Array(512).fill(value), 3: new Uint8Array(512).fill(value) });

function elements(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) elements(child, out); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  out.push(node);
  elements(node.props.children, out);
  return out;
}
const classed = (tree, name) => elements(tree).filter((node) => typeof node.type === 'string' && String(node.props.class || '').split(/\s+/).includes(name));

function mount() {
  ui.store.applySnapshot({ versions: {}, state: state() });
  ui.connectedSig.value = true;
  ui.rigSelectionSig.value = [];
  ui.dmxSig.value = frame(0);
  return mountComponent(ui, ui.PlanEditor);
}

test('a live DMX frame or an unrelated state key does not re-render the plan', () => {
  const view = mount();
  try {
    assert.equal(view.seen.renders, 1);
    for (let i = 1; i <= 5; i++) ui.dmxSig.value = frame(i * 40);
    assert.equal(view.seen.renders, 1, 'the DMX feed paints the plan without rendering it');
    ui.store.merge({ bpm: 128, clock: { source: 'tap', bpm: 128 } });
    assert.equal(view.seen.renders, 1, 'the tempo is not drawn on the plan');
    ui.store.merge({ masterBlackout: true });
    assert.equal(view.seen.renders, 2, 'the blackout master is drawn');
  } finally { view.stop(); }
});

test('the plan builds the rig layout once per patch, not once per render', () => {
  const view = mount();
  try {
    const before = { ...ui.calls };
    for (let i = 0; i < 5; i++) view.again();
    assert.deepEqual(ui.calls, before, 'unchanged patch: no rebuild');
    ui.store.merge({ fixtures: fixtures.map((f) => (f.id === 1 ? { ...f, position: { x: 35, y: 40 } } : f)) });
    assert.equal(ui.calls.buildRig, before.buildRig + 1, 'a moved fixture rebuilds the layout once');
  } finally { view.stop(); }
});

test('the plan draws bar cells on one canvas and rings each bar\'s first cell', () => {
  const view = mount();
  try {
    assert.equal(classed(view.seen.tree, 'stage-cells-canvas').length, 1);
    assert.equal(classed(view.seen.tree, 'stage-cells-canvas')[0].type, 'canvas');
    const cells = classed(view.seen.tree, 'stage-cell');
    assert.equal(cells.length, 2, 'one ring per bar, not an element per cell');
    assert.ok(cells.every((cell) => String(cell.props.class).split(/\s+/).includes('first')), 'the rings mark the first cells');
    assert.equal(classed(view.seen.tree, 'stage-fixture').length, 3, 'every fixture keeps its button');
  } finally { view.stop(); }
});
