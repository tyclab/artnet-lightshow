import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { state, getLiveState } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';
import { LookStore, currentLook, putBack } from '../../src/server/look-store.ts';
import { validate, patchSchema } from '../../src/server/validation.ts';
import { DEFAULT_BACKGROUND } from '../../src/shared/background.ts';

const fixed = { ...DEFAULT_BACKGROUND, mode: 'fixed', level: .37, colour: { r: 80, g: 70, b: 60, w: 50, a: 40, uv: 30 } };
const off = { ...DEFAULT_BACKGROUND, mode: 'off' };
test.after(() => stopEngine());

test('ordinary effect selection and cue recall preserve the operator background', () => {
  applyPatch({ pattern: 'solid', background: fixed });
  const look = captureLook();
  assert.deepEqual(getLiveState().background, fixed);
  applyPatch({ pattern: 'chase', background: off });
  recallLook(look);
  assert.deepEqual(state.background, off);
  recallLook(look, true);
  assert.deepEqual(state.background, fixed);
  applyPatch({ pattern: 'solid' });
  assert.deepEqual(state.background, fixed);
});

test('background settings survive the real restart record and all six emitters retain their values', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  applyPatch({ background: fixed });
  const file = path.join(dir, 'look.json');
  new LookStore(file).save(currentLook(null));
  applyPatch({ background: off });
  assert.equal(putBack(new LookStore(file).load()), true);
  assert.deepEqual(state.background, fixed);
});

test('invalid versions and emitter values are rejected before changing state', () => {
  applyPatch({ background: fixed });
  for (const background of [{ ...fixed, version: 2 }, { ...fixed, level: -1 }, { ...fixed, mode: 'blackout' },
    { ...fixed, colour: { ...fixed.colour, uv: 256 } }]) {
    assert.throws(() => validate(patchSchema, { background }, 'set'));
    assert.deepEqual(state.background, fixed);
  }
});
