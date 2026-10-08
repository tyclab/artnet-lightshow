import { canonical } from '../shared/effects/layer.ts';
import type { Sequence } from './sequencer.ts';

export class SequenceHistory {
  private back: string[] = [];
  private forward: string[] = [];
  private limit: number;
  private byteLimit: number;

  constructor(limit = 50, byteLimit = 16 * 1024 * 1024) {
    this.limit = limit;
    this.byteLimit = byteLimit;
  }

  clear(): void { this.back = []; this.forward = []; }

  status(): { canUndo: boolean; canRedo: boolean } {
    return { canUndo: this.back.length > 0, canRedo: this.forward.length > 0 };
  }

  peek(direction: 'undo' | 'redo'): Sequence | null {
    const json = (direction === 'undo' ? this.back : this.forward).at(-1);
    return json ? JSON.parse(json) as Sequence : null;
  }

  commit(before: Sequence | null, after: Sequence, replay?: 'undo' | 'redo'): void {
    if (!before || before.id !== after.id) { this.clear(); return; }
    const json = canonical(before);
    if (json === canonical(after)) return;
    if (replay === 'undo') { this.back.pop(); this.forward.push(json); }
    else if (replay === 'redo') { this.forward.pop(); this.back.push(json); }
    else { this.back.push(json); this.forward = []; }
    this.trim(this.back);
    this.trim(this.forward);
  }

  private trim(stack: string[]): void {
    let bytes = stack.reduce((sum, json) => sum + Buffer.byteLength(json), 0);
    while (stack.length > this.limit || bytes > this.byteLimit) bytes -= Buffer.byteLength(stack.shift()!);
  }
}
