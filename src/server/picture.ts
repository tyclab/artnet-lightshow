import { randomUUID } from 'node:crypto';
import { nextVisualFrame, VISUAL_INPUT_MAX_FPS } from './visual-input-rate.ts';
import type { PictureFrame, PictureImage } from '../types/picture.ts';

export const PICTURE_TTL_MS = 2000;
export const PICTURE_MAX_FPS = VISUAL_INPUT_MAX_FPS;
/** The picture itself travels small: enough for a screen in the Stage, not a video feed. */
export const PICTURE_IMAGE_MAX = 128;

export interface PictureRig { signature: string; units: number }

interface Lease { leaseId: string; owner: string; signature: string; units: number; expiresAt: number; nextFrame: number; data: Uint8Array | null; image: PictureImage | null }

export class PictureInputError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new PictureInputError(code, message); };

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('INVALID', 'Expected an object');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key))) return refuse('INVALID', 'Unknown picture field');
  return value;
}

/** The small picture a sender samples from, copied; a screen in the Stage shows it. */
function pictureImage(raw: unknown): PictureImage {
  const value = record(raw, ['width', 'height', 'data']);
  const { width, height, data } = value;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1
    || (width as number) > PICTURE_IMAGE_MAX || (height as number) > PICTURE_IMAGE_MAX) return refuse('INVALID', `Expected a picture of at most ${PICTURE_IMAGE_MAX} x ${PICTURE_IMAGE_MAX}`);
  if (!(data instanceof Uint8Array) || data.byteLength !== (width as number) * (height as number) * 3) return refuse('INVALID', 'Expected exact RGB24 bytes for the picture');
  return { width: width as number, height: height as number, data: Uint8Array.from(data) };
}

/**
 * The room picture's single lease: one sender at a time paints every placed unit
 * from a picture sampled at the unit's plan position. The lease is bound to the
 * rig it was claimed against (its signature): a re-patched or re-placed rig ends it,
 * so a sender always samples the positions the renderer will read.
 */
export class PictureInput {
  private lease: Lease | null = null;
  private now: () => number;
  private armed: () => boolean;
  private acknowledged: () => boolean;
  private rig: () => PictureRig;
  constructor({ now = () => performance.now(), armed, acknowledged, rig }: {
    now?: () => number; armed: () => boolean; acknowledged: () => boolean; rig: () => PictureRig;
  }) { this.now = now; this.armed = armed; this.acknowledged = acknowledged; this.rig = rig; }

  private prune(): void {
    if (!this.lease) return;
    if (!this.armed() || !this.acknowledged()) { this.lease = null; return; }
    const current = this.rig();
    if (this.now() >= this.lease.expiresAt || current.signature !== this.lease.signature || current.units !== this.lease.units) this.lease = null;
  }
  claim(owner: string, raw: unknown) {
    this.prune();
    if (!this.armed()) return refuse('DISARMED', 'Outputs must already be armed');
    if (!this.acknowledged()) return refuse('ACKNOWLEDGEMENT_REQUIRED', 'Acknowledge photosensitivity before an external picture');
    const value = record(raw, ['signature']);
    const current = this.rig();
    if (typeof value.signature !== 'string' || value.signature !== current.signature) return refuse('STALE', 'The rig changed: fetch the units again');
    if (this.lease && this.lease.owner !== owner) return refuse('BUSY', 'The picture already has a sender');
    const lease = this.lease ?? { leaseId: randomUUID(), owner, signature: current.signature, units: current.units,
      expiresAt: this.now() + PICTURE_TTL_MS, nextFrame: -Infinity, data: null, image: null };
    this.lease = lease;
    return { ok: true as const, leaseId: lease.leaseId, units: lease.units, ttlMs: PICTURE_TTL_MS, maxFps: PICTURE_MAX_FPS, format: 'rgb24', order: 'units' };
  }
  private owned(owner: string, raw: unknown, frame: boolean): Lease {
    this.prune();
    const value = record(raw, frame ? ['leaseId', 'data', 'image'] : ['leaseId']);
    const lease = this.lease;
    if (!lease || lease.owner !== owner || lease.leaseId !== value.leaseId) return refuse('NO_LEASE', 'No matching live picture lease');
    return lease;
  }
  frame(owner: string, raw: unknown): { ok: true } {
    const lease = this.owned(owner, raw, true), data = (raw as { data?: unknown }).data;
    if (!(data instanceof Uint8Array) || data.byteLength !== lease.units * 3) return refuse('INVALID', 'Expected exact RGB24 bytes, one colour per unit');
    const now = this.now();
    const next = nextVisualFrame(now, lease.nextFrame);
    if (next === null) return refuse('RATE_LIMIT', `Picture frame rate exceeds ${PICTURE_MAX_FPS} fps`);
    const image = (raw as { image?: unknown }).image;
    const picture = image === undefined ? null : pictureImage(image);
    lease.data = Uint8Array.from(data); lease.nextFrame = next; lease.expiresAt = now + PICTURE_TTL_MS;
    if (picture) lease.image = picture;
    return { ok: true };
  }
  release(owner: string, raw: unknown): { ok: true } {
    this.owned(owner, raw, false); this.lease = null; return { ok: true };
  }
  disconnect(owner: string): void { if (this.lease?.owner === owner) this.lease = null; }
  clear(): void { this.lease = null; }
  status() {
    this.prune();
    const lease = this.lease;
    return lease ? { units: lease.units, remainingMs: Math.max(0, Math.ceil(lease.expiresAt - this.now())), receiving: lease.data !== null } : null;
  }
  /** The sender's picture, while its lease paints. */
  image(): PictureImage | null {
    this.prune();
    return this.lease && this.lease.data ? this.lease.image : null;
  }
  current(clockShift = 0): PictureFrame | null {
    this.prune();
    const lease = this.lease;
    return lease && lease.data ? { leaseId: lease.leaseId, signature: lease.signature, units: lease.units, expiresAt: lease.expiresAt + clockShift, data: lease.data } : null;
  }
}
