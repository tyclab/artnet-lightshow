import { randomUUID } from 'node:crypto';
import { MAX_CELLS_PER_FIXTURE } from '../shared/rig.ts';
import type { Profile } from '../types/rig.ts';
import type { PixelInputFrame } from '../types/pixel-input.ts';

export const PIXEL_INPUT_TTL_MS = 2000;
export const PIXEL_INPUT_MAX_FPS = 20;
export interface PixelTarget { profile: Profile; outputKey: string }
interface Lease extends Omit<PixelInputFrame, 'data'> {
  owner: string;
  target: PixelTarget;
  lastFrame: number;
  data: Uint8Array | null;
}
export class PixelInputError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new PixelInputError(code, message); };
function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('INVALID', 'Expected an object');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key))) return refuse('INVALID', 'Unknown pixel-input field');
  return value;
}
function fixtureId(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return refuse('INVALID', 'Invalid fixture id');
  return raw;
}
function geometry(profile: Profile, width: unknown, height: unknown): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) return false;
  const n = (width as number) * (height as number), grid = profile.grid, cells = profile.cells;
  if (n > MAX_CELLS_PER_FIXTURE || !grid || profile.zoned || grid.columns !== width || grid.rows !== height || cells?.length !== n) return false;
  const taken = new Set<number>();
  return cells.every((cell, i) => {
    const { x, y } = cell.at ?? { x: i % grid.columns, y: Math.floor(i / grid.columns) };
    const at = y * grid.columns + x, ch = cell.channelMap;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= grid.columns || y < 0 || y >= grid.rows || taken.has(at)
      || ch.red === undefined || ch.green === undefined || ch.blue === undefined) return false;
    taken.add(at); return true;
  });
}

export class PixelInputs {
  private leases = new Map<number, Lease>();
  private now: () => number;
  private armed: () => boolean;
  private acknowledged: () => boolean;
  private target: (id: number) => PixelTarget | null;
  constructor({ now = () => performance.now(), armed, acknowledged, target }: {
    now?: () => number; armed: () => boolean; acknowledged: () => boolean; target: (id: number) => PixelTarget | null;
  }) { this.now = now; this.armed = armed; this.acknowledged = acknowledged; this.target = target; }

  private prune(): void {
    if (!this.armed() || !this.acknowledged()) { this.clear(); return; }
    const now = this.now();
    for (const [id, lease] of this.leases) {
      const current = this.target(id);
      if (now >= lease.expiresAt || !current || current.profile !== lease.target.profile || current.outputKey !== lease.target.outputKey) this.leases.delete(id);
    }
  }
  claim(owner: string, raw: unknown) {
    this.prune();
    if (!this.armed()) return refuse('DISARMED', 'Outputs must already be armed');
    if (!this.acknowledged()) return refuse('ACKNOWLEDGEMENT_REQUIRED', 'Acknowledge photosensitivity before external pixel input');
    const value = record(raw, ['fixtureId', 'width', 'height']), id = fixtureId(value.fixtureId);
    const target = this.target(id);
    if (!target || !geometry(target.profile, value.width, value.height)) return refuse('INVALID', 'Expected a full RGB DDP grid matching the fixture');
    const current = this.leases.get(id);
    if (current && current.owner !== owner) return refuse('BUSY', 'Fixture already has a pixel-input owner');
    const lease = current ?? { fixtureId: id, leaseId: randomUUID(), owner, target, width: value.width as number, height: value.height as number,
      expiresAt: this.now() + PIXEL_INPUT_TTL_MS, lastFrame: -Infinity, data: null };
    this.leases.set(id, lease);
    return { ok: true as const, leaseId: lease.leaseId, ttlMs: PIXEL_INPUT_TTL_MS, maxFps: PIXEL_INPUT_MAX_FPS, format: 'rgb24', order: 'row-major' };
  }
  private owned(owner: string, raw: unknown, frame: boolean): Lease {
    this.prune();
    const value = record(raw, frame ? ['fixtureId', 'leaseId', 'data'] : ['fixtureId', 'leaseId']);
    const lease = this.leases.get(fixtureId(value.fixtureId));
    if (!lease || lease.owner !== owner || lease.leaseId !== value.leaseId) return refuse('NO_LEASE', 'No matching live pixel-input lease');
    return lease;
  }
  frame(owner: string, raw: unknown): { ok: true } {
    const lease = this.owned(owner, raw, true), data = (raw as { data?: unknown }).data;
    if (!(data instanceof Uint8Array) || data.byteLength !== lease.width * lease.height * 3) return refuse('INVALID', 'Expected exact RGB24 binary bytes');
    const now = this.now();
    if (now - lease.lastFrame < 1000 / PIXEL_INPUT_MAX_FPS) return refuse('RATE_LIMIT', 'Pixel frame rate exceeds 20 fps');
    lease.data = Uint8Array.from(data); lease.lastFrame = now; lease.expiresAt = now + PIXEL_INPUT_TTL_MS;
    return { ok: true };
  }
  release(owner: string, raw: unknown): { ok: true } {
    const lease = this.owned(owner, raw, false); this.leases.delete(lease.fixtureId); return { ok: true };
  }
  disconnect(owner: string): void { for (const [id, lease] of this.leases) if (lease.owner === owner) this.leases.delete(id); }
  clear(): void { this.leases.clear(); }
  status() {
    this.prune();
    return [...this.leases.values()].map(({ fixtureId, width, height, expiresAt, data }) => ({ fixtureId, width, height,
      remainingMs: Math.max(0, Math.ceil(expiresAt - this.now())), receiving: data !== null }));
  }
  frames(clockShift = 0): PixelInputFrame[] {
    this.prune();
    return [...this.leases.values()].flatMap((lease) => lease.data ? [{ fixtureId: lease.fixtureId, leaseId: lease.leaseId,
      width: lease.width, height: lease.height, expiresAt: lease.expiresAt + clockShift, data: lease.data }] : []);
  }
}
