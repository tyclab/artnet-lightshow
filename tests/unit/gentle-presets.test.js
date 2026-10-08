import test from 'node:test';
import assert from 'node:assert/strict';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';

const room = buildRoom(3, (index) => index / 2, () => 0.5, () => 0.5, null);
const colours = ['r', 'g', 'b', 'w', 'a', 'uv'];
for (const id of ['party.fire', 'party.ice']) {
  test(`${id} is an editable effect preset with full-channel gradients`, () => {
    const row = presetById(id);
    assert.equal(row.legacy, undefined);
    assert.equal(requiresAcknowledgement(row.spec), false);
    assert.deepEqual(validateSpec(structuredClone(row.spec)), row.spec);
    assert.equal(row.spec.palette.every((colour) => colour.length === 13), true);
    assert.equal(row.spec.gradients[0].space, 'rgb');
  });

  test(`${id} changes gently across complete loops at fast tempo`, () => {
    const spec = presetById(id).spec;
    const seed = seedFrom(id), stepper = new EffectStepper();
    const instance = { id, spec, seed, anchorBeat: 0, startedAtMs: 0, targets: null };
    let previous = null, peak = 0, largestStep = 0;
    for (let nowMs = 0; nowMs <= spec.params.loopLength * 300; nowMs += 20) {
      const frame = { beatPos: nowMs / 150, bpm: 400, nowMs, dtMs: 20, anchorBeat: 0, lookPalette: [{ r: 255 }], paletteOverride: null,
        audio: null, audioMode: 'reactive', master: HD_MASTER_DEFAULTS, seed, acknowledged: false, hueStrobe: 'flash' };
      const out = Array.from({ length: room.n }, () => ({ colour: {}, level: 0, strength: 0 }));
      renderEffect(instance, frame, room, stepper, out);
      const emitters = out.flatMap((slot) => colours.map((channel) => (slot.colour[channel] || 0) * slot.level));
      peak = Math.max(peak, ...emitters);
      if (previous) largestStep = Math.max(largestStep, ...emitters.map((value, index) => Math.abs(value - previous[index])));
      previous = emitters;
    }
    assert.ok(peak > 20 && peak <= 255 * spec.brightness + 0.001);
    assert.ok(largestStep < 12, `largest 20ms channel step: ${largestStep}`);
  });
}
