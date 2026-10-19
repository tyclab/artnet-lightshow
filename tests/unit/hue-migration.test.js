import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShow, snapshotShow } from '../../src/server/show-store.ts';
import { state, universeOf } from '../../src/server/state.ts';
import { listProfiles, getProfile, HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID } from '../../src/server/profiles.ts';
import { hueProfile } from '../../src/server/hue-profile.ts';
import { refreshHueFixtures } from '../../src/server/hue-migration.ts';
import { hueChannels } from '../../src/shared/hue-lamp.ts';
import { hueChannelColors } from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { areaLamp } from './hue-test-lamps.js';

function preservingShow(fn) {
  const before = snapshotShow();
  try { fn(); } finally { applyShow(before); }
}

const legacy = (id, channel, profileId = HUE_COLOR_PROFILE_ID) => ({
  id, profileId, label: `Saved lamp ${id}`, output: { protocol: 'hue', bridge: 'b1', channel },
  position: { x: 12, y: 34, height: 56 }, geometry: { length: 18, angle: 90 }, group: 'back',
  emission: { kind: 'beam', pan: 30, tilt: -20, beamAngle: 25 },
  maxBrightness: 150, productId: 'saved-product', hardware: { maxFlashHz: 1 }, admission: 'hold',
});

test('legacy Hue migration preserves every fixture and its binding identity without discovery', () => preservingShow(() => {
  const original = [legacy(7, 3), legacy(12, 4), legacy(18, 8, HUE_WHITE_PROFILE_ID)];
  applyShow({ fixtures: original, nextFixtureId: 200 });
  const saved = snapshotShow();
  assert.equal(saved.fixtures.length, original.length);
  assert.equal(saved.nextFixtureId, 200);
  for (let i = 0; i < original.length; i++) {
    const { output, ...fields } = original[i];
    assert.deepEqual(saved.fixtures[i], { ...fields, output: { protocol: 'hue', bridge: 'b1', channels: [output.channel] } });
    assert.equal(getProfile(state.fixtures[i]).hue.legacy, true);
  }
  applyShow(saved);
  assert.deepEqual(snapshotShow(), saved, 'a second load does not create profiles or change IDs');
}));

test('embedded older built-in profiles retain current Hue compatibility traits on show load', () => preservingShow(() => {
  const canonical = listProfiles()[HUE_COLOR_PROFILE_ID];
  const older = { ...canonical };
  delete older.hue;
  applyShow({ profiles: [older], fixtures: [legacy(9, 3)] });
  assert.deepEqual(getProfile(state.fixtures[0]), canonical);
  assert.deepEqual(state.fixtures[0].output, { protocol: 'hue', bridge: 'b1', channels: [3] });
  const saved = snapshotShow();
  assert.deepEqual(saved.profiles, [], 'built-in profiles are canonical, not copied into the show');
  applyShow(saved);
  assert.deepEqual(snapshotShow(), saved);
}));

test('saved gradient channel order and rendered section colours survive migration and reload', () => preservingShow(() => {
  const lamp = areaLamp({ id: 'saved-strip', channels: [9, 2, 7] });
  const profile = hueProfile(lamp, 'b1');
  applyShow({ profiles: [profile], fixtures: [{ id: 70, label: 'Gradient', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: lamp.channels } }, legacy(71, 11)] });
  const saved = snapshotShow();
  applyShow(saved);
  assert.deepEqual(snapshotShow(), saved);
  const fixture = state.fixtures[0];
  const buffer = universes.getBuffer(universeOf(fixture));
  buffer.fill(0);
  profile.cells.forEach((cell, i) => {
    buffer[fixture.address - 1 + cell.channelMap[['red', 'green', 'blue'][i]]] = 120 + i;
  });
  assert.deepEqual(hueChannelColors().get('b1').slice(0, 3), [
    { id: 9, r: 120, g: 0, b: 0 }, { id: 2, r: 0, g: 121, b: 0 }, { id: 7, r: 0, g: 0, b: 122 },
  ]);
}));

test('capability refresh preserves legacy sections as separate fixtures and is idempotent', () => preservingShow(() => {
  applyShow({ fixtures: [legacy(7, 3), legacy(12, 4)] });
  const lamp = areaLamp({ id: 'strip', channels: [3, 4, 5] });
  const before = structuredClone(state.fixtures);
  const result = refreshHueFixtures(state.fixtures, listProfiles(), 'b1', [lamp]);
  assert.deepEqual(state.fixtures, before, 'preparing refreshed profiles is read-only');
  assert.deepEqual(result.updates.map(({ id }) => id), [7, 12]);
  assert.ok(result.updates.every(({ profile }) => profile.hue.partial && !profile.hue.legacy && !profile.cells));
  const profiles = { ...listProfiles() };
  const refreshed = state.fixtures.map((fixture) => {
    const update = result.updates.find(({ id }) => id === fixture.id);
    profiles[update.profile.id] = update.profile;
    return { ...fixture, profileId: update.profile.id };
  });
  assert.deepEqual(refreshHueFixtures(refreshed, profiles, 'b1', [lamp]), result);
  assert.deepEqual(refreshed.map((fixture) => hueChannels(fixture.output)), [[3], [4]]);
}));

test('unreadable or changed bridge sections preserve existing fixtures and explain the skipped refresh', () => preservingShow(() => {
  const lamp = areaLamp({ id: 'strip', channels: [3, 4] });
  const profile = hueProfile(lamp, 'b1');
  applyShow({ profiles: [profile], fixtures: [{ id: 1, label: 'Strip', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: [3, 4] } }] });
  const before = snapshotShow();
  for (const discovered of [[], [{ ...lamp, capabilities: null }], [{ ...lamp, channels: [3, 4, 5] }]]) {
    const result = refreshHueFixtures(state.fixtures, listProfiles(), 'b1', discovered);
    assert.equal(result.updates.length, 0);
    assert.equal(result.skipped[0].id, 1);
    assert.deepEqual(snapshotShow(), before);
  }
}));

test('bridge-derived profile IDs and capability refresh are isolated by bridge', () => preservingShow(() => {
  const lamp = areaLamp({ id: 'same-service' });
  assert.notEqual(hueProfile(lamp, 'b1').id, hueProfile(lamp, 'b2').id);
  applyShow({ fixtures: [legacy(1, 0), { ...legacy(2, 0), output: { protocol: 'hue', bridge: 'b2', channel: 0 } }] });
  assert.deepEqual(refreshHueFixtures(state.fixtures, listProfiles(), 'b2', [lamp]).updates.map(({ id }) => id), [2]);
}));
