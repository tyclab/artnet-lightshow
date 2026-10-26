import './sweep.ts';
import './shell.ts';
import './orbit.ts';
import './scatter.ts';
import './neural.ts';
import './wash.ts';
import './step.ts';
import './zones.ts';
import './noise.ts';
import './particles.ts';
import './visualizer.ts';
import { validateSpec } from '../registry.ts';
import type { EffectSpec } from '../types.ts';

// Keep plot variants addressable for saved shows and the mapping control, outside the picker.

export interface V2Preset {
  id: string; name: string; desc: string; app: 'own'; family: 'spatial'; spec: EffectSpec;
  retired?: boolean; variantOf?: string;
}

const FLASH = { curve: 'linear', attack: 0, hold: 0.06, release: 0.04 } as const;
const BASS_ACCENT = { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } as const;

type Raw = [id: string, name: string, desc: string, kind: string, params: Record<string, unknown>, extra?: Partial<EffectSpec>];
const RAW: Raw[] = [
  ['scatterStrobe', 'Scatter Strobe', 'White flashes on random lights every sixteenth, in small clusters round the room',
    'v2.scatter', { density: 0.2, stepBeats: 0.25, envelope: FLASH, clusterM: 0.35, colour: 'solid' }, { palette: ['#FFFFFF'] }],
  ['scatterFade', 'Scatter Fade', 'Random clusters light in the look\'s colours on every half beat and fade over a bar',
    'v2.scatter', { density: 0.12, stepBeats: 0.5, envelope: { curve: 'easeOut', attack: 0, hold: 0.25, release: 1.75 }, clusterM: 0.25 }],
  ['scatterGrow', 'Scatter Grow', 'Random clusters swell in, hold and let go, a new set every half beat',
    'v2.scatter', { density: 0.1, stepBeats: 0.5, envelope: { curve: 'easeIn', attack: 0.75, hold: 0.25, release: 0.5 }, clusterM: 0.3 }],
  ['grooveWave', 'Groove Wave', 'A soft crest of the look\'s colours rolling left to right through the room, a lap every few beats',
    'v2.sweep', { azimuthDeg: 90, width: 0.8, speed: 1 }],
  ['bigRoomWave', 'Big Room Wave', 'A broad, slow wave over the whole room, rising slightly as it crosses, its colour walking the palette',
    'v2.sweep', { azimuthDeg: 90, elevationDeg: 15, width: 1.6, speed: 0.75, colour: 'time' }],
  ['ascent', 'Ascent', 'A comet climbing from the floor to the ceiling, its tail glowing below it',
    'v2.sweep', { elevationDeg: 90, profile: 'comet', width: 0.5, speed: 1.3 }],
  ['doubleWave', 'Double Wave', 'Bands of light and dark in pairs, crossing the room on the diagonal',
    'v2.sweep', { azimuthDeg: 45, profile: 'stripe', width: 0.9, speed: 1.2 }],
  ['swagger', 'Swagger', 'A crisp line swinging across the room and back, turning a little every pass',
    'v2.sweep', { azimuthDeg: 90, profile: 'line', width: 0.35, speed: 1.5, motion: 'bounce', turnPerLap: 45 }],
  ['impact', 'Impact', 'A glowing ring bursting out from the listener on every beat, harder with the bass',
    'v2.shell', { origin: 'listener', profile: 'ramp', speed: 4, width: 0.4, trigger: BASS_ACCENT }],
  ['vortex', 'Vortex', 'Rings spiralling out from the listener, a turn round the room for every few metres',
    'v2.shell', { origin: 'listener', twistDeg: 120, speed: 2, width: 0.5 }],
  ['speakerShockwave', 'Speaker Shockwave', 'On every kick a ring leaves each speaker and crosses the room at a few metres a second',
    'v2.shell', { origin: 'anchor', anchor: 'speakerLeft', alsoAnchor: 'speakerRight', speed: 3, width: 0.45, trigger: BASS_ACCENT }],
  ['rotation', 'Rotation', 'The room in two halves of colour turning round the listener every two bars',
    'v2.orbit', { profile: 'sectors', sectors: 2, turnsPerBar: 0.5 }],
  ['swirl', 'Swirl', 'The look\'s colours laid round the listener and turning slowly, a turn every four bars',
    'v2.orbit', { profile: 'gradient', turnsPerBar: 0.25 }],
  ['beacon', 'Beacon', 'A lighthouse beam sweeping round the listener once a bar, front, side, back and side',
    'v2.orbit', { profile: 'beacon', beamDeg: 40, turnsPerBar: 1 }],
  ['neural', 'Neural', 'The music in the room: bass on the floor, mids at head height, highs at the ceiling, the hue on the pitch',
    'v2.neural', { layout: 'height' }],
  ['neuralDistance', 'Neural Distance', 'The bass spreading out from the speakers as far as it is loud, mids and highs further out',
    'v2.neural', { layout: 'distance' }],
  ['beatAccentWash', 'Beat Accent Wash', 'The whole room pulsing on every beat with the bass, a slow gradient drifting through it',
    'v2.sweep', { azimuthDeg: 90, profile: 'gradient', speed: 0.25, trigger: BASS_ACCENT, envelope: { curve: 'easeOut', attack: 0, hold: 0.1, release: 0.6 } }],
  ['volumeGateWash', 'Volume Gate Wash', 'A wide wash crossing the room that opens with how loud the music is',
    'v2.sweep', { azimuthDeg: 90, width: 2, speed: 0.5,
      trigger: { mode: 'volumeGate', band: 'full', beatInterval: 1, threshold: 0.2, reactiveDepth: 1 } }],
  ['frequencyBurst', 'Frequency Burst', 'Bright bursts on random lights when the highs hit, every sixteenth while they last',
    'v2.scatter', { density: 0.25, stepBeats: 0.25, envelope: FLASH,
      trigger: { mode: 'beatAccent', band: 'high', beatInterval: 0.25, threshold: 0.15, reactiveDepth: 0.6 }, bands: ['high'] }],
  ['wash', 'Wash', 'A steady colour over the whole room, with shared audio, envelope and colour controls',
    'v2.wash', { colour: 'solid' }],
  ['breathe', 'Breathe', 'The whole room breathing from dark through a slow colour cycle over two bars',
    'v2.wash', { shape: 'breathe', cycleBeats: 8, colour: 'time' }],
  ['chase', 'Chase', 'A soft pulse stepping through the room along an axis, with a fading trail',
    'v2.step', { order: 'axis', azimuthDeg: 90, trail: 2 }],
  ['pathRunner', 'Path Runner', 'A pulse runs down each strip in its physical cell order, leaving a long trail',
    'v2.step', { order: 'path', steps: 16, stepBeats: 0.25, trail: 5, envelope: { curve: 'easeOut', attack: 0, hold: 0.1, release: 0.4 } }],
  ['surround', 'Surround', 'Front, right, back and left answer on the beat around the listener and their facing',
    'v2.step', { order: 'orbit', steps: 8, stepBeats: 0.5, window: 2, trail: 1 }],
  ['zones', 'Zones', 'Left and right answer each other with a soft beat envelope, a different colour on each side',
    'v2.zones', { partition: 'leftRight' }],
  ['surroundAnswer', 'Surround Answer', 'The front, sides and back of the listener take turns answering the music',
    'v2.zones', { partition: 'surround', stepBeats: 1 }],
  ['nearFar', 'Near and Far', 'The lights near the listener answer those across the room, building outwards',
    'v2.zones', { partition: 'nearFar', mode: 'fill', radiusM: 2 }],
  ['noise', 'Drifting Clouds', 'Soft three dimensional clouds drift continuously through lamps, strips and pixel surfaces',
    'v2.noise', { speed: 0.1, scaleM: 2, contrast: 1.2, cutoff: 0.2 }],
  ['aurora', 'Aurora', 'Curtains of colour wander through the room, bending with real height',
    'v2.noise', { shape: 'aurora', speed: 0.14, scaleM: 2.5, cutoff: 0.15 }],
  ['fire', 'Fire', 'A drifting field of flames grows from the floor and fades as it reaches the ceiling',
    'v2.noise', { shape: 'fire', speed: 0.45, scaleM: 1, contrast: 1.1, cutoff: 0.1 }],
  ['risingWall', 'Rising Wall', 'A build fills from floor to ceiling with section progress and a tightening pulse',
    'v2.sweep', { elevationDeg: 90, profile: 'fill', fillSource: 'section', lengthBeats: 16, width: 0.3 }],
  ['fallingWall', 'Falling Wall', 'The filled room releases from ceiling to floor over one bar with the palette reversed',
    'v2.sweep', { elevationDeg: 90, profile: 'fill', fillSource: 'once', lengthBeats: 4, falling: true, width: 0.4 }],
  ['lightOrbs', 'Light Orbs', 'Soft light objects circle the listener on tempo locked paths with fading trails across every device',
    'v2.particles', { mode: 'orbs', count: 3, radiusM: 1, pathRadiusM: 2, trail: 5, cycleBeats: 8 }],
  ['orbCollision', 'Orb Collision', 'Light orbs converge at the listener and burst into falling sparks on the drop',
    'v2.particles', { mode: 'orbs', count: 3, radiusM: 1, trail: 4, collide: true, cycleBeats: 8 }],
  ['fireworks', 'Fireworks', 'Rockets launch from an anchor and burst into coloured sparks that arc and fall under gravity',
    'v2.particles', { mode: 'fireworks', count: 24, radiusM: 0.8, cycleBeats: 8, speed: 1.5, gravity: 0.65, fromAnchor: 'speakerLeft', trail: 4 }],
  ['rain', 'Rain', 'Drops fall from the ceiling through strips and pixel columns and splash onto floor lamps',
    'v2.particles', { mode: 'rain', count: 28, radiusM: 0.7, cycleBeats: 4, speed: 1.8, gravity: 0.8, trail: 3 }],
  ['stemsSpace', 'Stems in Space', 'Bass at the floor and speakers, drums in shockwaves, vocals in front and hats near the ceiling',
    'v2.zones', { partition: 'stems' }],
  ['visualizerFlow', 'Visualizer Flow', 'Colours and motion speed from the room picture drive a spatial orbit of light around the listener',
    'v2.visualizer', { profile: 'orbit' }],
  ['visualizerDrift', 'Visualizer Drift', 'The room picture supplies only palette and motion speed to a drifting three dimensional cloud field',
    'v2.visualizer', { profile: 'noise' }],
];

export const V2_PRESETS: readonly V2Preset[] = RAW.flatMap(([id, name, desc, kind, params, extra]) => [
  { id: `v2.${id}`, name, desc: `${desc}.`, app: 'own' as const, family: 'spatial' as const,
    spec: validateSpec({ kind, ...extra, params: { ...params, space: 'room' } }) },
  { id: `v2.${id}.2d`, name: `${name} 2D`, desc: `${desc}, drawn across the Rig plot.`, app: 'own' as const, family: 'spatial' as const,
    retired: true, variantOf: `v2.${id}`,
    spec: validateSpec({ kind, ...extra, params: { ...params, space: 'plan' } }) },
]);
