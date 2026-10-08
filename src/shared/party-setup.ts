import { z } from 'zod';
import type { HdMaster } from './effects/types.ts';

export const PAD_BANKS = 2;
export const PAD_SLOTS = 8;
export const PAD_COUNT = PAD_BANKS * PAD_SLOTS;
export const STROBE_ID = 'strobe';

export type PadContentKind = 'preset' | 'pattern' | 'strobe' | 'sequencePattern';
export interface PadContent { kind: PadContentKind; id: string }
export type PadLaunchMode = 'once' | 'hold' | 'loop';
export interface PadEntry {
  bank: 0 | 1;
  slot: number;
  label: string;
  accent: string;
  content: PadContent | null;
  launch: PadLaunchMode;
  quantise: number;
  targets: 'shared' | number[];
}
export interface ShowPerformance { master: HdMaster; pads: PadEntry[]; activePadLayoutId: string | null }
export interface PadLayoutEntry extends Omit<PadEntry, 'targets'> { targetSlots: 'shared' | number[] }
export interface NamedPadLayout { id: string; name: string; pads: PadLayoutEntry[]; fixtureLabels: string[] }

const fraction = z.number().min(0).max(1);
export const hdMasterSchema = z.object({
  sensitivity: fraction, smoothing: fraction,
  attackMs: z.number().int().min(0).max(2000), releaseMs: z.number().int().min(0).max(5000),
  threshold: fraction, reactiveDepth: fraction, brightness: fraction,
}).strict();
const fixtureId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fields = {
  label: z.string().max(80),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i, 'expected a hex colour #RRGGBB').transform((hex) => hex.toUpperCase()),
  content: z.object({ kind: z.enum(['preset', 'pattern', 'strobe', 'sequencePattern']), id: z.string().min(1).max(64) }).strict().nullable(),
  launch: z.enum(['once', 'hold', 'loop']),
  quantise: z.number().finite().min(0),
};
const targets = z.union([z.literal('shared'), z.array(fixtureId).max(1024).transform((ids) => [...new Set(ids)])]);
const place = { bank: z.union([z.literal(0), z.literal(1)]), slot: z.number().int().min(0).max(PAD_SLOTS - 1) };
const strobeHeld = (pad: { content: { kind: string; id: string } | null; launch: string }, ctx: z.RefinementCtx): void => {
  if (pad.content?.kind !== 'strobe') return;
  if (pad.content.id !== STROBE_ID) ctx.addIssue({ code: 'custom', path: ['content', 'id'], message: `the strobe's id is "${STROBE_ID}"` });
  if (pad.launch !== 'hold') ctx.addIssue({ code: 'custom', path: ['launch'], message: 'the strobe pad plays while held: "hold"' });
};
const uniquePlaces = (pads: { bank: number; slot: number }[], ctx: z.RefinementCtx): void => {
  const seen = new Set<number>();
  pads.forEach(({ bank, slot }, i) => {
    const at = bank * PAD_SLOTS + slot;
    if (seen.has(at)) ctx.addIssue({ code: 'custom', path: [i], message: `bank ${bank} slot ${slot} is there twice` });
    seen.add(at);
  });
};
export const padFieldsSchema = z.object({ ...fields, targets }).strict().superRefine(strobeHeld);
export const padEntrySchema = z.object({ ...place, ...fields, targets }).strict().superRefine(strobeHeld);
export const padLayoutSchema = z.array(padEntrySchema).length(PAD_COUNT).superRefine(uniquePlaces)
  .transform((pads) => pads.sort((a, b) => a.bank - b.bank || a.slot - b.slot));
export const performanceSchema = z.object({
  master: hdMasterSchema, pads: padLayoutSchema, activePadLayoutId: z.string().min(1).max(64).nullable(),
}).strict();
const layoutEntrySchema = z.object({ ...place, ...fields, targetSlots: targets }).strict().superRefine(strobeHeld);
export const namedPadLayoutSchema = z.object({
  id: z.string().min(1).max(64), name: z.string().trim().min(1).max(80),
  pads: z.array(layoutEntrySchema).length(PAD_COUNT).superRefine(uniquePlaces),
  fixtureLabels: z.array(z.string().max(160)).max(1024),
}).strict().superRefine((layout, ctx) => {
  layout.pads.forEach((pad, index) => {
    if (Array.isArray(pad.targetSlots) && pad.targetSlots.some((slot) => slot >= layout.fixtureLabels.length)) {
      ctx.addIssue({ code: 'custom', path: ['pads', index, 'targetSlots'], message: 'target slot is outside the saved fixture order' });
    }
  });
});
