// The room picture's colour grade: a visualizer frame is mostly bright, pale areas, and
// painted raw the room reads white and too bright. The grade takes white out, keeps each
// colour's hue, caps the level, and caps Hue lamps lower because they mix in white LEDs.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gradeColour, PICTURE_GRADE_DEFAULTS, pictureGradeSchema } from '../../src/shared/picture-grade.ts';
import { toLch } from '../../src/shared/color.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { SettingsStore, DEFAULTS, settings } from '../../src/server/settings.ts';
import { attachRoutes } from '../../src/server/routes.ts';

const IDENTITY = { enabled: true, whiteLimit: 0, saturation: 1, ceiling: 1, hueCeiling: 1 };
const lch = ([r, g, b]) => toLch({ r, g, b });
const hueGap = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d) * 180 / Math.PI; };
const spread = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, r, g, b);
const SATURATED = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 128, 0], [128, 0, 255]];
const SAMPLE = [];
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) SAMPLE.push([r, g, b]);

test('pure white is limited, stays neutral, and the defaults darken it more than any colour', () => {
  const white = gradeColour(255, 255, 255, PICTURE_GRADE_DEFAULTS);
  assert.equal(white[0], white[1]);
  assert.equal(white[1], white[2]);
  assert.ok(white[0] <= Math.round(255 * (1 - PICTURE_GRADE_DEFAULTS.whiteLimit)), `white became ${white}`);
  assert.deepEqual(gradeColour(255, 255, 255, { ...IDENTITY, whiteLimit: 1 }), [0, 0, 0], 'all of the white out is black');
  for (const c of SATURATED) assert.ok(Math.max(...gradeColour(...c, PICTURE_GRADE_DEFAULTS)) > white[0], `${c} stays brighter than white`);
});

test('a saturated colour keeps its hue and only drops to the ceiling', () => {
  for (const c of SATURATED) {
    const out = gradeColour(...c, PICTURE_GRADE_DEFAULTS);
    assert.ok(hueGap(lch(c).h, lch(out).h) < 1, `${c} -> ${out} turned`);
    assert.ok(spread(out) > 0.95, `${c} -> ${out} lost saturation`);
    assert.equal(Math.max(...out), Math.round(255 * PICTURE_GRADE_DEFAULTS.ceiling), `${c} -> ${out}`);
  }
  assert.deepEqual(gradeColour(255, 0, 0, { ...IDENTITY, whiteLimit: 0.8 }), [255, 0, 0], 'no white in it: nothing to take out');
});

test('a pale colour turns vivid in its own hue rather than only darker', () => {
  for (const c of [[255, 224, 192], [255, 192, 255], [192, 255, 192], [64, 96, 255], [200, 220, 255]]) {
    const out = gradeColour(...c, { ...PICTURE_GRADE_DEFAULTS, ceiling: 1 });
    assert.ok(spread(out) > spread(c) + 0.1, `${c} -> ${out} is no more saturated`);
    assert.ok(hueGap(lch(c).h, lch(out).h) < 3, `${c} -> ${out} turned`);
    assert.ok(Math.max(...out) >= 0.75 * Math.max(...c), `${c} -> ${out} only darkened`);
  }
});

test('off, and the identity values, paint the picture exactly as sent', () => {
  const off = { ...PICTURE_GRADE_DEFAULTS, enabled: false };
  for (const c of SAMPLE) {
    assert.deepEqual(gradeColour(...c, off, true), c);
    assert.deepEqual(gradeColour(...c, IDENTITY), c);
    assert.deepEqual(gradeColour(...c, IDENTITY, true), c);
    assert.deepEqual(gradeColour(...c, null), c);
  }
});

test('saturation scales chroma both ways and leaves grey grey', () => {
  const c = [200, 150, 120], base = lch(gradeColour(...c, IDENTITY));
  assert.ok(lch(gradeColour(...c, { ...IDENTITY, saturation: 1.5 })).C > base.C);
  assert.ok(lch(gradeColour(...c, { ...IDENTITY, saturation: 0.5 })).C < base.C);
  const grey = gradeColour(128, 128, 128, { ...IDENTITY, saturation: 2 });
  assert.ok(Math.max(...grey) - Math.min(...grey) <= 1, `grey became ${grey}`);
});

test('the ceiling caps the highest channel and the Hue ceiling only where asked', () => {
  const grade = { ...IDENTITY, ceiling: 0.8, hueCeiling: 0.4 };
  for (const c of SAMPLE) {
    assert.ok(Math.max(...gradeColour(...c, grade)) <= 204, `${c}`);
    assert.ok(Math.max(...gradeColour(...c, grade, true)) <= 102, `${c} on a Hue lamp`);
  }
  assert.deepEqual(gradeColour(100, 50, 0, grade), [100, 50, 0], 'below the ceiling: untouched');
  assert.deepEqual(gradeColour(255, 128, 0, grade, true), [102, 51, 0], 'scaled together, so the colour holds');
});

test('the stored grade refuses values outside its ranges and unknown fields', () => {
  assert.equal(pictureGradeSchema.safeParse(PICTURE_GRADE_DEFAULTS).success, true);
  for (const bad of [{ whiteLimit: 1.1 }, { saturation: -0.1 }, { saturation: 2.5 }, { ceiling: 0 }, { hueCeiling: 1.5 }, { gamma: 2 }]) {
    assert.equal(pictureGradeSchema.safeParse({ ...PICTURE_GRADE_DEFAULTS, ...bad }).success, false, JSON.stringify(bad));
  }
});

// One RGB par and one Hue lamp (one RGB cell each), painted by the picture.
const rgbPar = { id: 'grade-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixture = (id, universe, hue) => ({ id, profileId: rgbPar.id, address: 1, universe, maxBrightness: 255, override: null, hue,
  position: { x: id * 30, y: 50 }, group: null, geometry: null, output: hue ? { protocol: 'hue' } : { protocol: 'ddp', host: '127.0.0.1' } });
const frameInput = (patch) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, universes: [1, 2], fixtures: [fixture(1, 1, false), fixture(2, 2, true)],
  picture: { leaseId: 'lease', signature: 'rig', units: 2, expiresAt: 2000, data: Uint8Array.from([255, 128, 0, 255, 128, 0]) }, ...patch,
});
function draw(patch) {
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: () => rgbPar, profilesRevision: () => 0, now: 0 });
  renderer.frame(frameInput(patch), { beatPos: 0.2, bpm: 120, epoch: 0 }, 100, store, 0);
  const read = (universe) => { const r = channelReader(universe, 1, rgbPar, (u) => store.getBuffer(u)); return [r(0), r(1), r(2)]; };
  return { par: read(1), hue: read(2) };
}

test('the renderer grades picture units, and the Hue ceiling lands only on Hue lamps', () => {
  assert.deepEqual(draw({}), { par: [255, 128, 0], hue: [255, 128, 0] }, 'no grade: the picture as sent');
  assert.deepEqual(draw({ pictureGrade: { ...IDENTITY, hueCeiling: 0.5 } }), { par: [255, 128, 0], hue: [128, 64, 0] });
  assert.deepEqual(draw({ pictureGrade: { ...IDENTITY, ceiling: 0.5 } }), { par: [128, 64, 0], hue: [255, 128, 0] });
  assert.deepEqual(draw({ pictureGrade: { ...IDENTITY, hueCeiling: 0.5, enabled: false } }), { par: [255, 128, 0], hue: [255, 128, 0] });
  const masters = draw({ pictureGrade: { ...IDENTITY, ceiling: 0.5 }, masterDimmer: 128 });
  assert.deepEqual(masters.par, [64, 32, 0], 'the master still applies after the grade');
});

test('the grade only touches the picture: an override and the effects without a picture stay as they were', () => {
  const plain = draw({ picture: null });
  assert.deepEqual(draw({ picture: null, pictureGrade: { ...PICTURE_GRADE_DEFAULTS } }), plain);
  const override = { enabled: true, blackout: false, r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const fixtures = [{ ...fixture(1, 1, false), override }, fixture(2, 2, true)];
  assert.deepEqual(draw({ fixtures, pictureGrade: { ...PICTURE_GRADE_DEFAULTS } }).par, [255, 255, 255]);
});

test('settings default to the grade, and a file from before it gains the defaults', () => {
  assert.deepEqual(DEFAULTS.picture.grade, PICTURE_GRADE_DEFAULTS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-grade-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ picture: { source: 'visualizer' } }));
  const loaded = new SettingsStore(file).load();
  assert.equal(loaded.get('picture.source'), 'visualizer');
  assert.deepEqual(loaded.get('picture.grade'), PICTURE_GRADE_DEFAULTS);
  assert.deepEqual(loaded.update({ picture: { grade: { ...PICTURE_GRADE_DEFAULTS, whiteLimit: 0.3 } } }), ['picture.grade']);
  assert.equal(new SettingsStore(file).load().get('picture.grade').whiteLimit, 0.3);
});

test('POST /api/picture/grade merges the fields it is sent and refuses a bad one', async () => {
  const saved = settings.all();
  settings.save = () => {};
  const applied = [];
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, applier: { applyChanged: (c) => applied.push(...c), pendingRestart: () => [] } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    settings._values = { ...settings.all(), picture: { source: 'visualizer', grade: { ...PICTURE_GRADE_DEFAULTS } } };
    const got = await call('GET', '/api/picture');
    assert.deepEqual(got.body.grade, PICTURE_GRADE_DEFAULTS);
    const moved = await call('POST', '/api/picture/grade', { whiteLimit: 0.25 });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.grade, { ...PICTURE_GRADE_DEFAULTS, whiteLimit: 0.25 });
    assert.deepEqual(applied, ['picture.grade']);
    const off = await call('POST', '/api/picture/grade', { enabled: false });
    assert.deepEqual(settings.get('picture.grade'), { ...PICTURE_GRADE_DEFAULTS, whiteLimit: 0.25, enabled: false });
    assert.equal(off.body.source, 'visualizer');
    for (const bad of [{ ceiling: 2 }, { tint: 1 }, { whiteLimit: 'lots' }]) {
      assert.equal((await call('POST', '/api/picture/grade', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(settings.get('picture.grade').ceiling, PICTURE_GRADE_DEFAULTS.ceiling, 'a refused patch changes nothing');
  } finally {
    await new Promise((r) => server.close(r));
    settings._values = saved;
    delete settings.save;
  }
});
