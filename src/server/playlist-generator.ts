import { z } from 'zod';
import { newUserId } from './effect-library.ts';
import { validateSequence } from './sequencer.ts';
import { hardwareDecision, stricterPolicy } from '../shared/hardware.ts';
import type { HardwareCaps, AdmissionPolicy } from '../shared/hardware.ts';
import { effectNeeds } from '../shared/effects/hardware.ts';
import { kindOf, pacesOwnFlashes, requiresAcknowledgement } from '../shared/effects/registry.ts';
import type { EffectSpec } from '../shared/effects/types.ts';
import type { MacroParams } from '../shared/effects/macro.ts';
import { validate } from './validation.ts';

export const PLAYLIST_TEMPLATES = [
  { id: 'universal', name: 'Universal Effects' },
  { id: 'bonus', name: 'Bonus Effects' },
  { id: 'compatible', name: 'Compatible library' },
  { id: 'all', name: 'Entire effect library' },
  { id: 'empty', name: 'My Playlist' },
] as const;

const UNIVERSAL = new Set(['StrobeCycle', 'PartyStrobe', 'Swirl', 'GrowCycle', 'FadeCycle', 'SoftStrobe', 'Fireworks',
  'Drip', 'Glow', 'Blur', 'Split', 'Flip', 'CrossFade', 'GrooveWave', 'FillCycle', 'QuickFlash', 'BigRoomMix',
  'DoubleFill', 'Ascent', 'DoubleWave', 'Impact', 'Swagger', 'Vortex', 'Blackout'].map((name) => `ldj.${name}`));
const generatorSchema = z.object({
  template: z.enum(['universal', 'bonus', 'compatible', 'all', 'empty']),
  name: z.string().trim().min(1).max(80).optional(),
  lengthBeats: z.number().finite().int().min(1).max(1024).default(32),
  includeRapid: z.boolean().default(false),
}).strict();
type Preset = { id: string; name: string; legacy?: boolean; spec?: EffectSpec };

function playableOn(spec: EffectSpec, caps: HardwareCaps, bpm: number, parent?: AdmissionPolicy): boolean {
  const policy = stricterPolicy(parent, spec.admission);
  if (spec.kind === 'macro') return (spec.params as unknown as MacroParams).steps.every((step) => playableOn(step.effect, caps, bpm, policy));
  const decision = hardwareDecision({ ...effectNeeds(spec, bpm), ...kindOf(spec.kind)?.requirements }, caps, policy);
  return decision.mode === 'play' || decision.mode === 'slower';
}

export function generatePlaylist(raw: unknown, presets: Preset[], caps: HardwareCaps[], bpm = 120) {
  const options = validate(generatorSchema, raw, 'playlist generator');
  const skipped: { id: string; name: string; reason: string }[] = [];
  const rows = presets.filter((preset) => {
    if (options.template === 'empty') return false;
    if (options.template === 'universal' && !UNIVERSAL.has(preset.id)) return false;
    if (options.template === 'bonus' && (!preset.id.startsWith('ldj.') || UNIVERSAL.has(preset.id)
      || preset.id.startsWith('ldj.visualizer.') || preset.id.startsWith('ldj.Matrix'))) return false;
    const reason = !preset.spec || preset.legacy ? 'Classic look; use it outside a playlist'
      : pacesOwnFlashes(preset.spec) ? 'Self-paced strobe; use its dedicated pad'
        : !options.includeRapid && requiresAcknowledgement(preset.spec) ? 'Rapid effect omitted'
          : options.template === 'compatible' && !caps.some((cap) => playableOn(preset.spec!, cap, bpm)) ? 'No playable fixture in this rig' : null;
    if (reason) { skipped.push({ id: preset.id, name: preset.name, reason }); return false; }
    return true;
  });
  const laneId = 'playlist';
  const sequence = validateSequence({ id: newUserId(), name: options.name ?? PLAYLIST_TEMPLATES.find((t) => t.id === options.template)!.name,
    mode: 'playlist', lanes: [{ id: laneId, kind: 'shared', name: 'Playlist' }],
    clips: rows.map((preset, index) => ({ id: `row-${index + 1}`, laneId, startBeat: index * options.lengthBeats,
      lengthBeats: options.lengthBeats, loopBeats: options.lengthBeats, presetId: preset.id })),
  });
  return { sequence, skipped, rapid: rows.filter((preset) => requiresAcknowledgement(preset.spec!)).length };
}
