// Flash safety for every v2 generator: a beat accent fast and short enough to strobe asks for the
// photosensitivity acknowledgement, and every v2 light takes the per-lamp flash permit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { getProfile, profilesRevision } from '../../src/server/profiles.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { hdGuarded } from '../../src/shared/effects/layer.ts';
import { lookInput } from '../../scripts/golden-party-looks.js';
import { syntheticRig } from '../../scripts/golden-frames.js';
import '../../src/shared/effects/index.ts';
import { audioOf } from '../helpers/v2-frames.js';

const STROBING = { trigger: { mode: 'beatAccent', band: 'full', beatInterval: 0.125, threshold: 0.15, reactiveDepth: 1 },
  envelope: { curve: 'cut', attack: 0, hold: 0.03, release: 0 } };
const KINDS = {
  'v2.sweep': { profile: 'gradient' }, 'v2.orbit': { profile: 'gradient' }, 'v2.neural': { smoothing: 0 },
  'v2.shell': { profile: 'fill', origin: 'centre', speed: 40 }, 'v2.scatter': { density: 1, stepBeats: 1 },
};
const pars = syntheticRig().fixtures.slice(0, 6);
const red = getProfile(pars[0]).channelMap.red;

function trace(spec, acknowledged, ms = 3000) {
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const store = createUniverseStore(allocateShared());
  const input = { ...lookInput('probe', pars, () => validateSpec(spec)), safety: { acknowledged, hdFlashIntervalMs: 350 },
    audioMode: 'reactive', audio: audioOf({ full: 1, bass: 1, mid: 1, high: 1 }) };
  const out = [];
  for (let k = 0; k * FRAME_MS <= ms; k++) {
    const t = k * FRAME_MS;
    renderer.frame(input, { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store, 0);
    out.push({ t, level: store.getBuffer(0)[pars[0].address - 1 + red] });
  }
  return out;
}
const risesOf = (frames) => { const rises = []; let was = false; for (const { t, level } of frames) { const on = level > 140; if (on && !was) rises.push(t); was = on; } return rises; };

for (const [kind, params] of Object.entries(KINDS)) {
  test(`${kind}: a fast, short beat accent asks for the acknowledgement and stays dark without it`, () => {
    const spec = { kind, params: { ...params, ...STROBING }, palette: ['#FFFFFF'] };
    assert.equal(requiresAcknowledgement(validateSpec(spec)), true);
    assert.ok(trace(spec, false).every(({ level }) => level === 0));
    assert.equal(requiresAcknowledgement(validateSpec({ ...spec, params: { ...spec.params, trigger: { ...STROBING.trigger, beatInterval: 1 } } })), false, 'once a beat is no strobe');
  });

  test(`${kind}: every light takes the per-lamp flash permit`, () => {
    assert.equal(hdGuarded(kind), true);
    const spec = { kind, params: { ...params, ...STROBING }, palette: ['#FFFFFF'] };
    const rises = risesOf(trace(spec, true));
    assert.ok(rises.length > 2, kind);
    for (let k = 1; k < rises.length; k++) assert.ok(rises[k] - rises[k - 1] >= 350 - 1e-6, `${kind}: rises ${rises[k - 1]} and ${rises[k]}`);
  });
}

test('an 8 Hz stripe sweep, which no acknowledgement gates, is held to the per-lamp permit', () => {
  const spec = { kind: 'v2.sweep', params: { profile: 'stripe', width: 0.25, speed: 2, azimuthDeg: 90 }, palette: ['#FFFFFF'] };
  const rises = risesOf(trace(spec, false));
  assert.ok(rises.length > 2);
  for (let k = 1; k < rises.length; k++) assert.ok(rises[k] - rises[k - 1] >= 350 - 1e-6, `rises ${rises[k - 1]} and ${rises[k]}`);
});
