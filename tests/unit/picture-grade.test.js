// The room picture's black point, which keeps a screen's near-black pixels from lighting a lamp,
// and its optional colour grade, off by default: it takes white out, keeps each colour's hue,
// caps the level, and can cap Hue lamps lower because they mix in white LEDs.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blackPointGain, gradeColour, pictureLift, PICTURE_BLACK_POINT_DEFAULT, PICTURE_GRADE_DEFAULTS, PICTURE_GRADE_GUESSED,
  pictureBlackPointSchema, pictureGradeSchema } from '../../src/shared/picture-grade.ts';
import { SRGB_DECODE, toLch } from '../../src/shared/color.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { SettingsStore, DEFAULTS, schema, settings, retireGuessedGrade } from '../../src/server/settings.ts';
import { attachRoutes } from '../../src/server/routes.ts';

const IDENTITY = { enabled: true, whiteLimit: 0, saturation: 1, ceiling: 1, hueCeiling: 1 };
const TASTE = { enabled: true, whiteLimit: 0.6, saturation: 1.25, ceiling: 0.7, hueCeiling: 0.5 };
const lch = ([r, g, b]) => toLch({ r, g, b });
const hueGap = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d) * 180 / Math.PI; };
const spread = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, r, g, b);
const SATURATED = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 128, 0], [128, 0, 255]];
const SAMPLE = [];
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) SAMPLE.push([r, g, b]);

test('pure white is limited, stays neutral, and a strong grade darkens it more than any colour', () => {
  const white = gradeColour(255, 255, 255, TASTE);
  assert.equal(white[0], white[1]);
  assert.equal(white[1], white[2]);
  assert.ok(white[0] <= Math.round(255 * (1 - TASTE.whiteLimit)), `white became ${white}`);
  assert.deepEqual(gradeColour(255, 255, 255, { ...IDENTITY, whiteLimit: 1 }), [0, 0, 0], 'all of the white out is black');
  for (const c of SATURATED) assert.ok(Math.max(...gradeColour(...c, TASTE)) > white[0], `${c} stays brighter than white`);
});

test('a saturated colour keeps its hue and only drops to the ceiling', () => {
  for (const c of SATURATED) {
    const out = gradeColour(...c, TASTE);
    assert.ok(hueGap(lch(c).h, lch(out).h) < 1, `${c} -> ${out} turned`);
    assert.ok(spread(out) > 0.95, `${c} -> ${out} lost saturation`);
    assert.equal(Math.max(...out), Math.round(255 * TASTE.ceiling), `${c} -> ${out}`);
  }
  assert.deepEqual(gradeColour(255, 0, 0, { ...IDENTITY, whiteLimit: 0.8 }), [255, 0, 0], 'no white in it: nothing to take out');
});

test('a pale colour turns vivid in its own hue rather than only darker', () => {
  for (const c of [[255, 224, 192], [255, 192, 255], [192, 255, 192], [64, 96, 255], [200, 220, 255]]) {
    const out = gradeColour(...c, { ...TASTE, ceiling: 1 });
    assert.ok(spread(out) > spread(c) + 0.1, `${c} -> ${out} is no more saturated`);
    assert.ok(hueGap(lch(c).h, lch(out).h) < 3, `${c} -> ${out} turned`);
    assert.ok(Math.max(...out) >= 0.75 * Math.max(...c), `${c} -> ${out} only darkened`);
  }
});

test('off, the defaults, and the identity values leave every colour as it is', () => {
  const off = { ...TASTE, enabled: false };
  for (const c of SAMPLE) {
    assert.deepEqual(gradeColour(...c, off, true), c);
    assert.deepEqual(gradeColour(...c, IDENTITY), c);
    assert.deepEqual(gradeColour(...c, IDENTITY, true), c);
    assert.deepEqual(gradeColour(...c, null), c);
    assert.deepEqual(gradeColour(...c, PICTURE_GRADE_DEFAULTS, true), c);
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

test('the black point turns a unit off at and below it, ramps it above, and leaves a full peak at 255', () => {
  for (const blackPoint of [0.01, 0.1, 0.12, 0.2, 0.25, 0.3, 0.4, 0.5]) {
    const threshold = Math.floor(blackPoint * 255);
    for (let v = 0; v <= threshold; v++) assert.equal(blackPointGain(v, blackPoint), 0, `${v} at ${blackPoint}`);
    assert.ok(blackPointGain(threshold + 1, blackPoint) > 0, `${threshold + 1} lights at ${blackPoint}`);
    assert.equal(blackPointGain(255, blackPoint), 1, `255 stays 255 at ${blackPoint}`);
    let last = 0;
    for (let v = threshold + 1; v <= 255; v++) {
      const m = v / 255, gain = blackPointGain(v, blackPoint), spec = ((m - blackPoint) / (1 - blackPoint)) / m;
      assert.ok(Math.abs(gain - spec) < 1e-12 && gain > last && gain <= 1, `${v} at ${blackPoint}: ${gain}`);
      last = gain;
    }
  }
  for (let v = 0; v < 256; v++) assert.equal(v * blackPointGain(v, 0), v, `zero is the identity at ${v}`);
  // (204, 102, 0) at 0.2: the peak is 0.8 of full, so every channel takes 0.9375 and the hue holds.
  const gain = blackPointGain(204, 0.2);
  assert.deepEqual([204, 102, 0].map((v) => Math.round(v * gain)), [191, 96, 0]);
  for (const c of [[200, 120, 60], [30, 200, 90], [255, 40, 160], [64, 32, 0]]) {
    const out = c.map((v) => v * blackPointGain(Math.max(...c), PICTURE_BLACK_POINT_DEFAULT));
    assert.ok(hueGap(lch(c).h, lch(out).h) < 1e-6, `${c} -> ${out} turned`);
    assert.ok(Math.abs(out[1] * c[0] - out[0] * c[1]) < 1e-9 && Math.abs(out[2] * c[0] - out[0] * c[2]) < 1e-9, `${c} -> ${out} lost its ratios`);
    if (Math.max(...c) === 255) assert.deepEqual(out, c, 'a full peak keeps every channel');
    else assert.ok(Math.max(...out) < Math.max(...c), `${c} -> ${out} did not ramp down`);
  }
  assert.deepEqual([64, 32, 0].map((v) => Math.round(v * blackPointGain(64, 0.12))), [38, 19, 0]);
});

test('the lift tables hold the gain at every peak byte, decoded first when asked', () => {
  const plain = pictureLift(false, 0.2), decoded = pictureLift(true, 0.2);
  assert.deepEqual([plain.decode, plain.blackPoint, decoded.decode, decoded.blackPoint], [false, 0.2, true, 0.2]);
  for (let v = 0; v < 256; v++) {
    assert.equal(plain.levels[v], v);
    assert.equal(plain.gains[v], blackPointGain(v, 0.2));
    assert.equal(decoded.levels[v], SRGB_DECODE[v]);
    assert.equal(decoded.gains[v], blackPointGain(SRGB_DECODE[v], 0.2));
  }
  assert.deepEqual([plain.gains[51], plain.gains[255], decoded.gains[255]], [0, 1, 1]);
  assert.ok(decoded.gains[123] === 0 && decoded.gains[124] > 0, 'sRGB 124 is the first byte above 20 % light');
  const off = pictureLift(false, 0);
  for (let v = 0; v < 256; v++) assert.equal(off.levels[v] * off.gains[v], v, `no lift at ${v}`);
});

test('the stored black point and decode refuse values outside their ranges', () => {
  assert.equal(DEFAULTS.picture.decode, false);
  assert.equal(DEFAULTS.picture.blackPoint, PICTURE_BLACK_POINT_DEFAULT);
  assert.equal(PICTURE_BLACK_POINT_DEFAULT, 0.12);
  for (const good of [0, 0.12, 0.5]) assert.equal(pictureBlackPointSchema.safeParse(good).success, true, String(good));
  for (const bad of [-0.01, 0.51, 1, '0.1', null]) assert.equal(pictureBlackPointSchema.safeParse(bad).success, false, String(bad));
  const picture = schema.shape.picture;
  assert.equal(picture.safeParse({ ...DEFAULTS.picture, decode: true, blackPoint: 0.3 }).success, true);
  for (const bad of [{ decode: 'yes' }, { decode: 1 }, { blackPoint: 0.6 }, { blackPoint: -1 }, { blackPoint: '0.2' }, { lift: 1 }]) {
    assert.equal(picture.safeParse({ ...DEFAULTS.picture, ...bad }).success, false, JSON.stringify(bad));
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
  assert.deepEqual(draw({}), { par: [255, 128, 0], hue: [255, 128, 0] }, 'no grade, no lift: the picture as sent');
  // With the decode on, sRGB (255, 128, 0) is (255, 55.0, 0) before the grade sees it.
  const decoded = { pictureDecode: true };
  assert.deepEqual(draw(decoded), { par: [255, 55, 0], hue: [255, 55, 0] }, 'no grade: the decoded picture');
  assert.deepEqual(draw({ ...decoded, pictureGrade: { ...IDENTITY, hueCeiling: 0.5 } }), { par: [255, 55, 0], hue: [128, 28, 0] });
  assert.deepEqual(draw({ ...decoded, pictureGrade: { ...IDENTITY, ceiling: 0.5 } }), { par: [128, 28, 0], hue: [255, 55, 0] });
  assert.deepEqual(draw({ ...decoded, pictureGrade: { ...IDENTITY, hueCeiling: 0.5, enabled: false } }), { par: [255, 55, 0], hue: [255, 55, 0] });
  const masters = draw({ ...decoded, pictureGrade: { ...IDENTITY, ceiling: 0.5 }, masterDimmer: 128 });
  assert.deepEqual(masters.par, [64, 14, 0], 'the master still applies after the grade');
});

test('the black point lifts the picture before the grade, grade on or off, on pars and Hue lamps alike', () => {
  const picture = (bytes) => ({ leaseId: 'lease', signature: 'rig', units: 2, expiresAt: 2000, data: Uint8Array.from([...bytes, ...bytes]) });
  // (204, 102, 0) at 0.2: the peak is 0.8 of full, so every channel takes 0.9375.
  assert.deepEqual(draw({ picture: picture([204, 102, 0]), pictureBlackPoint: 0.2 }), { par: [191, 96, 0], hue: [191, 96, 0] });
  assert.deepEqual(draw({ picture: picture([204, 102, 0]), pictureBlackPoint: 0.2, pictureGrade: { ...TASTE, enabled: false } }).par, [191, 96, 0]);
  assert.deepEqual(draw({ picture: picture([204, 102, 0]), pictureBlackPoint: 0.2, pictureGrade: { ...IDENTITY, ceiling: 0.25 } }).par, [64, 32, 0],
    'the ceiling scales the lifted colour');
  for (const bytes of [[51, 25, 0], [0, 0, 0], [40, 51, 51]]) {
    assert.deepEqual(draw({ picture: picture(bytes), pictureBlackPoint: 0.2 }), { par: [0, 0, 0], hue: [0, 0, 0] }, `${bytes} is at or under the black point`);
    assert.deepEqual(draw({ picture: picture(bytes), pictureBlackPoint: 0.2, pictureGrade: TASTE }).par, [0, 0, 0], `${bytes} stays off through the grade`);
  }
  assert.deepEqual(draw({ picture: picture([51, 25, 0]), pictureBlackPoint: 0 }).par, [51, 25, 0], 'a black point of zero lights every byte as sent');
  assert.deepEqual(draw({ pictureBlackPoint: 0.5 }).par, [255, 128, 0], 'a full peak is never lifted');
  // Decoded first: sRGB (204, 102, 0) is (153.0, 13.3, 0) in light, and 0.6 of full gets 0.8333 at 0.2.
  const decoded = draw({ picture: picture([204, 102, 0]), pictureBlackPoint: 0.2, pictureDecode: true });
  const gain = blackPointGain(SRGB_DECODE[204], 0.2);
  assert.deepEqual(decoded.par, [204, 102, 0].map((v) => Math.round(SRGB_DECODE[v] * gain)));
  assert.ok(decoded.par[0] < 153 && decoded.par[0] > 120, `${decoded.par}`);
});

test('the grade only touches the picture: an override and the effects without a picture stay as they were', () => {
  const plain = draw({ picture: null });
  assert.deepEqual(draw({ picture: null, pictureGrade: TASTE }), plain);
  const override = { enabled: true, blackout: false, r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const fixtures = [{ ...fixture(1, 1, false), override }, fixture(2, 2, true)];
  assert.deepEqual(draw({ fixtures, pictureGrade: TASTE }).par, [255, 255, 255]);
});

test('settings default to the grade off, and a file from before it gains the defaults', () => {
  assert.deepEqual(DEFAULTS.picture.grade, PICTURE_GRADE_DEFAULTS);
  assert.deepEqual(PICTURE_GRADE_DEFAULTS, { ...IDENTITY, enabled: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-grade-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ picture: { source: 'visualizer' } }));
  const loaded = new SettingsStore(file).load();
  assert.equal(loaded.get('picture.source'), 'visualizer');
  assert.deepEqual(loaded.get('picture.grade'), PICTURE_GRADE_DEFAULTS);
  assert.deepEqual([loaded.get('picture.decode'), loaded.get('picture.blackPoint')], [false, 0.12], 'the lift defaults');
  assert.deepEqual(loaded.update({ picture: { grade: { ...PICTURE_GRADE_DEFAULTS, whiteLimit: 0.3 } } }), ['picture.grade']);
  assert.equal(new SettingsStore(file).load().get('picture.grade').whiteLimit, 0.3);
  assert.deepEqual(loaded.update({ picture: { decode: true, blackPoint: 0.3 } }), ['picture.decode', 'picture.blackPoint']);
  const again = new SettingsStore(file).load();
  assert.deepEqual([again.get('picture.decode'), again.get('picture.blackPoint'), again.get('picture.source')], [true, 0.3, 'visualizer']);
  assert.throws(() => loaded.update({ picture: { blackPoint: 0.6 } }));
  assert.throws(() => loaded.update({ picture: { decode: 'on' } }));
  assert.equal(loaded.get('picture.blackPoint'), 0.3, 'a refused patch changes nothing');
});

test('a stored copy of the first, guessed defaults loads with the grade off; a tuned grade is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-grade-'));
  const load = (grade) => {
    const file = path.join(dir, `settings-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ picture: { source: 'visualizer', grade } }));
    return new SettingsStore(file).load();
  };
  const reordered = Object.fromEntries(Object.entries(PICTURE_GRADE_GUESSED).reverse());
  assert.deepEqual(load(reordered).get('picture.grade'), PICTURE_GRADE_DEFAULTS);
  assert.equal(load(reordered).get('picture.source'), 'visualizer');
  const tuned = { ...PICTURE_GRADE_GUESSED, whiteLimit: 0.5 };
  assert.deepEqual(load(tuned).get('picture.grade'), tuned);
  assert.deepEqual(load({ ...PICTURE_GRADE_GUESSED, enabled: false }).get('picture.grade'), { ...PICTURE_GRADE_GUESSED, enabled: false });
  assert.equal(retireGuessedGrade({ artnet: {} }), false);
  assert.equal(retireGuessedGrade(null), false);
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
    settings._values = { ...settings.all(), picture: { ...DEFAULTS.picture, source: 'visualizer', grade: { ...PICTURE_GRADE_DEFAULTS } } };
    const got = await call('GET', '/api/picture');
    assert.deepEqual(got.body.grade, PICTURE_GRADE_DEFAULTS);
    assert.deepEqual([got.body.decode, got.body.blackPoint], [false, 0.12], 'the lift is reported with the grade');
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
