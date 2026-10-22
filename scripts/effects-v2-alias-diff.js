import { fileURLToPath } from 'node:url';
import { LEGACY_PRESETS, V2_ALIASES, presetById } from '../src/shared/effects/catalogue.ts';
import { renderLookBytes, withMixedRig } from './golden-party-looks.js';

// The synthetic par/Hue/bar rig quantifies intentional alias changes without installation data.
export function aliasFrameDiffs() {
  return withMixedRig((fixtures) => Object.entries(V2_ALIASES).flatMap(([id, target]) => {
    const legacy = LEGACY_PRESETS.find((p) => p.id === id);
    if (!legacy || legacy.legacy) return [];
    const modern = presetById(target);
    const before = renderLookBytes(id, fixtures, () => legacy.spec);
    const after = renderLookBytes(id, fixtures, () => modern.spec);
    const deltas = before.map((frame, k) => Math.max(...frame.map((value, i) => Math.abs(value - after[k][i]))));
    return [{ id, target, maxChannelDelta: Math.max(...deltas), changedFrames: deltas.filter(Boolean).length, frames: deltas.length }];
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(aliasFrameDiffs(), null, 2));
