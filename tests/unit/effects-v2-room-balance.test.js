import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { frameAt, audioOf, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

const FLASH = { curve: 'linear', attack: 0, hold: 0.06, release: 0.04 };

test('a dense pixel fixture cannot crowd individual lamps out of Scatter', () => {
  const pixels = 2856, lamps = 13, n = pixels + lamps;
  const plain = buildRoom(n, (i) => i < pixels ? (i % 68) / 67 : (i - pixels) / 12, () => 0.5, () => 0.5, null);
  const x = Float32Array.from({ length: n }, (_, i) => i < pixels ? (i % 68) * 0.04 - 1.36 : Math.cos((i - pixels) / lamps * Math.PI * 2) * 2);
  const y = Float32Array.from({ length: n }, (_, i) => i < pixels ? Math.floor(i / 68) * 0.04 : 1);
  const z = Float32Array.from({ length: n }, (_, i) => i < pixels ? -2 : Math.sin((i - pixels) / lamps * Math.PI * 2) * 2);
  const room = { ...plain, lamps: { slots: [Array.from({ length: pixels }, (_, i) => i), ...Array.from({ length: lamps }, (_, i) => [pixels + i])] },
    space: { x, y, z, size: new Float32Array(n).fill(0.02), bounds: { width: 5, depth: 5, height: 3 }, anchors: {}, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 } } };
  const counts = new Array(lamps).fill(0);
  let curtainSteps = 0;
  for (let step = 0; step < 240; step++) {
    const { out } = renderKind({ kind: 'v2.scatter', params: { density: 0.2, envelope: FLASH } }, room, frameAt(step * 0.25 + 0.01));
    counts.forEach((_, k) => { if (out[pixels + k].level > 0) counts[k]++; });
    const lit = out.slice(0, pixels).filter((s) => s.level > 0).length;
    if (lit) { curtainSteps++; assert.ok(lit > 1 && lit < pixels / 4, 'a spatial segment, rather than one pixel or the whole curtain'); }
  }
  assert.ok(counts.every((n) => n >= 15), `every lamp participates: ${counts}`);
  assert.ok(curtainSteps > 10 && curtainSteps < 150, `curtain shares the selection: ${curtainSteps}`);
});

test('Rotation crosses sector edges smoothly on a vertical wall in room and plan', () => {
  const { room } = syntheticRoom();
  for (const space of ['room', 'plan']) {
    let previous = null, maxJump = 0;
    for (let t = 0; t < 8; t += 1 / 44) {
      const { out } = renderKind({ kind: 'v2.orbit', params: { space, profile: 'sectors', sectors: 2, turnsPerBar: 0.5 } }, room, frameAt(t * 2));
      if (previous) for (let i = 0; i < out.length; i++) {
        maxJump = Math.max(maxJump, ...['r', 'g', 'b'].map((k) => Math.abs(out[i].colour[k] - previous[i].colour[k])));
      }
      previous = out;
    }
    assert.ok(maxJump < 35, `${space}: largest frame channel change ${maxJump}`);
  }
});

test('every spatial preset has no implicit background and goes black when its input gate is closed', () => {
  const { room } = syntheticRoom();
  for (const preset of V2_PRESETS) {
    assert.equal(preset.spec.params.background, 0, `${preset.id}: background is opt-in`);
    if ('idle' in preset.spec.params) assert.equal(preset.spec.params.idle, 0, `${preset.id}: no idle glow`);
    const spec = { ...preset.spec, params: { ...preset.spec.params,
      trigger: { mode: 'volumeGate', band: 'full', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } } };
    const { out } = renderKind(spec, room, frameAt(0.5, { audio: audioOf() }));
    for (const slot of out) {
      assert.equal(slot.level, 0, `${preset.id}: rest brightness`);
      assert.ok(Object.values(slot.colour).every((v) => v === 0), `${preset.id}: rest colour`);
    }
  }
});
