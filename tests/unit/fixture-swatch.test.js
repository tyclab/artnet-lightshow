// A fixture card's lit swatch under a live feed (tests/helpers/render-audit.js):
// the feed paints it, it does not render it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAudited, mount } from '../helpers/render-audit.js';

const ui = await loadAudited(`export { dmxSig } from './public-src/state.js';
  export { FixturePreview } from './public-src/components/Fixtures.jsx';`);

const BAR = { id: 'swatch-bar', name: 'Bar', channelCount: 384, channelMap: {},
  cells: Array.from({ length: 128 }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const state = { profiles: { [BAR.id]: BAR }, masterBlackout: false, masterDimmer: 255 };
const fix = { id: 1, label: 'Bar', universe: 1, address: 1, profileId: BAR.id };

test('DMX frames do not re-render a fixture swatch', () => {
  ui.dmxSig.value = { 1: new Uint8Array(512) };
  const view = mount(ui, ui.FixturePreview, { fix, state });
  try {
    for (let i = 1; i <= 5; i++) ui.dmxSig.value = { 1: new Uint8Array(512).fill(i * 40) };
    assert.equal(view.seen.renders, 1);
    assert.equal(view.seen.tree.props.title, '128 cells');
  } finally { view.stop(); }
});
