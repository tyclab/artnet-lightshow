import test from 'node:test';
import assert from 'node:assert/strict';
import { PictureInput, PictureInputError } from '../../src/server/picture.ts';

function setup({ armed = true, acknowledged = true, units = 4, signature = 'rig-a' } = {}) {
  let now = 0;
  const flags = { armed, acknowledged, rig: { signature, units } };
  const input = new PictureInput({ now: () => now, armed: () => flags.armed, acknowledged: () => flags.acknowledged, rig: () => flags.rig });
  return { input, flags, tick: (ms) => { now += ms; } };
}
const bytes = (units, fill = 7) => Uint8Array.from({ length: units * 3 }, () => fill);
const code = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof PictureInputError); return err.code; } return null; };

test('one sender claims the rig by signature, paints and releases', () => {
  const { input, tick } = setup();
  const claim = input.claim('a', { signature: 'rig-a' });
  assert.equal(claim.ok, true); assert.equal(claim.units, 4); assert.equal(claim.order, 'units');
  assert.equal(input.current(), null, 'no frame before the first one');
  assert.deepEqual(input.frame('a', { leaseId: claim.leaseId, data: bytes(4) }), { ok: true });
  assert.equal(input.current().data[0], 7);
  assert.equal(input.current(100).expiresAt, 2100, 'the worker clock shift applies to the deadline');
  assert.equal(code(() => input.claim('b', { signature: 'rig-a' })), 'BUSY');
  tick(60);
  assert.equal(code(() => input.frame('b', { leaseId: claim.leaseId, data: bytes(4) })), 'NO_LEASE');
  input.release('a', { leaseId: claim.leaseId });
  assert.equal(input.current(), null);
});

test('a frame may carry the small picture it was sampled from, for the Stage screens', () => {
  const { input, tick } = setup();
  const claim = input.claim('a', { signature: 'rig-a' });
  assert.equal(input.image(), null);
  const picture = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) };
  assert.deepEqual(input.frame('a', { leaseId: claim.leaseId, data: bytes(4), image: picture }), { ok: true });
  assert.deepEqual(input.image(), picture);
  assert.notEqual(input.image().data, picture.data, 'the picture is copied');
  tick(100);
  assert.deepEqual(input.frame('a', { leaseId: claim.leaseId, data: bytes(4) }), { ok: true });
  assert.deepEqual(input.image(), picture, 'a frame without a picture keeps the last one');
  tick(100);
  assert.equal(code(() => input.frame('a', { leaseId: claim.leaseId, data: bytes(4), image: { width: 2, height: 1, data: Uint8Array.from([1, 2, 3]) } })), 'INVALID');
  assert.equal(code(() => input.frame('a', { leaseId: claim.leaseId, data: bytes(4), image: { width: 129, height: 1, data: new Uint8Array(129 * 3) } })), 'INVALID');
  tick(2001);
  assert.equal(input.image(), null, 'gone with the lease');
});

test('a frame must carry one colour per unit and respect the rate limit', () => {
  const { input, tick } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  assert.equal(code(() => input.frame('a', { leaseId, data: bytes(3) })), 'INVALID');
  assert.equal(code(() => input.frame('a', { leaseId, data: [1, 2, 3] })), 'INVALID');
  input.frame('a', { leaseId, data: bytes(4) });
  assert.equal(code(() => input.frame('a', { leaseId, data: bytes(4) })), 'RATE_LIMIT');
  tick(50);
  assert.deepEqual(input.frame('a', { leaseId, data: bytes(4, 9) }), { ok: true });
  assert.equal(input.current().data[11], 9);
});

test('a stale signature is refused and a changed rig ends the lease', () => {
  const { input, flags } = setup();
  assert.equal(code(() => input.claim('a', { signature: 'rig-old' })), 'STALE');
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(4) });
  flags.rig = { signature: 'rig-b', units: 5 };
  assert.equal(input.current(), null);
  assert.equal(input.status(), null);
  assert.equal(code(() => input.frame('a', { leaseId, data: bytes(4) })), 'NO_LEASE');
});

test('frames expire after two seconds, and a disarm or a revoked acknowledgement clears the lease', () => {
  const { input, flags, tick } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(4) });
  tick(1999); assert.ok(input.current());
  tick(1); assert.equal(input.current(), null);
  const again = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId: again.leaseId, data: bytes(4) });
  flags.armed = false;
  assert.equal(input.current(), null);
  flags.armed = true;
  assert.equal(code(() => input.claim('a', { signature: 'rig-a' })), null);
  flags.acknowledged = false;
  assert.equal(code(() => input.claim('a', { signature: 'rig-a' })), 'ACKNOWLEDGEMENT_REQUIRED');
  flags.acknowledged = true; flags.armed = false;
  assert.equal(code(() => input.claim('a', { signature: 'rig-a' })), 'DISARMED');
});

test('a disconnect drops only its own lease', () => {
  const { input } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.disconnect('b');
  assert.deepEqual(input.frame('a', { leaseId, data: bytes(4) }), { ok: true });
  input.disconnect('a');
  assert.equal(input.status(), null);
});
