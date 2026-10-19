import { maximumFlashHz } from './hardware.ts';
import type { Colour } from '../types/rig.ts';
import type { RateLimits } from './hardware.ts';

export type LightMeasure = (colour: Colour, dim: number, scale: number) => number;

interface History { bright: boolean; lastRise: number; level: number; time: number; colour?: Colour; owner?: string }
const peakOf = (colour: Colour) => Math.max(colour.r, colour.g, colour.b, colour.w || 0, colour.a || 0, colour.uv || 0) / 255;

// This history belongs to an output unit, surviving preset and voice handovers.
export class HardwareGuard {
  private history = new Map<string, History>();

  apply(id: string, level: number, now: number, limits: RateLimits): number {
    let held = this.history.get(id);
    if (!held || now < held.time) {
      held = { bright: false, lastRise: -Infinity, level: 0, time: now - 1000 / 44 };
      this.history.set(id, held);
    }
    const bright = level > 0.15;
    const rising = bright && !held.bright;
    const interval = 1000 / maximumFlashHz(limits);
    if (rising && now - held.lastRise < interval - 1e-6) level = Math.min(level, held.level);
    else if (rising) held.lastRise = now;
    const delta = limits.minTransitionMs > 0 ? Math.max(0, now - held.time) / limits.minTransitionMs : 1;
    const next = Math.max(held.level - delta, Math.min(held.level + delta, level));
    held.bright = level > 0.15; held.level = next; held.time = now;
    return next;
  }

  light(id: string, colour: Colour, dim: number, now: number, limits: RateLimits,
    owner: string, immediateBlack = false, measure?: LightMeasure, scale = 1): { colour: Colour; dim: number } {
    const requested = measure ? measure(colour, dim, scale) : dim / 255 * peakOf(colour);
    const previous = this.history.get(id);
    if (previous && (immediateBlack || previous.owner !== owner)) {
      previous.colour = undefined;
      previous.level = immediateBlack ? 0 : Math.min(previous.level, requested);
      previous.bright = !immediateBlack && previous.bright && requested > .15;
    }
    if (measure) return this.measuredLight(id, colour, dim, requested, now, limits, owner, immediateBlack, measure, scale);
    const allowed = this.apply(id, immediateBlack ? 0 : requested, now, limits);
    const held = this.history.get(id)!;
    held.owner = owner;
    if (immediateBlack) { held.level = 0; held.colour = undefined; return { colour, dim: 0 }; }
    if (requested > 0) {
      held.colour = { ...colour };
      return { colour, dim: Math.abs(allowed - requested) < 1e-12 ? dim : Math.min(255, dim * allowed / requested) };
    }
    // Only the same owner's ordinary off-frame may retain a visible fading tail.
    return held.colour && allowed > 0 ? { colour: held.colour, dim: Math.min(255, 255 * allowed / peakOf(held.colour)) } : { colour, dim: 0 };
  }

  private measuredLight(id: string, colour: Colour, dim: number, requested: number, now: number,
    limits: RateLimits, owner: string, immediateBlack: boolean, measure: LightMeasure, scale: number): { colour: Colour; dim: number } {
    let held = this.history.get(id);
    if (!held || now < held.time) {
      held = { bright: false, lastRise: -Infinity, level: 0, time: now - 1000 / 44 };
      this.history.set(id, held);
    }
    const delta = limits.minTransitionMs > 0 ? Math.max(0, now - held.time) / limits.minTransitionMs : 1;
    let allowed = Math.max(held.level - delta, Math.min(held.level + delta, requested));
    if (immediateBlack) allowed = 0;
    else if (allowed > .15 && !held.bright && now - held.lastRise < 1000 / maximumFlashHz(limits) - 1e-6) allowed = Math.min(allowed, held.level);
    const outputColour = requested > 0 ? colour : held.colour ?? colour;
    const outputDim = allowed <= 0 ? 0 : requested > 0 && Math.abs(allowed - requested) < 1e-12 ? dim
      : this.measuredDim(outputColour, allowed, measure, scale);
    const level = measure(outputColour, outputDim, scale), bright = level > .15;
    // Record the quantized wire crossing, after transitions and colour mixing.
    if (bright && !held.bright) held.lastRise = now;
    held.level = level; held.bright = bright; held.time = now; held.owner = owner;
    if (immediateBlack) held.colour = undefined;
    else if (requested > 0) held.colour = { ...colour };
    return { colour: outputColour, dim: outputDim };
  }

  // Clipped RGB+white mixes are nonlinear: an allowed/requested ratio can still overshoot.
  private measuredDim(colour: Colour, allowed: number, measure: LightMeasure, scale: number): number {
    let low = 0, high = 255;
    for (let k = 0; k < 12; k++) {
      const mid = (low + high) / 2;
      if (measure(colour, mid, scale) <= allowed + 1e-12) low = mid;
      else high = mid;
    }
    return low;
  }

  blackout(): void {
    for (const entry of this.history.values()) { entry.level = 0; entry.bright = false; entry.colour = undefined; }
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id);
  }

  clone(): HardwareGuard {
    const copy = new HardwareGuard();
    copy.history = new Map([...this.history].map(([id, value]) => [id, { ...value, colour: value.colour && { ...value.colour } }]));
    return copy;
  }
}
