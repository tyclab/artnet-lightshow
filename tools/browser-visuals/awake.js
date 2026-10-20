import { spawn } from 'node:child_process';
import path from 'node:path';

// A display-required request lives on the thread that made it, so the child holds it until its stdin reaches EOF.
// That pipe closes with this helper however it ends, a crash included, so a holder cannot outlive it.
export const HOLD_SCRIPT = [
  `Add-Type -Namespace PartyVisuals -Name Power -MemberDefinition '[DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);`
    + ` public static bool Hold() { return SetThreadExecutionState(0x80000002u) != 0; }'`,
  'if (-not [PartyVisuals.Power]::Hold()) { exit 1 }',
  "[Console]::Out.WriteLine('held'); [Console]::Out.Flush()",
  '$null = [Console]::In.ReadToEnd()',
].join('\n');

/** Windows PowerShell by its system path; hidden, so no console window opens over the visuals. */
export function holdProcess(script = HOLD_SCRIPT, env = process.env, start = spawn) {
  const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return start(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
}

/**
 * Keeps the show PC's displays on while the lightshow reports armed outputs. The monitors' USB lighting
 * disappears from OpenRGB when they sleep, and at a party nobody touches the PC to wake them.
 */
export class DisplayHold {
  constructor({ spawn: start = () => holdProcess(), log = () => {}, now = () => performance.now(), releaseAfterMs = 10_000, retryMs = 30_000 } = {}) {
    Object.assign(this, { start, log, now, releaseAfterMs, retryMs });
    this.child = null; this.held = false; this.stopped = false; this.warned = false; this.armedAt = -Infinity; this.retryAt = 0;
  }
  update(armed) {
    if (this.stopped) return;
    const now = this.now();
    if (armed) this.armedAt = now;
    if (armed && !this.child && now >= this.retryAt) this.acquire();
    // One timed-out state sync resets the mirror; only a lasting disarm or outage lets the displays sleep.
    else if (!armed && this.child && now - this.armedAt >= this.releaseAfterMs) this.release();
  }
  acquire() {
    let child;
    try { child = this.start(); } catch { this.failed(); return; }
    this.child = child;
    let output = '';
    const gone = () => { if (this.child === child) { this.child = null; this.failed(); } };
    child.on('error', gone); child.on('exit', gone);
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', chunk => {
      output = (output + chunk).slice(-16);
      if (this.child !== child || this.held || !output.includes('held')) return;
      this.held = true; this.warned = false;
      this.log('Displays kept awake while outputs are armed');
    });
  }
  failed() {
    this.retryAt = this.now() + this.retryMs;
    if (this.held) { this.held = false; this.log('Display keep-awake ended unexpectedly; retrying'); }
    else if (!this.warned) { this.warned = true; this.log('Display keep-awake unavailable; retrying'); }
  }
  release() {
    const child = this.child;
    this.child = null;
    try { child.stdin?.destroy(); child.kill(); } catch {}
    if (this.held) { this.held = false; this.log('Displays may sleep again'); }
  }
  stop() { this.stopped = true; if (this.child) this.release(); }
}

export function displayHold(log, platform = process.platform) {
  return platform === 'win32' ? new DisplayHold({ log }) : null;
}
