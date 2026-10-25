// What a light throws when nobody has chosen its shape: a par a beam, a bar
// its cells, a Hue lamp a bulb, unless its bridge says the lamp is a spot, a
// pendant, a ceiling fitting or a wall lantern. A chosen shape always wins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { emissionOf, hueEmission, beamDirection } from '../../src/shared/emission.ts';
import { hueProfile } from '../../src/server/hue-profile.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { roomRig } from '../../public-src/stage3d/world.js';
import { areaLamp } from './hue-test-lamps.js';

const light = (archetype, product = 'Hue color lamp') => ({ archetype, product });
// A lamp as the import patches it: the profile carries each of its lights.
const lamp = (lights, extra = {}) => {
  const profile = hueProfile({ ...areaLamp({ id: 'lamp', ...extra }), lights });
  return { profile, fixture: { id: 1, label: 'Lamp', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: profile.cells ? [0, 1, 2] : [0] } } };
};
const shape = (lights, fields = {}) => { const { profile, fixture } = lamp(lights); return emissionOf({ ...fixture, ...fields }, profile); };
const SPOT = { kind: 'beam', beamAngle: 36, tilt: -90 };

test('spot fittings and spot bulbs throw a 36 degree beam straight down', () => {
  for (const archetype of ['spot_bulb', 'single_spot', 'double_spot', 'triple_spot', 'recessed_ceiling', 'pendant_spot']) {
    assert.deepEqual(shape([light(archetype)]), SPOT, archetype);
  }
});

test('a GU10 or a product named a spot is a spot, whatever fitting the app was told', () => {
  for (const [archetype, product] of [[null, 'Hue White and Color Ambiance GU10'], ['classic_bulb', 'Hue color spot'],
    ['pendant_round', 'Hue white ambiance GU10']]) {
    assert.deepEqual(shape([light(archetype, product)]), SPOT, product);
  }
});

test('three spots combined on one channel stay one fixture with one beam, wide enough to read as one patch', () => {
  const three = [light('spot_bulb', 'Hue GU10'), light('spot_bulb', 'Hue GU10'), light('spot_bulb', 'Hue GU10')];
  const { profile, fixture } = lamp(three);
  assert.deepEqual(emissionOf(fixture, profile), { kind: 'beam', beamAngle: 55, tilt: -90 });
  assert.deepEqual(shape([light('classic_bulb'), light(null, 'Hue GU10')]), { kind: 'beam', beamAngle: 55, tilt: -90 }, 'one spot among them is enough');
  const rig = buildRig([fixture], () => profile);
  const room = { bounds: { width: 4, depth: 4, height: 2.6 }, objects: [], bindings: [{ id: 'spots', fixtureId: 1, unit: 0, position: { x: 0, y: 2.5, z: 0 } }] };
  const { lamps, cells } = roomRig([fixture], rig, room, { [profile.id]: profile });
  assert.deepEqual([lamps.length, cells.length, lamps[0].kind], [1, 0, 'par'], 'one beam in an imported room');
  assert.ok(Math.abs(lamps[0].length - 2.5) < 1e-9 && lamps[0].pool.normal.y === 1, 'straight down to its pool on the floor');
});

test('pendants and ceiling fittings with ordinary bulbs throw a wide soft pool down', () => {
  for (const archetype of ['pendant_round', 'pendant_long', 'ceiling_round', 'ceiling_square', 'ceiling_horizontal', 'ceiling_tube']) {
    assert.deepEqual(shape([light(archetype, 'Hue white ambiance E27')]), { kind: 'beam', beamAngle: 120, tilt: -90 }, archetype);
  }
});

test('wall lanterns and washers throw a level 90 degree beam at the default pan', () => {
  for (const archetype of ['wall_lantern', 'wall_washer']) {
    const emission = shape([light(archetype)]);
    assert.deepEqual(emission, { kind: 'beam', beamAngle: 90, tilt: 0 }, archetype);
    assert.equal(beamDirection(emission).y, 0, 'level');
  }
});

test('shades, candles, Go, Iris, Play, strips and lamps imported before archetypes keep their bulb', () => {
  for (const archetype of ['sultan_bulb', 'candle_bulb', 'classic_bulb', 'floor_shade', 'table_shade', 'hue_go', 'hue_iris',
    'hue_play', 'hue_lightstrip', null]) {
    assert.deepEqual(shape([light(archetype)]), { kind: 'bulb' }, String(archetype));
  }
  assert.deepEqual(shape(undefined), { kind: 'bulb' }, 'a profile without its lights');
  const strip = lamp([light('spot_bulb', 'Hue gradient spot')], { channels: [0, 1, 2] });
  assert.deepEqual(emissionOf(strip.fixture, strip.profile), { kind: 'strip' }, 'a lamp of several sections stays a strip');
  assert.equal(hueEmission(strip.fixture, strip.profile), null);
});

test('a spot in the floor group keeps the floor aim and takes only its spread', () => {
  const emission = shape([light('spot_bulb')], { group: 'floor' });
  assert.deepEqual(emission, { kind: 'beam', beamAngle: 36 });
  assert.ok(beamDirection(emission, true).y > 0.9, 'up from the floor');
  assert.deepEqual(shape([light('spot_bulb')], { group: 'room' }), SPOT, 'the room group is no exception');
});

test('a chosen shape always wins, and a par that is not Hue is unchanged', () => {
  const { profile, fixture } = lamp([light('spot_bulb')]);
  for (const chosen of [{ kind: 'bulb' }, { kind: 'beam', pan: 10, tilt: 5, beamAngle: 12 }, { kind: 'strip' }]) {
    assert.equal(emissionOf({ ...fixture, emission: chosen }, profile), chosen, chosen.kind);
    assert.equal(hueEmission({ ...fixture, emission: chosen }, profile), null);
  }
  const par = { id: 2, label: 'Par', profileId: 'par' }, parProfile = { id: 'par', channelMap: { red: 0 } };
  assert.deepEqual(emissionOf(par, parProfile), { kind: 'beam' });
  assert.deepEqual(emissionOf({ ...par, group: 'room' }, parProfile), { kind: 'bulb' });
  assert.equal(hueEmission(par, parProfile), null);
});
