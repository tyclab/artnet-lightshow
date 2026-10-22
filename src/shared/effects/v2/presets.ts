import './sweep.ts';
import './shell.ts';
import './orbit.ts';
import './scatter.ts';
import './neural.ts';
import { validateSpec } from '../registry.ts';
import type { EffectSpec } from '../types.ts';

// Presets are parameter sets of the five generators. Each has a room form (`v2.<name>`, metres)
// and a classic 2D twin (`v2.<name>.2d`) whose spec differs only in `space`.

export interface V2Preset {
  id: string; name: string; desc: string; app: 'own'; family: 'spatial'; spec: EffectSpec;
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
  ['popcorn', 'Popcorn', 'Small pops of colour wherever the bass or the mids hit, each its own colour',
    'v2.scatter', { density: 0.08, stepBeats: 0.25, envelope: { curve: 'easeOut', attack: 0, hold: 0.12, release: 0.3 }, clusterM: 0.2, bands: ['bass', 'mid'] }],
  ['grooveWave', 'Groove Wave', 'A soft crest of the look\'s colours rolling left to right through the room, a lap every few beats',
    'v2.sweep', { azimuthDeg: 90, width: 0.8, speed: 1, background: 0.1 }],
  ['bigRoomWave', 'Big Room Wave', 'A broad, slow wave over the whole room, rising slightly as it crosses, its colour walking the palette',
    'v2.sweep', { azimuthDeg: 90, elevationDeg: 15, width: 1.6, speed: 0.75, colour: 'time', background: 0.2 }],
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
    'v2.orbit', { profile: 'beacon', beamDeg: 40, turnsPerBar: 1, background: 0.05 }],
  ['neural', 'Neural', 'The music in the room: bass on the floor, mids at head height, highs at the ceiling, the hue on the pitch',
    'v2.neural', { layout: 'height' }],
  ['neuralDistance', 'Neural Distance', 'The bass spreading out from the speakers as far as it is loud, mids and highs further out',
    'v2.neural', { layout: 'distance' }],
  ['beatAccentWash', 'Beat Accent Wash', 'The whole room pulsing on every beat with the bass, a slow gradient drifting through it',
    'v2.sweep', { azimuthDeg: 90, profile: 'gradient', speed: 0.25, trigger: BASS_ACCENT, envelope: { curve: 'easeOut', attack: 0, hold: 0.1, release: 0.6 } }],
  ['volumeGateWash', 'Volume Gate Wash', 'A wide wash crossing the room that opens with how loud the music is',
    'v2.sweep', { azimuthDeg: 90, width: 2, speed: 0.5, background: 0.15,
      trigger: { mode: 'volumeGate', band: 'full', beatInterval: 1, threshold: 0.2, reactiveDepth: 0.8 } }],
  ['frequencyBurst', 'Frequency Burst', 'Bright bursts on random lights when the highs hit, every sixteenth while they last',
    'v2.scatter', { density: 0.25, stepBeats: 0.25, envelope: FLASH,
      trigger: { mode: 'beatAccent', band: 'high', beatInterval: 0.25, threshold: 0.15, reactiveDepth: 0.6 }, bands: ['high'] }],
];

export const V2_PRESETS: readonly V2Preset[] = RAW.flatMap(([id, name, desc, kind, params, extra]) => [
  { id: `v2.${id}`, name, desc: `${desc}.`, app: 'own' as const, family: 'spatial' as const,
    spec: validateSpec({ kind, ...extra, params: { ...params, space: 'room' } }) },
  { id: `v2.${id}.2d`, name: `${name} 2D`, desc: `${desc}, drawn across the Rig plot.`, app: 'own' as const, family: 'spatial' as const,
    spec: validateSpec({ kind, ...extra, params: { ...params, space: 'plan' } }) },
]);
