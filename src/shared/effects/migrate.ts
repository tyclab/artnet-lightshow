import { validateSpec } from './registry.ts';
import type { EffectSpec } from './types.ts';

export const EFFECT_LIBRARY_VERSION = 3;
export const legacyKind = (kind: string): string => kind.startsWith('compat.') ? kind.slice(7) : kind;
export const compatibilityKind = (kind: string): string => /^(hd|ldj)\./.test(kind) ? `compat.${kind}` : kind;

// Authored legacy parameters retain their renderer; only proven equivalents become generator aliases.
export function migrateEffectSpec(raw: unknown, fromVersion = 0): EffectSpec {
  const spec = validateSpec(raw);
  // Version 3 only added the per-spec background level (validateSpec fills it); the conversions below are v0/v1's.
  if (fromVersion >= 2) return spec;
  const params = { ...spec.params };
  if (spec.kind === 'macro' && Array.isArray(params.steps)) {
    params.steps = params.steps.map((step: { effect: EffectSpec }) => ({ ...step, effect: migrateEffectSpec(step.effect, fromVersion) }));
  }
  const kind = spec.kind === 'ldj.PartyStrobe' ? 'compat.ldj.MatrixPulse' : compatibilityKind(spec.kind);
  return validateSpec({ ...spec, kind, params });
}
