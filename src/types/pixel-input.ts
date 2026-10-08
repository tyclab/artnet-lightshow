export interface PixelInputFrame {
  fixtureId: number;
  leaseId: string;
  width: number;
  height: number;
  expiresAt: number;
  data: Uint8Array;
}
