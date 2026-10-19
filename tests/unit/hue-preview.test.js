import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCellColors, fixtureCellLights, fixtureLight, fixtureOutputColor, rigLights } from '../../public-src/utils.js';
import { buildRig } from '../../src/shared/rig.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { applyShow, snapshotShow } from '../../src/server/show-store.ts';
import { state, universeOf } from '../../src/server/state.ts';
import { getProfile, listProfiles, HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID } from '../../src/server/profiles.ts';
import { hueChannelColors } from '../../src/server/output.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import * as universes from '../../src/server/universes.ts';
import { HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT } from './hue-test-lamps.js';

function withLamp(profile, fn) {
  const before = snapshotShow();
  const channels = profile.cells ? profile.cells.map((_, i) => 12 - i) : [12];
  try {
    applyShow({ profiles: [profile], fixtures: [{ id: 9, label: 'Preview lamp', profileId: profile.id, output: { protocol: 'hue', bridge: 'preview', channels } }] });
    const fix = state.fixtures[0];
    const buffer = universes.getBuffer(universeOf(fix));
    buffer.fill(0);
    const ui = { profiles: listProfiles(), masterDimmer: 255, masterBlackout: false, dmxSnapshot: { [universeOf(fix)]: buffer } };
    const sections = profile.cells ? profile.cells.map((cell) => cell.channelMap) : [profile.channelMap];
    const set = (values, section = 0) => {
      for (const [name, value] of Object.entries(values)) {
        const offset = sections[section][name];
        assert.notEqual(offset, undefined, `${name} exists in section ${section}`);
        buffer[fix.address - 1 + offset] = value;
      }
    };
    fn({ fix, ui, set, sections });
  } finally {
    applyShow(before);
  }
}

function assertParity(fix, ui) {
  const sent = hueChannelColors().get('preview');
  const expected = sent.map(({ r, g, b }) => ({ r, g, b, w: 0, a: 0, uv: 0 }));
  const lights = fixtureCellLights(fix, ui) || [fixtureLight(fix, ui)];
  assert.deepEqual(lights, expected, 'stage lights match each ordered channel sent to the bridge');
  const rig = buildRig([fix], getProfile);
  assert.deepEqual(rigLights([fix], ui, ui.dmxSnapshot, rig), expected);
  return sent;
}

test('generated Hue RGB preview keeps rendered brightness instead of applying dimmer twice', () => withLamp(HUE_COLOR, ({ fix, ui, set }) => {
  set({ red: 128, green: 64, blue: 32, dimmer: 128 });
  assert.deepEqual(assertParity(fix, ui), [{ id: 12, r: 128, g: 64, b: 32 }]);
  assert.equal(fixtureOutputColor(fix, ui), 'rgb(128,64,32)');
}));

test('generated fixed-white Hue preview uses its dimmer and discovered white temperature', () => withLamp(HUE_WHITE, ({ fix, ui, set }) => {
  set({ dimmer: 128 });
  const [light] = assertParity(fix, ui);
  assert.equal(light.r, 128);
  assert.ok(light.r > light.g && light.g > light.b && light.b > 0);
  assert.equal(fixtureOutputColor(fix, ui), `rgb(${light.r},${light.g},${light.b})`);
}));

test('generated tunable-white Hue preview shows warm and cool emitters at their rendered levels', () => withLamp(HUE_AMBIANCE, ({ fix, ui, set }) => {
  set({ dimmer: 128, warmWhite: 128, coolWhite: 0 });
  const [warm] = assertParity(fix, ui);
  assert.equal(warm.r, 128);
  assert.ok(warm.r > warm.g && warm.g > warm.b);
  set({ warmWhite: 0, coolWhite: 128 });
  const [cool] = assertParity(fix, ui);
  assert.equal(cool.r, 128);
  assert.ok(cool.b > warm.b && cool.g > warm.g);
}));

test('gradient preview preserves ordered sections, white conversion and individual brightness', () => withLamp(HUE_GRADIENT, ({ fix, ui, set }) => {
  set({ red: 96, dimmer: 96 }, 0);
  set({ blue: 128, dimmer: 128 }, 1);
  set({ warmWhite: 64, dimmer: 64 }, 2);
  set({ coolWhite: 32, dimmer: 32 }, 3);
  set({ uv: 200, dimmer: 200 }, 4);
  const lights = assertParity(fix, ui);
  assert.deepEqual(lights.map(({ id }) => id), [12, 11, 10, 9, 8]);
  assert.deepEqual(lights.slice(0, 2), [{ id: 12, r: 96, g: 0, b: 0 }, { id: 11, r: 0, g: 0, b: 128 }]);
  assert.equal(lights[2].r, 64);
  assert.equal(lights[3].r, 32);
  assert.deepEqual(lights[4], { id: 8, r: 90, g: 0, b: 170 });
  assert.deepEqual(fixtureCellColors(fix, ui), lights.map(({ r, g, b }) => `rgb(${r},${g},${b})`));
}));

test('legacy Hue previews retain historical output white mixes and neutral fixed-white output', () => {
  withLamp(listProfiles()[HUE_COLOR_PROFILE_ID], ({ fix, ui, set }) => {
    set({ red: 255, warmWhite: 255, dimmer: 128 });
    assert.deepEqual(assertParity(fix, ui), [{ id: 12, r: 255, g: 84, b: 43 }]);
  });
  withLamp(listProfiles()[HUE_WHITE_PROFILE_ID], ({ fix, ui, set }) => {
    set({ dimmer: 140 });
    assert.deepEqual(assertParity(fix, ui), [{ id: 12, r: 140, g: 140, b: 140 }]);
  });
});

for (const profile of [HUE_COLOR, HUE_WHITE, HUE_AMBIANCE, HUE_GRADIENT]) {
  test(`${profile.modeName} override preview reads the rendered master and fixture limits`, () => withLamp(profile, ({ fix, ui }) => {
    fix.maxBrightness = 128;
    fix.override = { enabled: true, r: 255, g: 0, b: 0, w: 255, a: 0, uv: 0, dim: 128, blackout: false };
    ui.masterDimmer = 128;
    const renderer = createRenderer({ profileOf: getProfile, now: 0 });
    const input = {
      running: true, pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, beatDivision: 1,
      split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: ui.masterDimmer,
      masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
      fixtures: [{ ...fix, hue: true }], universes: [universeOf(fix)],
    };
    renderer.frame(input, { beatPos: 0, bpm: 120, epoch: 0 }, 0, universes);
    const lights = assertParity(fix, ui);
    assert.ok(lights.every(({ r, g, b }) => Math.max(r, g, b) > 0 && Math.max(r, g, b) <= 65), 'master, trim and override dim all limit output');
    const first = lights[0];
    assert.equal(fixtureOutputColor(fix, ui), `rgb(${first.r},${first.g},${first.b})`, 'the fixture swatch uses the converted frame too');
    assert.notEqual(fixtureOutputColor(fix, ui), 'rgb(64,32,32)', 'raw RGBW override colour is not a substitute for the rendered Hue frame');
    renderer.frame({ ...input, masterBlackout: true }, { beatPos: 0.05, bpm: 120, epoch: 0 }, 25, universes);
    ui.masterBlackout = true;
    assert.ok(assertParity(fix, ui).every(({ r, g, b }) => r + g + b === 0));
  }));
}

for (const hardware of [undefined, { technologies: {}, products: {} }]) {
  for (const profile of [HUE_COLOR, HUE_WHITE, HUE_AMBIANCE, HUE_GRADIENT]) {
    test(`${profile.modeName} ${hardware ? 'stepped' : 'legacy'} rehearsal matches Hue output frame by frame`, () => withLamp(profile, ({ fix, ui }) => {
      fix.maxBrightness = 96;
      const look = { pattern: profile.cells ? 'gradient' : 'fade', colorA: 9, colorB: 10, colorC: 1, colorD: 0, bpm: 120, beatDivision: 1 };
      const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: look }], null, { profiles: ui.profiles, hardware });
      const renderer = createRenderer({ profileOf: getProfile, now: 0 });
      const fixtures = [{ ...fix, hue: true }];
      const rig = buildRig(fixtures, getProfile);
      let lit = false;
      for (let ms = 0; ms <= 500; ms += 25) {
        renderer.frame({
          ...look, hardware, fixtures, universes: [universeOf(fix)], running: true,
          split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255,
          masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
        }, { beatPos: ms / 500, bpm: 120, epoch: 0 }, ms, universes);
        const actual = hueChannelColors().get('preview').map(({ r, g, b }) => ({ r, g, b, w: 0, a: 0, uv: 0 }));
        assert.deepEqual(sample(ms, fixtures, COLOR_PRESETS, rig), actual, `rendered Hue frame at ${ms} ms`);
        if (actual.some(({ r, g, b }) => r + g + b > 0)) lit = true;
      }
      assert.ok(lit, 'the test exercises visible emitted light');
    }));
  }
}
