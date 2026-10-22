import { HardwareGuard } from './hardware-guard.ts';
import type { LightMeasure } from './hardware-guard.ts';
import type { RateLimits } from './hardware.ts';
import type { Colour } from '../types/rig.ts';
import { HdFlashGuard, StrobeLampGuard } from './effects/flash-guard.ts';
import { hdGuarded } from './effects/layer.ts';
import { STROBE_FRAME_MS } from './effects/strobe.ts';
import { createFlashLimiter } from './flash-limit.ts';

// One output policy owns device, effect and room history across every voice handover.
export class OutputGuard {
  private hardware = new HardwareGuard();
  private emitted = new HardwareGuard();
  private nativeStrobe = new HardwareGuard();
  private party: HdFlashGuard;
  private intervalMs: number;
  private strobe = new StrobeLampGuard();
  private room = createFlashLimiter();
  private permits = new Map<number | string, { level: number; rises: number[]; guardedUntil: number; lastSeen: number }>();
  private nextSweep = -Infinity;

  constructor(intervalMs: number) { this.intervalMs = intervalMs; this.party = new HdFlashGuard(intervalMs); }

  get retainedEffectUnits(): number { return this.permits.size; }

  setInterval(intervalMs: number): void { this.party.setInterval(intervalMs); this.intervalMs = intervalMs; }

  light(id: string, colour: Colour, dim: number, now: number, limits: RateLimits, owner: string,
    immediateBlack = false): { colour: Colour; dim: number } {
    return this.hardware.light(id, colour, dim, now, limits, owner, immediateBlack);
  }

  measuredLight(id: string, colour: Colour, dim: number, now: number, limits: RateLimits, owner: string,
    immediateBlack: boolean, measure: LightMeasure, scale = 1): { colour: Colour; dim: number } {
    return this.emitted.light(id, colour, dim, now, limits, owner, immediateBlack, measure, scale);
  }

  nativeLevel(id: string, level: number, now: number, limits: RateLimits, cycle?: number): number {
    return this.nativeStrobe.apply(id, level, now, limits, cycle);
  }

  effectLevel(unit: number | string, dim: number, scale: number, kind: string | null | undefined, now: number): number {
    if (now >= this.nextSweep) {
      this.nextSweep = now + 1000;
      for (const [key, history] of this.permits) if (now - history.lastSeen > Math.max(1000, this.intervalMs)) {
        this.party.forget(key); this.strobe.forget(key); this.permits.delete(key);
      }
    }
    if (hdGuarded(kind)) {
      if (this.party.apply(unit, dim / 255 * scale, now) === 0) dim = 0;
    } else this.party.clear(unit);
    if (kind === 'strobe' || kind === 'strobe.program') {
      const allowed = this.strobe.apply(unit, dim / 255, now / STROBE_FRAME_MS, kind === 'strobe.program');
      dim = Math.min(dim, allowed * 255);
    } else this.strobe.clear(unit);
    let history = this.permits.get(unit);
    if (!history) { history = { level: 0, rises: [], guardedUntil: -Infinity, lastSeen: now }; this.permits.set(unit, history); }
    history.lastSeen = now;
    if (kind?.startsWith('v2.') || hdGuarded(kind) && this.intervalMs > 0 || kind === 'strobe' || kind === 'strobe.program') history.guardedUntil = now + 1000;
    const threshold = hdGuarded(kind) ? 0.55 : 0.15;
    while (history.rises.length && now - history.rises[0] >= 1000 - 1e-6) history.rises.shift();
    const bright = dim / 255 * scale > threshold;
    if (bright && history.level <= threshold) {
      if (now < history.guardedUntil && history.rises.length >= 5) dim = 0;
      else history.rises.push(now);
    }
    history.level = dim / 255 * scale;
    return dim;
  }

  targetRoom(luminance: number, now: number): number { return this.room.target(luminance, now); }
  commitRoom(luminance: number, now: number): void { this.room.commit(luminance, now); }
  resetRoom(): void { this.room.reset(); }

  retain(ids: ReadonlySet<string>): void {
    this.hardware.retain(ids);
  }

  retainEmitted(ids: ReadonlySet<string>): void { this.emitted.retain(ids); }
  retainNative(ids: ReadonlySet<string>): void { this.nativeStrobe.retain(ids); }

  retainEffects(ids: ReadonlySet<number | string>): void {
    for (const [unit, history] of this.permits) if (!ids.has(unit)) {
      this.party.clear(unit); this.strobe.clear(unit); history.level = 0;
    }
  }

  blackout(): void {
    this.hardware.blackout(); this.emitted.blackout(); this.nativeStrobe.blackout();
    for (const unit of this.permits.keys()) {
      this.party.clear(unit); this.strobe.clear(unit);
      const permit = this.permits.get(unit);
      if (permit) permit.level = 0;
    }
  }

  resetEffects(): void { this.party.reset(); this.strobe.reset(); this.permits.clear(); this.nextSweep = -Infinity; }

  clone(): OutputGuard {
    const copy = new OutputGuard(this.intervalMs);
    copy.hardware = this.hardware.clone(); copy.emitted = this.emitted.clone(); copy.nativeStrobe = this.nativeStrobe.clone();
    copy.party = this.party.clone(); copy.strobe = this.strobe.clone(); copy.room = this.room.clone();
    copy.permits = new Map([...this.permits].map(([unit, state]) => [unit, { ...state, rises: [...state.rises] }]));
    copy.nextSweep = this.nextSweep;
    return copy;
  }
}
