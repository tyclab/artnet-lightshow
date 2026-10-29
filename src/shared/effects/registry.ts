// Kinds register on import so the worker and browser use the same definitions.
// Specs remain wire data: fixed colours are only parsed when an instance starts.

import { z } from 'zod';
import { admissionPolicySchema } from '../hardware.ts';
import { HEX_COLOUR, gradientFields, checkGradients, paletteBodySchema } from '../palette-model.ts';
import type { EffectKindDef, EffectSpec, GapPolicy } from './types.ts';

export const KINDS = new Map<string, EffectKindDef>();

export function registerKind<P, S>(def: EffectKindDef<P, S>): void {
  KINDS.set(def.kind, def);
}

export function kindOf(kind: string): EffectKindDef | null {
  const canonical = /^compat\.(hd|ldj)\./.test(kind) ? kind.slice(7) : kind;
  return KINDS.get(canonical) ?? null;
}

export function requiresAcknowledgement(spec: EffectSpec): boolean {
  const def = kindOf(spec.kind);
  return Boolean(spec.rapidFlash || def?.rapidFlash || def?.rapidFlashWhen?.(spec.params));
}

/**
 * What a kind does between its hits when its spec chooses nothing: the LDJ families
 * (the bitmap raster included) and Disco kept their gaps dark before an effect could
 * choose, every other family revealed the Background layer in them.
 */
export function familyGaps(kind: string): GapPolicy {
  const def = kindOf(kind);
  return def?.app === 'ldj' || def?.kind === 'hd.disco' ? 'dark' : 'reveal';
}

/** Rests that are strobe rests: the spec needs the photosensitivity acknowledgement or paces an automatic strobe of its own (Disco). */
export function strobeRests(spec: EffectSpec): boolean {
  return requiresAcknowledgement(spec) || pacesOwnFlashes(spec);
}

/** Whether "Between effect hits" can change what this spec plays; the editor disables the choice where it cannot. */
export function gapsApply(spec: EffectSpec): boolean {
  return Boolean(kindOf(spec.kind)?.gapsApply?.(spec.params ?? {}, spec));
}

/** The spec's background after a pick: its family's default (a macro's: none) is stored as no choice, so a container's choice still reaches it. */
export function chooseGaps(spec: EffectSpec, choice: GapPolicy | '' | null): NonNullable<EffectSpec['background']> {
  const { gaps: _gaps, ...rest } = spec.background ?? { version: 1 as const, level: spec.brightness ?? 1 };
  const unchosen = spec.kind === 'macro' ? null : familyGaps(spec.kind);
  return choice && choice !== unchosen ? { ...rest, gaps: choice } : rest;
}

/** A spec's own "Between effect hits" choice, or its family's. */
export function gapsOf(spec: EffectSpec): GapPolicy {
  return spec.background?.gaps ?? familyGaps(spec.kind);
}

/** Does a kind ride the expression level on a curve of its own (glow), so a layer's level is not multiplied by it again. */
export function ridesLevel(kind: string | null | undefined): boolean {
  return !!kind && !!kindOf(kind)?.rideLevel;
}

/** Does a spec hold its flash limit in its own state (EffectKindDef.pacesOwnFlashes); false for an unknown kind. */
export function pacesOwnFlashes(spec: EffectSpec): boolean {
  return Boolean(kindOf(spec.kind)?.pacesOwnFlashes?.(spec.params ?? {}));
}

// Set while a trusted caller validates: only then does an internal kind exist.
let internalAdmitted = false;

const paramsSchema = z.record(z.string(), z.unknown());
const specSchema = z.object({
  admission: admissionPolicySchema.optional(),
  kind: z.string().refine((kind) => kindOf(kind) !== null && (internalAdmitted || !kindOf(kind)!.internal), 'unknown effect kind'),
  params: paramsSchema.optional(),
  palette: z.array(z.union([
    z.string().regex(HEX_COLOUR, 'expected a full colour hex value'),
    z.object({ random: z.literal(true) }),
  ])).min(1).max(8).nullable().optional(),
  ...gradientFields,
  brightness: z.number().min(0).max(1).optional(),
  background: z.object({ version: z.literal(1), level: z.number().min(0).max(1), gaps: z.enum(['dark', 'reveal']).optional() }).strict().optional(),
  rapidFlash: z.boolean().optional(),
  minFlashIntervalMs: z.number().min(0).optional(),
  scope: z.enum(['singleBeat', 'measure']).optional(),
}).superRefine((spec, ctx) => checkGradients(spec, spec.palette?.length ?? 8, ctx));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Filling nested defaults lets an inspector change one trigger or spatial field
// without losing its siblings. Arrays and explicit nulls are complete values.
function fillDefaults(defaults: unknown, supplied: unknown): unknown {
  if (supplied === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(supplied)) return supplied;
  return Object.fromEntries([...new Set([...Object.keys(defaults), ...Object.keys(supplied)])]
    .map((key) => [key, fillDefaults(defaults[key], supplied[key])]));
}

/**
 * A spec as the effects play it. Internal kinds (EffectKindDef.internal) are
 * unknown here unless `internal` is set, and then for its children too.
 */
export function validateSpec(raw: unknown, { internal = false }: { internal?: boolean } = {}): EffectSpec {
  const before = internalAdmitted;
  internalAdmitted = before || internal;
  try {
    return validateAdmitted(raw);
  } finally {
    internalAdmitted = before;
  }
}

function validateAdmitted(raw: unknown): EffectSpec {
  if (isRecord(raw) && isRecord(raw.palette)) {
    const { colours, ...gradient } = paletteBodySchema.parse(raw.palette);
    raw = { ...raw, ...gradient, palette: colours };
  }
  const supplied = specSchema.parse(raw);
  const def = kindOf(supplied.kind)!;
  // Only absence inherits a recommendation: false, zero and null remain explicit.
  const present = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined));
  const merged = specSchema.parse({ ...def.defaults, ...present, brightness: supplied.brightness ?? def.defaults.brightness ?? 1 });
  const params = paramsSchema.parse(parseParams(def, fillDefaults(def.defaults.params, supplied.params)));
  return { ...merged, params, background: supplied.background ?? { version: 1, level: merged.brightness ?? 1 } };
}

// A kind's schema sees the params alone; its issues are moved under `params`,
// so an error names `params.cadence` rather than a spec field `cadence`.
function parseParams(def: EffectKindDef, params: unknown): unknown {
  const result = def.schema.safeParse(params);
  if (result.success) return result.data;
  throw new z.ZodError(result.error.issues.map((issue) => ({ ...issue, path: ['params', ...issue.path] })));
}

export function specWithDefaults<P = Record<string, unknown>>(kind: string, params?: Partial<P>): EffectSpec {
  return validateSpec({ kind, params });
}
