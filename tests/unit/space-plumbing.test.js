// The unit space reaches every effect room: the renderer's base layer and its
// voices, the browser's preview, and a read-only report for the operator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import express from 'express';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision } from '../../src/server/profiles.ts';
import { registerKind } from '../../src/shared/effects/registry.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { RoomSceneStore } from '../../src/server/room-scene-store.ts';
import { attachRoomSceneRoutes } from '../../src/server/routes/room-scene.ts';
import { syntheticRig } from '../../scripts/golden-frames.js';
import { lookInput } from '../../scripts/golden-party-looks.js';

// A probe kind: it records the room it was given and paints each unit red by its room x.
const seen = [];
registerKind({
  kind: 'test.space-probe', app: 'own', level: 'cell', schema: z.object({}).passthrough(), defaults: { params: {} },
  init: () => ({}),
  render(_params, _state, room, _frame, out) {
    seen.push(room);
    const xs = room.space?.x;
    const lo = xs ? Math.min(...xs) : 0, hi = xs ? Math.max(...xs) : 1;
    for (let i = 0; i < room.n; i++) {
      const t = xs ? (xs[i] - lo) / Math.max(1e-9, hi - lo) : 0;
      out[i] = { colour: { r: Math.round(255 * t), g: 0, b: 255, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
    }
  },
});
const PROBE = { kind: 'test.space-probe', params: {} };

const synthetic = syntheticRig();
const pars = synthetic.fixtures.slice(0, 6);
const room = roomSceneSchema.parse(synthetic.room);
const rig = buildRig(pars, getProfile);
const space = buildUnitSpace(rig, room);

function renderBytes(renderer, input, beat = 0) {
  const store = universes.createUniverseStore(universes.allocateShared());
  renderer.frame(input, { beatPos: beat, bpm: 120, epoch: 0 }, beat * 500, store);
  return Array.from(store.getBuffer(0).subarray(0, 72));
}
const freshRenderer = () => createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
const probeInput = (extra = {}) => ({ ...lookInput('probe', pars, () => PROBE), ...extra });

test('a renderer without a space gives its effects a plan-only room', () => {
  seen.length = 0;
  renderBytes(freshRenderer(), probeInput());
  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1).space, undefined);
});

test('after setSpace the base effect sees the space in room order', () => {
  seen.length = 0;
  const renderer = freshRenderer();
  renderer.setSpace(space);
  renderBytes(renderer, probeInput());
  const seenRoom = seen.at(-1);
  assert.equal(seenRoom.space.x.length, seenRoom.n);
  assert.deepEqual(seenRoom.space.listener, { x: 0, y: 1.15, z: 0, facingDeg: 0 });
  assert.deepEqual(Object.keys(seenRoom.space.anchors), ['speakerLeft', 'speakerRight']);
  assert.deepEqual(seenRoom.space.bounds, { width: 4, depth: 4, height: 2.6 });
});

test('voices see the same space', () => {
  seen.length = 0;
  const renderer = freshRenderer();
  renderer.setSpace(space);
  const voice = { id: 'probe-voice', spec: PROBE, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  renderBytes(renderer, { ...lookInput('solid', pars), voices: [voice] });
  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1).space.x.length, 6);
});

test('a space built for another rig is ignored rather than misread', () => {
  seen.length = 0;
  const renderer = freshRenderer();
  renderer.setSpace(buildUnitSpace(buildRig(synthetic.fixtures, synthetic.profileOf), room));
  renderBytes(renderer, probeInput());
  assert.equal(seen.at(-1).space, undefined);
  renderer.setSpace(null);
  renderBytes(renderer, probeInput());
  assert.equal(seen.at(-1).space, undefined);
});

test('an existing look renders the same bytes with and without a space', () => {
  const plain = freshRenderer(), spaced = freshRenderer();
  spaced.setSpace(space);
  for (const id of ['solid', 'chase', 'radial-pulse']) {
    for (const beat of [0, 1.25, 3]) assert.deepEqual(renderBytes(spaced, lookInput(id, pars), beat), renderBytes(plain, lookInput(id, pars), beat), `${id} @ ${beat}`);
  }
});

test('the preview reads the space the renderer reads', () => {
  const renderer = freshRenderer();
  renderer.setSpace(space);
  const bytes = renderBytes(renderer, probeInput());
  const sample = (options) => createPreviewSampler([{ timeMs: 0, action: 'patch', data: { pattern: 'probe', bpm: 120 } }], null,
    { resolveEffect: (id) => (id === 'probe' ? PROBE : null), ...options })(0, pars, COLOR_PRESETS, rig);
  const spaced = sample({ space }), plain = sample({});
  const red = getProfile(pars[0]).channelMap.red;
  assert.deepEqual(spaced.map((c) => c.r), pars.map((f) => bytes[f.address - 1 + red]));
  assert.ok(spaced.some((c) => c.r > 0) && plain.every((c) => c.r === 0), 'the space changes what the probe paints');
  assert.deepEqual(sample({ space: null }), plain);
});

test('the report lists every unit as unbound when no room is imported', async (t) => {
  const app = express();
  attachRoomSceneRoutes(app, new RoomSceneStore('/nonexistent/stage-room.json'), () => rig);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stage/room/report`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revision: 'empty', units: 6, unbound: [0, 1, 2, 3, 4, 5], shared: [], far: [] });
});

test('the engine hands the patch space to its renderer, on either thread', async () => {
  await import('../helpers/space-lit-kind.js');
  const path = await import('node:path');
  const { state } = await import('../../src/server/state.ts');
  const { startEngine, stopEngine, engineStatus, setEffectSource } = await import('../../src/server/engine.ts');
  const { applyPatch } = await import('../../src/server/patch.ts');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fixture = state.fixtures[0];
  const red = () => universes.getBuffer(fixture.universe ?? state.artnet.universe)[fixture.address - 1 + getProfile(fixture).channelMap.red];
  state.artnet.enabled = false;
  setEffectSource((pattern) => (pattern === 'space-lit' ? { kind: 'test.space-lit', params: {} } : null));
  applyPatch({ pattern: 'space-lit', running: true, masterDimmer: 255, masterBlackout: false });
  try {
    for (const [thread, file] of [['main', null], ['worker', path.join(import.meta.dirname, '..', 'helpers', 'space-lit-worker.js')]]) {
      startEngine({ thread, file });
      try {
        const until = Date.now() + 5000;
        while (red() !== 255 && Date.now() < until) await wait(20);
        assert.equal(engineStatus().thread, thread);
        assert.equal(red(), 255, `${thread}: the effect room carried the space`);
      } finally {
        await stopEngine();
      }
    }
  } finally {
    setEffectSource(null);
    applyPatch({ pattern: 'solid' });
  }
});
