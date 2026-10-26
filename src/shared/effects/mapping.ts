import type { EffectSpec } from './types.ts';

export const MAPPING_LABELS = { plan: 'Across layout', room: 'Through room' } as const;

export function usesSpatialMapping(spec: Pick<EffectSpec, 'kind' | 'params'>): boolean {
  const p = spec.params || {};
  if (spec.kind === 'v2.wash') return false;
  if (spec.kind === 'v2.step') return p.order !== 'path' && p.order !== 'random';
  if (spec.kind === 'v2.zones') return p.partition !== 'technology' && p.partition !== 'role';
  if (spec.kind === 'v2.scatter') return p.selection !== 'cells' || Number(p.clusterM || 0) > 0;
  if (spec.kind === 'strobe') return p.selection !== undefined && p.selection !== 'all';
  return spec.kind.startsWith('v2.');
}

export function mappingOf(spec: Pick<EffectSpec, 'kind' | 'params'>): 'plan' | 'room' | null {
  return usesSpatialMapping(spec) ? spec.params?.space === 'plan' ? 'plan' : 'room' : null;
}
