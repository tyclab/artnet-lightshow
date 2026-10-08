import { namedPadLayoutSchema } from '../shared/party-setup.ts';
import { HttpError } from '../errors.ts';
import { validate } from './validation.ts';
import type { NamedPadLayout, PadContent, PadEntry } from '../shared/party-setup.ts';

export interface LayoutFixture { id: number; label: string }

export function capturePadLayout(pads: readonly PadEntry[], fixtures: readonly LayoutFixture[], id: string, name: string): NamedPadLayout {
  const ids = fixtures.map((fixture) => fixture.id);
  const entries = pads.map(({ targets, ...pad }) => {
    const targetSlots = targets === 'shared' ? targets : targets.map((target) => {
      const slot = ids.indexOf(target);
      if (slot < 0) throw new HttpError(409, `Pad ${pad.bank + 1}:${pad.slot + 1} targets fixture ${target}, outside the current fixture order`);
      return slot;
    });
    return { ...pad, targetSlots };
  });
  return validate(namedPadLayoutSchema, { id, name, pads: entries, fixtureLabels: fixtures.map((fixture) => fixture.label) }, 'pad layout');
}

export function previewPadLayout(layout: NamedPadLayout, fixtures: readonly LayoutFixture[],
  contentExists: (content: PadContent) => boolean, requested?: (number | null)[]) {
  const known = new Set(fixtures.map((fixture) => fixture.id));
  const mapping = layout.fixtureLabels.map((_, slot) => requested ? requested[slot] ?? null : fixtures[slot]?.id ?? null);
  const missingSlots = new Set<number>();
  const missingContent: { bank: number; slot: number; id: string; label: string }[] = [];
  const pads = layout.pads.map(({ targetSlots, ...entry }): PadEntry => {
    const targets = targetSlots === 'shared' ? targetSlots : targetSlots.flatMap((slot) => {
      const target = mapping[slot];
      if (target === null || target === undefined || !known.has(target)) { missingSlots.add(slot); return []; }
      return [target];
    });
    if (entry.content && !contentExists(entry.content)) {
      missingContent.push({ bank: entry.bank, slot: entry.slot, id: entry.content.id, label: entry.label });
      return { ...entry, label: 'Empty', content: null, targets: 'shared' };
    }
    return { ...entry, targets };
  });
  return { pads, mapping, missingSlots: [...missingSlots], missingContent };
}
