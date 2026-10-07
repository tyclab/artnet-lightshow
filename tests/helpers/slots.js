export const slotToWrite = (slot) => ({ colour: slot.colour, dim: Math.round(255 * slot.level), strobe: slot.strobe ?? 0 });
