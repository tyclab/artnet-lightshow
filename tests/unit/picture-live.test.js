import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../../src/server/state.ts';
import { pictureInput, pictureUnits } from '../../src/server/picture-live.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { invalidateRig } from '../../src/server/rig.ts';
import { isArmed } from '../../src/server/armed.ts';
import { setArmed } from '../../src/server/output.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

test('cached picture geometry follows placement and profile edits and revokes stale leases', () => {
  const fixtures = state.fixtures, armed = isArmed(), restoreSafety = acknowledgeFlashes();
  const profile = (cells) => barProfile({ id: 'picture-cache-bar', name: 'Picture bar', cells, firstChannel: 1, order: 'RGB' });
  const send = (rig) => {
    const { leaseId } = pictureInput.claim('picture-cache-test', { signature: rig.signature });
    pictureInput.frame('picture-cache-test', { leaseId, data: new Uint8Array(rig.units * 3).fill(100) });
    return leaseId;
  };
  try {
    registerProfile(profile(2));
    state.fixtures = [{ id: 987, label: 'Bar', profileId: 'picture-cache-bar', universe: 0, address: 1,
      position: { x: 40, y: 50 }, geometry: { length: 20, angle: 0 }, maxBrightness: 255, override: null }];
    setArmed(true);
    const original = pictureUnits(), firstLease = send(original);
    assert.equal(original.units, 2);
    assert.deepEqual(pictureUnits(), original);
    assert.equal(pictureInput.current().leaseId, firstLease);

    state.fixtures[0].position.x += 20;
    const moved = pictureUnits();
    assert.equal(moved.list[0].x, original.list[0].x + 20);
    assert.notEqual(moved.signature, original.signature);
    assert.equal(pictureInput.current(), null);
    assert.throws(() => pictureInput.claim('picture-cache-test', { signature: original.signature }), { code: 'STALE' });
    const secondLease = send(moved);
    assert.equal(pictureInput.current().leaseId, secondLease);

    state.fixtures[0].geometry.points = [{ x: -4, y: -6, height: -10 }, { x: 4, y: 6, height: 10 }];
    const mapped = pictureUnits();
    assert.deepEqual(mapped.list.map(p => [p.x, p.y]), [[56, 44], [64, 56]]);
    assert.notEqual(mapped.signature, moved.signature);
    assert.equal(pictureInput.current(), null);
    send(mapped);
    state.fixtures[0].geometry.points[0].height++;
    assert.notEqual(pictureUnits().signature, mapped.signature);
    assert.equal(pictureInput.current(), null);
    delete state.fixtures[0].geometry.points;

    registerProfile(profile(3));
    const resized = pictureUnits();
    assert.equal(resized.units, 3);
    assert.notEqual(resized.signature, moved.signature);
    assert.equal(pictureInput.current(), null);
    send(resized);
    assert.equal(pictureInput.current().data.length, 9);
    setArmed(false);
    assert.equal(pictureInput.current(), null);
  } finally {
    pictureInput.clear();
    setArmed(armed);
    restoreSafety();
    state.fixtures = fixtures;
    unregisterProfile('picture-cache-bar');
    invalidateRig();
  }
});
