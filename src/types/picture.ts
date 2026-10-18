/** One picture over the whole rig: an RGB colour per rig unit, sampled by a sender at each
 * unit's plan position. Matrix fixtures keep their own pixel input; their units are ignored. */
export interface PictureFrame {
  leaseId: string;
  /** The rig signature the sender sampled against; a frame for another rig is dropped. */
  signature: string;
  units: number;
  expiresAt: number;
  data: Uint8Array;
}
