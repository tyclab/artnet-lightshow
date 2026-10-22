import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';

// Synthetic mixed hardware: a wall, keyboard, two strips and thirty individual lamps.
export function runtimeRig() {
  const profile = (id, count, grid) => ({ id, name: id, channelCount: count * 3, channelMap: count === 1 ? { red: 0, green: 1, blue: 2 } : {},
    ...(count > 1 ? { cells: Array.from({ length: count }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) } : {}),
    ...(grid ? { grid } : {}) });
  const profiles = new Map([
    ['wall', profile('wall', 2400, { columns: 60, rows: 40 })],
    ['keyboard', profile('keyboard', 120, { columns: 12, rows: 10 })],
    ['strip', profile('strip', 225)], ['lamp', profile('lamp', 1)],
  ]);
  const fixtures = [];
  let nextUniverse = 0;
  const add = (profileId, protocol, position, geometry) => {
    fixtures.push({ id: fixtures.length + 1, profileId, universe: nextUniverse, address: 1, maxBrightness: 255,
      override: null, group: null, hue: protocol === 'hue', output: { protocol }, position, geometry });
    nextUniverse += Math.ceil(profiles.get(profileId).channelCount / 512);
  };
  add('wall', 'ddp', { x: 50, y: 10, height: 50 }, { length: 60, angle: 0,
    points: Array.from({ length: 2400 }, (_, i) => ({ x: (i % 60 - 29.5), y: 0, height: (19.5 - Math.floor(i / 60)) * 2 })) });
  add('keyboard', 'openrgb', { x: 65, y: 65, height: 25 }, { length: 10, angle: 0,
    points: Array.from({ length: 120 }, (_, i) => ({ x: (i % 12 - 5.5) * 0.8, y: (Math.floor(i / 12) - 4.5) * 0.4 })) });
  add('strip', 'ddp', { x: 5, y: 50, height: 80 }, { length: 80, angle: 90 });
  add('strip', 'ddp', { x: 95, y: 50, height: 80 }, { length: 80, angle: 90 });
  for (let i = 0; i < 30; i++) {
    const theta = i / 10 * Math.PI * 2;
    add('lamp', 'hue', { x: 50 + 40 * Math.cos(theta), y: 50 + 40 * Math.sin(theta), height: 10 + Math.floor(i / 10) * 35 });
  }
  const room = roomSceneSchema.parse({ version: 1, name: 'Synthetic runtime room', bounds: { width: 6, depth: 5, height: 3 },
    bindings: [], anchors: [{ id: 'speakerLeft', position: { x: -2, y: 0.5, z: -2 } }, { id: 'speakerRight', position: { x: 2, y: 0.5, z: -2 } }],
    listeners: [{ id: 'centre', position: { x: 0, y: 1.2, z: 0 }, facingDeg: 0 }] });
  const profileOf = (fixture) => profiles.get(fixture.profileId);
  const rig = buildRig(fixtures, profileOf);
  return { fixtures, profileOf, rig, space: buildUnitSpace(rig, room), base: {
    running: true, pattern: 'solid', colorA: 1, colorB: 5, colorC: 3, colorD: 8, beatDivision: 1, split: null, pixelMap: 'stage',
    strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, fixtures, universes: Array.from({ length: nextUniverse }, (_, i) => i),
    hardware: { technologies: {}, products: {} }, safety: { acknowledged: true, hdFlashIntervalMs: 350 }, hueStrobe: 'flash', audioMode: 'reactive',
  } };
}
