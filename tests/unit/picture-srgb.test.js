// A screen picture's bytes are sRGB. With the decode on, each picture unit and each streamed
// panel pixel is decoded once to linear light, before the black point, the grade and the
// masters; off, the default, the bytes drive the lamps as sent (a WLED board has its own gamma).
// The Stage's screens keep the picture as sent, and nothing on the Hue path decodes again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SRGB_DECODE } from '../../src/shared/color.ts';
import { blackPointGain, PICTURE_GRADE_DEFAULTS } from '../../src/shared/picture-grade.ts';
import { hueSectionColour } from '../../src/shared/hue-colour.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { PictureInput } from '../../src/server/picture.ts';
import { DEFAULTS } from '../../src/server/settings.ts';
import { getProfile, HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import * as hue from '../../src/server/hue.ts';

const srgb = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

test('the decode table is the IEC 61966-2-1 curve at every byte', () => {
  assert.equal(SRGB_DECODE.length, 256);
  for (let v = 0; v < 256; v++) assert.ok(Math.abs(SRGB_DECODE[v] - 255 * srgb(v)) < 1e-9, `byte ${v}`);
  for (let v = 1; v < 256; v++) assert.ok(SRGB_DECODE[v] > SRGB_DECODE[v - 1], `rises at ${v}`);
  assert.deepEqual([0, 255, 128, 75].map((v) => Math.round(SRGB_DECODE[v])), [0, 255, 55, 18]);
  assert.ok(Math.abs(SRGB_DECODE[10] - 255 * 10 / 255 / 12.92) < 1e-9, 'the linear toe below 0.04045');
});

const par = { id: 'srgb-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const lamp = getProfile({ profileId: HUE_COLOR_PROFILE_ID });
const fixture = (id, profileId, universe, hueLamp) => ({ id, profileId, address: 1, universe, maxBrightness: 255, override: null, hue: hueLamp,
  position: { x: id * 30, y: 50 }, group: null, geometry: null, output: hueLamp ? { protocol: 'hue', channel: 0 } : { protocol: 'ddp', host: '127.0.0.1' } });
const profiles = { [par.id]: par, [lamp.id]: lamp };
const frameInput = (bytes, patch) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, universes: [1, 2],
  fixtures: [fixture(1, par.id, 1, false), fixture(2, lamp.id, 2, true)],
  picture: { leaseId: 'lease', signature: 'rig', units: 2, expiresAt: 2000, data: Uint8Array.from([...bytes, ...bytes]) }, ...patch,
});
function paint(bytes, patch = {}) {
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
  const input = frameInput(bytes, patch);
  renderer.frame(input, { beatPos: 0.2, bpm: 120, epoch: 0 }, 100, store, 0);
  const read = (universe, profile) => channelReader(universe, 1, profile, (u) => store.getBuffer(u));
  const p = read(1, par), h = read(2, lamp);
  return { par: [p(0), p(1), p(2)], hue: hueSectionColour(lamp.channelMap, h, null), data: input.picture.data };
}

test('with the decode on, a picture unit of sRGB (200, 120, 60) paints its linear light, (147, 48, 12), before the masters', () => {
  assert.deepEqual(paint([200, 120, 60], { pictureDecode: true }).par, [147, 48, 12]);
  assert.deepEqual(paint([75, 75, 75], { pictureDecode: true }).par, [18, 18, 18], 'a 29 % byte is 7 % light');
  assert.deepEqual(paint([200, 120, 60]).par, [200, 120, 60], 'off, or absent, the bytes as sent');
  assert.deepEqual(paint([200, 120, 60], { pictureDecode: false }).par, [200, 120, 60]);
});

test('decode off by default: a unit is its bytes, lifted off the black point, times the masters', () => {
  assert.equal(DEFAULTS.picture.grade.enabled, false);
  assert.equal(DEFAULTS.picture.decode, false);
  const stored = { pictureDecode: DEFAULTS.picture.decode, pictureBlackPoint: DEFAULTS.picture.blackPoint };
  const lifted = (bytes, gain) => bytes.map((v) => Math.round(v * blackPointGain(Math.max(...bytes), DEFAULTS.picture.blackPoint) * gain));
  for (const [bytes, masterDimmer] of [[[200, 120, 60], 255], [[200, 120, 60], 128], [[255, 128, 30], 200], [[64, 32, 0], 255]]) {
    const expected = lifted(bytes, masterDimmer / 255);
    assert.deepEqual(paint(bytes, { ...stored, pictureGrade: PICTURE_GRADE_DEFAULTS, masterDimmer }).par, expected, `${bytes} at ${masterDimmer}`);
    assert.deepEqual(paint(bytes, { ...stored, pictureGrade: null, masterDimmer }).par, expected);
    assert.notDeepEqual(expected, bytes.map((v) => Math.round(SRGB_DECODE[v] * (masterDimmer / 255))), `${bytes}: never decoded`);
  }
  assert.deepEqual(paint([255, 128, 30], stored).par, [255, 128, 30], 'a full peak is copied unchanged');
  assert.deepEqual(paint([64, 32, 0], stored).par, [38, 19, 0], 'a quarter peak ramps, hue kept');
  assert.deepEqual(paint([30, 30, 30], stored).par, [0, 0, 0], 'the threshold byte is off');
  assert.deepEqual(paint([64, 32, 0], { ...stored, pictureDecode: true }).par, [64, 32, 0].map((v) => Math.round(SRGB_DECODE[v] * blackPointGain(SRGB_DECODE[64], 0.12))),
    'decode on: decoded, then lifted');
});

test('a Hue lamp gets the decoded colour once: its stream carries the same light as the par', () => {
  for (const bytes of [[200, 120, 60], [128, 128, 128], [255, 0, 0]]) {
    const out = paint(bytes, { pictureDecode: true });
    assert.deepEqual([out.hue.r, out.hue.g, out.hue.b], out.par, `${bytes}`);
    const packet = hue.buildStreamMessage('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [{ id: 0, ...out.hue }]);
    const at = hue.HEADER_BYTES + hue.CONFIG_ID_BYTES;
    assert.equal(packet[14], 0x00, 'the RGB colour space');
    assert.deepEqual([1, 3, 5].map((k) => packet.readUInt16BE(at + k)), out.par.map((v) => v * 257), `${bytes} on the wire`);
  }
});

test('the picture the Stage shows, and the frame the renderer reads, keep the sender\'s sRGB bytes', () => {
  const input = new PictureInput({ now: () => 0, armed: () => true, acknowledged: () => true, rig: () => ({ signature: 'rig', units: 2 }) });
  const { leaseId } = input.claim('sender', { signature: 'rig' });
  const image = { width: 2, height: 1, data: Uint8Array.from([200, 120, 60, 75, 75, 75]) };
  input.frame('sender', { leaseId, data: Uint8Array.from([200, 120, 60, 75, 75, 75]), image });
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
  renderer.frame(frameInput([], { picture: { ...input.current(), expiresAt: 2000 }, pictureDecode: true }), { beatPos: 0.2, bpm: 120, epoch: 0 }, 100, store, 0);
  assert.deepEqual([...input.image().data], [200, 120, 60, 75, 75, 75]);
  assert.deepEqual([...input.current().data], [200, 120, 60, 75, 75, 75]);
  const read = channelReader(1, 1, par, (u) => store.getBuffer(u));
  assert.deepEqual([read(0), read(1), read(2)], [147, 48, 12], 'while the lamp takes the decoded light');
});
