import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { createUniverseStore, allocateShared } from '../../src/server/universes.ts';

test('rendering reuses equivalent snapshots but observes in-place geometry and profile edits', () => {
  const profile = { id: 'mapped', channelMap: {}, channelCount: 9,
    cells: Array.from({ length: 3 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) };
  const input = { running: true, pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0,
    split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard',
    masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, universes: [0],
    fixtures: [{ id: 1, profileId: profile.id, universe: 0, address: 1, maxBrightness: 255, override: null,
      position: { x: 50, y: 50, height: 20 }, geometry: { length: 10, angle: 0,
        points: [{ x: -5, y: 0, height: 0 }, { x: 0, y: 0, height: 30 }, { x: 5, y: 0, height: 60 }] } }] };
  let revision = 0;
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => revision, now: 0 });
  const store = createUniverseStore(allocateShared());
  let frame = 0;
  const render = () => renderer.frame(input, { beatPos: frame / 22, bpm: 120, epoch: 0 }, frame++ * 1000 / 44, store);
  const original = render();
  assert.deepEqual(original.points.map((p) => p.height), [20, 50, 80]);
  for (let i = 0; i < 5; i++) {
    input.fixtures = structuredClone(input.fixtures);
    assert.equal(render(), original, 'fresh worker snapshots with equal coordinates reuse the rig');
  }
  input.fixtures[0].geometry.points[1].height = 40;
  const edited = render();
  assert.notEqual(edited, original);
  assert.deepEqual(edited.points.map((p) => p.height), [20, 60, 80]);
  input.fixtures[0].geometry.points[1].x = 2;
  assert.equal(render().points[1].x, 52, 'an in-place coordinate edit reaches the rendered rig');
  input.fixtures[0].geometry.points.reverse();
  assert.deepEqual(render().points.map((p) => p.height), [80, 60, 20]);
  const beforePosition = render();
  input.fixtures[0].position.y = 40;
  const moved = render();
  assert.notEqual(moved, beforePosition);
  assert.equal(moved.points[0].y, 40);
  revision++;
  assert.notEqual(render(), moved, 'profile revisions rebuild channel and pixel geometry');
  input.fixtures.length = 0;
  assert.equal(render().units.length, 0);
});
