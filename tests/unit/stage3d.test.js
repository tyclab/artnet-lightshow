// The 3D stage's half that has nothing to do with three.js: where each light
// of the rig hangs in the room, which way it points, how far its beam runs, and
// what colour of light a frame's emitter values make — and the live frame the
// Stage view reads out of the DMX feed, one set of emitters per light.

import test from 'node:test';
import assert from 'node:assert/strict';
// ES modules like the server, imported as they are; they read the plan
// through src/shared/stage.ts and src/shared/rig.ts.
import * as world from '../../public-src/stage3d/world.js';
import { rigLights, fixtureLight } from '../../public-src/utils.js';
import { buildRig } from '../../src/shared/rig.ts';
import { BoxGeometry, Matrix4, Mesh, PlaneGeometry, Raycaster, Vector3 } from 'three';

const PAR = { id: 'par', manufacturer: 'Test', channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const HUE = { id: 'generic-hue-lamp-7ch', manufacturer: 'Philips Hue', channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const BAR = {
  id: 'bar', manufacturer: 'Test', channelMap: { dimmer: 0 },
  cells: Array.from({ length: 4 }, (_, c) => ({ channelMap: { red: 1 + 3 * c, green: 2 + 3 * c, blue: 3 + 3 * c } })),
};
const PANEL = {
  id: 'panel', manufacturer: 'Test', channelMap: {},
  grid: { columns: 3, rows: 2 },
  cells: Array.from({ length: 6 }, (_, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 }, at: { x: c % 3, y: Math.floor(c / 3) } })),
};
const PROFILES = { par: PAR, 'generic-hue-lamp-7ch': HUE, bar: BAR, panel: PANEL };

const fixture = (id, profileId, extra = {}) => ({ id, label: `F${id}`, address: 1 + id * 20, universe: 0, profileId, ...extra });
const placed = (fixtures) => {
  const rig = buildRig(fixtures, (f) => PROFILES[f.profileId] || null);
  return { rig, room: world.placeRig(fixtures, PROFILES, rig) };
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not ${expected}`);
const nearVec = (actual, expected, message) => { for (const axis of ['x', 'y', 'z']) near(actual[axis], expected[axis], `${message} (${axis})`); };

test('the plan is the stage from above: its corners, its centre', () => {
  assert.deepEqual(world.planToWorld({ x: 50, y: 50 }), { x: 0, z: 0 });
  assert.deepEqual(world.planToWorld({ x: 0, y: 0 }), { x: -world.STAGE_W / 2, z: -world.STAGE_D / 2 }, 'back of the stage, stage left');
  assert.deepEqual(world.planToWorld({ x: 100, y: 100 }), { x: world.STAGE_W / 2, z: world.STAGE_D / 2 }, 'the front edge, by the audience');
});

test('truss pars aim down toward the stage and audience', () => {
  const { room } = placed([fixture(0, 'par', { position: { x: 25, y: 20 }, group: 'front' })]);
  assert.equal(room.lamps.length, 1);
  assert.equal(room.cells.length, 0);
  const [par] = room.lamps;
  assert.equal(par.kind, 'par');
  assert.equal(par.unit, 0);
  assert.deepEqual(par.position, { x: -3, y: world.TRUSS_H, z: -2.4 });
  assert.ok(par.aim.y < 0 && par.aim.z > 0, 'down, and out front');
  near(Math.hypot(par.aim.x, par.aim.y, par.aim.z), 1, 'the aim is a direction');
  near(par.end.y, 0, 'the beam runs to the floor');
  near(par.radius, Math.tan(world.BEAM_HALF_ANGLE) * par.length, 'and spreads with its length');
  assert.equal(room.trusses.length, 1, 'something to hang it from');
  assert.equal(room.trusses[0].y, world.TRUSS_H + 0.2);
});

test('floor fixtures aim upward while room and Hue fixtures use bulbs', () => {
  const { room } = placed([
    fixture(0, 'par', { position: { x: 50, y: 80 }, group: 'floor' }),
    fixture(1, 'par', { position: { x: 5, y: 95 }, group: 'room' }),
    fixture(2, 'generic-hue-lamp-7ch', { position: { x: 50, y: 20 }, group: 'front' }),
  ]);
  const [floor, room1, hue] = room.lamps;
  assert.equal(floor.kind, 'par');
  assert.equal(floor.position.y, world.FLOOR_H);
  assert.ok(floor.aim.y > 0.9, 'up');
  assert.ok(floor.end.y > world.TRUSS_H, 'past the truss');
  assert.equal(room1.kind, 'bulb');
  assert.equal(room1.position.y, world.ROOM_H);
  assert.equal(room1.aim, null);
  assert.equal(hue.kind, 'bulb', 'a Hue lamp has no beam, even on the truss');
  assert.equal(room.trusses.length, 0, 'nothing is hung, so no truss');
});

test('a bar\'s cells hang in a line, first to last, in the rig\'s unit order', () => {
  const { rig, room } = placed([
    fixture(0, 'par', { position: { x: 10, y: 20 } }),
    fixture(1, 'bar', { position: { x: 50, y: 10 }, geometry: { length: 40, angle: 0 } }),
  ]);
  assert.equal(room.cells.length, 4);
  assert.deepEqual(room.cells.map((c) => c.unit), [1, 2, 3, 4]);
  assert.ok(room.cells.every((c) => c.fixture === 1 && c.position.y === world.TRUSS_H));
  const xs = room.cells.map((c) => c.position.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'stage left to stage right');
  room.cells.forEach((c, k) => {
    const at = world.planToWorld(rig.points[c.unit]);
    near(c.position.x, at.x, `cell ${k} across`);
    near(c.position.z, at.z, `cell ${k} deep`);
  });
  // The par 0.8 m in front of the bar hangs from a truss of its own.
  assert.equal(room.trusses.length, 2);
});

test('a panel stands upright: columns across, rows down from the truss', () => {
  const { room } = placed([fixture(0, 'panel', { position: { x: 50, y: 50 }, geometry: { length: 30, angle: 0 } })]);
  assert.equal(room.cells.length, 6);
  const [a, b, c, d] = room.cells;
  near(a.position.y, b.position.y, 'a row is level');
  assert.ok(d.position.y < a.position.y, 'the second row is below the first');
  assert.ok(a.position.x < b.position.x && b.position.x < c.position.x, 'columns run across');
  near(a.position.x, d.position.x, 'a column is plumb');
  near(b.position.x, 0, 'centred on its place');
  assert.ok(a.position.y < world.TRUSS_H, 'it hangs below the truss');
  near(a.size, (0.3 * world.STAGE_W) / 3, 'square cells across its width');
});

test('every light of a mixed rig is placed exactly once', () => {
  const fixtures = [
    fixture(0, 'par', { position: { x: 20, y: 20 } }),
    fixture(1, 'bar'),
    fixture(2, 'panel'),
    fixture(3, 'generic-hue-lamp-7ch', { group: 'room' }),
    fixture(4, 'par', { group: 'floor' }),
  ];
  const { rig, room } = placed(fixtures);
  const units = [...room.lamps, ...room.cells].map((l) => l.unit).sort((a, b) => a - b);
  assert.deepEqual(units, rig.units.map((_, u) => u));
  for (const light of [...room.lamps, ...room.cells]) {
    for (const v of Object.values(light.position)) assert.ok(Number.isFinite(v), `unit ${light.unit} is somewhere`);
  }
});

test('trusses: a row per line of hung fixtures, across their span', () => {
  assert.deepEqual(world.trussesFor([]), []);
  const one = world.trussesFor([{ x: -2, z: 1 }, { x: 3, z: 1.2 }, { x: 0, z: 0.9 }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].from, -2.5);
  assert.equal(one[0].to, 3.5);
  near(one[0].z, (1 + 1.2 + 0.9) / 3, 'through the middle of the row');
  const two = world.trussesFor([{ x: 0, z: -3 }, { x: 1, z: 1 }]);
  assert.deepEqual(two.map((t) => t.z), [-3, 1], 'back to front');
});

test('stage lights mix channels and scale overbright colours together', () => {
  const out = new Float32Array(6);
  assert.equal(world.lightRGB(null, out), 0);
  assert.deepEqual([...out.slice(0, 3)], [0, 0, 0]);
  assert.equal(world.lightRGB({ r: 255, g: 0, b: 0 }, out, 3), 1);
  assert.deepEqual([...out.slice(3)], [1, 0, 0], 'written where it was asked for');
  world.lightRGB({ r: 128, g: 0, b: 0 }, out);
  near(out[0], ((128 / 255 + 0.055) / 1.055) ** 2.4, 'half on is a linear quarter or so');
  assert.ok(world.lightRGB({ r: 128 }, out) < 1);
  // Red and white at full: red wins, the hue kept, nothing past 1.
  world.lightRGB({ r: 255, w: 255 }, out);
  assert.equal(out[0], 1);
  near(out[1], out[2], 'white adds to green and blue alike');
  assert.ok(out[1] > 0 && out[1] < 1);
  world.lightRGB({ a: 255 }, out);
  assert.ok(out[0] === 1 && out[1] > 0 && out[1] < 1 && out[2] === 0, 'amber is warm');
  world.lightRGB({ uv: 255 }, out);
  assert.ok(out[2] > out[0] && out[1] === 0, 'UV reads violet');
});

test('the live frame: a par\'s emitters, each cell of a bar, through their profiles', () => {
  const fixtures = [fixture(0, 'par'), fixture(1, 'bar', { address: 11 })];
  const rig = buildRig(fixtures, (f) => PROFILES[f.profileId]);
  const universe = new Array(512).fill(0);
  universe.splice(0, 4, 255, 255, 0, 0);                 // the par: full red
  universe.splice(10, 13, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0);  // bar: dimmer, cells blue, green
  const state = { profiles: PROFILES, masterBlackout: false, masterDimmer: 255 };
  const frame = rigLights(fixtures, state, { 0: universe }, rig);
  assert.equal(frame.length, 5);
  assert.deepEqual([frame[0].r, frame[0].g, frame[0].b], [255, 0, 0]);
  assert.deepEqual(frame.slice(1).map((l) => [l.r, l.g, l.b]), [[0, 0, 255], [0, 255, 0], [0, 0, 0], [0, 0, 0]]);

  const dark = rigLights(fixtures, { ...state, masterBlackout: true }, { 0: universe }, rig);
  assert.ok(dark.every((l) => !l.r && !l.g && !l.b), 'blackout is dark everywhere');
  assert.equal(fixtureLight(fixtures[1], state, { 0: universe }), null, 'a bar is not one light');
  assert.equal(fixtureLight(fixture(2, 'missing'), state, { 0: universe }), null, 'nor is a fixture without its profile');
});

test('physical beam shape and direction override Hue transport and room grouping', () => {
  const fixture1 = fixture(0, HUE.id, { group: 'room', output: { protocol: 'hue' },
    emission: { kind: 'beam', pan: 90, tilt: -30, beamAngle: 40 } });
  const { room } = placed([fixture1]);
  const beam = room.lamps[0];
  assert.equal(beam.kind, 'par');
  assert.equal(world.hasBeams(room), true);
  near(beam.aim.x, Math.cos(Math.PI / 6), 'points right');
  near(beam.aim.y, -.5, 'points below the horizon');
  near(beam.aim.z, 0, 'no forward component');
  near(beam.radius, Math.tan(Math.PI / 9) * beam.length, 'full spread is forty degrees');
});

test('one-channel strips and multi-section Hue strips retain their output unit mapping', () => {
  const single = placed([fixture(0, HUE.id, { emission: { kind: 'strip' }, geometry: { length: 40, angle: 90 } })]);
  assert.ok(single.room.cells.length > 1);
  assert.ok(single.room.cells.every((cell) => cell.unit === 0));
  assert.ok(single.room.cells[0].position.z < single.room.cells.at(-1).position.z);
  const multi = placed([fixture(0, BAR.id, { output: { protocol: 'hue' }, emission: { kind: 'strip' } })]);
  assert.deepEqual(multi.room.cells.map((cell) => cell.unit), [0, 1, 2, 3]);
});

test('a single-zone strip uses the inspector\'s default length', () => {
  const strip = fixture(0, HUE.id, { position: { x: 50, y: 50 }, emission: { kind: 'strip' } });
  const initial = placed([strip]).room.cells;
  const edited = placed([{ ...strip, geometry: { length: 8, angle: 0 } }]).room.cells;
  assert.equal(initial.length, 16, 'one output still draws a continuous strip');
  assert.deepEqual(initial, edited, 'the inspector displays the same default length as Stage');
});

test('a beam leaves its pool on the first surface it meets, and none when it meets nothing', () => {
  const low = fixture(0, PAR.id, { position: { x: 50, y: 50 }, emission: { kind: 'beam', tilt: -10 } });
  const distant = placed([low]).room.lamps[0];
  assert.ok(distant.end.y > 0, 'the shallow ray stops at its range limit');
  assert.equal(distant.pool, null);

  const fixtures = [{ ...low, emission: { kind: 'beam', pan: 90, tilt: -10 } }];
  const rig = buildRig(fixtures, () => PAR);
  const room = { bounds: { width: 4, depth: 4, height: 3 },
    bindings: [{ fixtureId: 0, position: { x: 0, y: 2, z: 0 } }] };
  const wall = world.roomRig(fixtures, rig, room).lamps[0];
  near(wall.end.x, 2, 'the ray meets the wall');
  assert.ok(wall.end.y > 1);
  nearVec(wall.pool.normal, { x: -1, y: 0, z: 0 }, 'the pool lies on the wall, facing back into the room');
  assert.ok(wall.pool.at.x < 2 && wall.pool.at.x > 1.99, 'just off the wall, on the room side');
  near(wall.pool.at.y, wall.end.y, 'where the beam lands, not beneath it');

  fixtures[0].emission.tilt = -60;
  const floor = world.roomRig(fixtures, rig, room).lamps[0];
  near(floor.end.y, 0, 'the steep ray meets the floor first');
  nearVec(floor.pool.normal, { x: 0, y: 1, z: 0 }, 'a floor pool faces up');

  fixtures[0].emission.tilt = 70;
  const ceiling = world.roomRig(fixtures, rig, room).lamps[0];
  near(ceiling.end.y, 3, 'the steep upward ray meets the ceiling');
  nearVec(ceiling.pool.normal, { x: 0, y: -1, z: 0 }, 'a ceiling pool faces down');
});

const BOX = { width: 6, depth: 4, height: 3 };
const ray = (x, y, z) => { const length = Math.hypot(x, y, z); return { x: x / length, y: y / length, z: z / length }; };

test('the room box stops a beam at its floor, its ceiling or any of its four walls, whichever comes first', () => {
  const from = { x: 0, y: 1.5, z: 0 };
  for (const [surface, aim, length, normal] of [
    ['floor', ray(0, -1, 0), 1.5, { x: 0, y: 1, z: 0 }],
    ['ceiling', ray(0, 1, 0), 1.5, { x: 0, y: -1, z: 0 }],
    ['right wall', ray(1, 0, 0), 3, { x: -1, y: 0, z: 0 }],
    ['left wall', ray(-1, 0, 0), 3, { x: 1, y: 0, z: 0 }],
    ['front wall', ray(0, 0, 1), 2, { x: 0, y: 0, z: -1 }],
    ['back wall', ray(0, 0, -1), 2, { x: 0, y: 0, z: 1 }],
  ]) {
    const hit = world.surfaceHit(from, aim, BOX);
    near(hit.length, length, `${surface}: how far`);
    nearVec(hit.normal, normal, `${surface}: facing the lamp`);
  }
  nearVec(world.surfaceHit(from, ray(1, -0.25, 0), BOX).normal, { x: -1, y: 0, z: 0 }, 'a shallow slope reaches the wall first');
  nearVec(world.surfaceHit(from, ray(1, -1, 0), BOX).normal, { x: 0, y: 1, z: 0 }, 'a steep one the floor');
});

test('a beam that meets nothing within its range has no surface; the generic venue has a floor and a roof only', () => {
  assert.equal(world.surfaceHit({ x: 0, y: 1, z: 0 }, ray(1, 0, 0), { width: 40, depth: 40, height: 3 }), null, 'the wall is out of range');
  assert.equal(world.surfaceHit({ x: 0, y: world.TRUSS_H, z: 0 }, ray(0, 0, 1)), null, 'no walls without a room');
  near(world.surfaceHit({ x: 0, y: world.FLOOR_H, z: 0 }, ray(0, 1, 0)).length, world.TRUSS_H + 2.5 - world.FLOOR_H, 'an uplighter reaches the roof');
  near(world.surfaceHit({ x: 0, y: world.TRUSS_H, z: 0 }, ray(0, -1, 0)).length, world.TRUSS_H, 'a downlighter the floor');
});

test('a room\'s box walls stop a beam before the room box does, turned on any axis, and only box walls do', () => {
  const objects = [
    { id: 'partition', kind: 'box', role: 'wall', position: { x: 1, y: 1.5, z: 0 }, size: { x: 0.1, y: 3, z: 4 } },
    { id: 'sofa', kind: 'box', role: 'furniture', position: { x: -1, y: 0.4, z: 0 }, size: { x: 0.5, y: 0.8, z: 2 } },
    { id: 'pillar', kind: 'cylinder', role: 'wall', position: { x: 0, y: 1.5, z: 1 }, size: { x: 0.3, y: 3, z: 0.3 } },
  ];
  const walls = world.boxWalls(objects);
  assert.equal(walls.length, 1, 'furniture and round walls leave the beam to the room box');
  const from = { x: 0, y: 1.5, z: 0 };
  const right = world.surfaceHit(from, ray(1, 0, 0), BOX, walls);
  near(right.length, 0.95, 'the partition\'s near face');
  nearVec(right.normal, { x: -1, y: 0, z: 0 }, 'facing the lamp');
  near(world.surfaceHit(from, ray(-1, 0, 0), BOX, walls).length, 3, 'the sofa does not stop it');
  near(world.surfaceHit({ x: 1, y: 1.5, z: 0 }, ray(1, 0, 0), BOX, walls).length, 2, 'a lamp set into the wall shines out of it');

  // A wall turned on all three axes, measured against three.js's own raycaster.
  const slanted = { id: 'slanted', kind: 'box', role: 'wall', position: { x: 1.4, y: 1.4, z: -0.3 },
    size: { x: 0.2, y: 2.5, z: 3 }, rotation: { x: 0.3, y: -0.7, z: 0.2 } };
  const mesh = new Mesh(new BoxGeometry(0.2, 2.5, 3));
  mesh.position.set(1.4, 1.4, -0.3);
  mesh.rotation.set(0.3, -0.7, 0.2);
  mesh.updateMatrixWorld();
  for (const aim of [ray(1, 0, 0), ray(1, -0.3, 0.3), ray(1, 0.2, -0.4)]) {
    const [expected] = new Raycaster(new Vector3(from.x, from.y, from.z), new Vector3(aim.x, aim.y, aim.z)).intersectObject(mesh);
    assert.ok(expected, 'the ray does reach the wall');
    const hit = world.surfaceHit(from, aim, BOX, world.boxWalls([slanted]));
    near(hit.length, expected.distance, 'as far as three.js finds it');
    const normal = expected.face.normal.clone().transformDirection(mesh.matrixWorld);
    nearVec(hit.normal, normal, 'on the face three.js finds');
  }
});

test('a pool lies on its surface facing the lamp, an ellipse stretched along the slant and capped when grazing', () => {
  const plane = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);   // the pool as scene.js builds it
  const drawn = (pool) => new Matrix4().makeBasis(
    new Vector3(pool.along.x, pool.along.y, pool.along.z).multiplyScalar(pool.major),
    new Vector3(pool.normal.x, pool.normal.y, pool.normal.z),
    new Vector3(pool.across.x, pool.across.y, pool.across.z).multiplyScalar(pool.minor)).setPosition(pool.at.x, pool.at.y, pool.at.z);
  const end = { x: 2, y: 1.2, z: 0.5 }, wall = { x: -1, y: 0, z: 0 };
  const cases = [['square on', ray(1, 0, 0), 1], ['sixty degrees off', ray(0.5, -Math.sqrt(3) / 2, 0), 2],
    ['grazing', ray(0.05, -1, 0.2), 1 / 0.35]];
  for (const [name, aim, stretch] of cases) {
    const pool = world.poolOn(end, wall, aim, 1);
    near(pool.minor, 1.35, `${name}: as wide as the softened cone`);
    near(pool.major / pool.minor, stretch, `${name}: stretched by 1/cos, capped`);
    const matrix = drawn(pool);
    assert.ok(matrix.determinant() > 0, `${name}: turned, not mirrored`);
    // The first triangle's winding, once placed, faces the lamp: its front is what the pool shader draws.
    const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(plane.attributes.position, plane.index.array[k]).applyMatrix4(matrix));
    const facing = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    nearVec(facing, wall, `${name}: the front faces back into the room`);
    near(new Vector3(1, 0, 0).applyMatrix4(matrix).sub(new Vector3(pool.at.x, pool.at.y, pool.at.z)).length(), pool.major, `${name}: the long axis`);
    near(pool.at.x, end.x - 0.006, `${name}: just off the wall`);
  }
  const slant = world.poolOn(end, wall, ray(0.5, -Math.sqrt(3) / 2, 0), 1);
  nearVec(slant.along, { x: 0, y: -1, z: 0 }, 'a beam slanting down the wall stretches its pool down the wall');
});

test('multi-cell fixtures can emit separate beams without changing the rendered cell layout', () => {
  const { room, rig } = placed([fixture(0, BAR.id, { emission: { kind: 'beam', pan: 0, tilt: -90 } })]);
  assert.equal(rig.units.length, 4);
  assert.equal(room.cells.length, 0);
  assert.equal(room.lamps.length, 4);
  assert.deepEqual(room.lamps.map((lamp) => lamp.unit), [0, 1, 2, 3]);
});


test('explicit cell maps use the same rotated offsets and individual heights in the generic Stage', () => {
  const fixtures = [fixture(0, BAR.id, { position: { x: 50, y: 50, height: 50 },
    geometry: { length: 10, angle: 90, points: [{ x: -2, y: 0, height: -10 }, { x: 0, y: -2, height: 0 },
      { x: 2, y: 0, height: 10 }, { x: 0, y: 2, height: 20 }] } })];
  const { rig, room } = placed(fixtures);
  assert.equal(room.cells.length, 4);
  room.cells.forEach((cell, i) => {
    const point = world.planToWorld(rig.points[i]);
    near(cell.position.x, point.x, 'mapped x');
    near(cell.position.z, point.z, 'mapped depth');
    near(cell.position.y, rig.points[i].height / 100 * world.TRUSS_H, 'mapped height');
  });
});
