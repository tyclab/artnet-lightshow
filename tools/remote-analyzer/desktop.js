import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// From WSL, Windows PowerShell through interop; on Windows, by its system path.
export function powershellPath(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform === 'win32') return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const wsl = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  return exists(wsl) ? wsl : null;
}

// Every five seconds until stdout breaks: whether the foreground window covers its whole monitor, its program,
// and SHQueryUserNotificationState (3 is an exclusive Direct3D fullscreen). C# so the geometry is one call.
export const PROBE_SCRIPT = [
  "Add-Type -Namespace LightshowAnalyzer -Name Desktop -MemberDefinition @'",
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }',
  '[DllImport("user32.dll")] static extern bool SetProcessDPIAware();',
  '[DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);',
  '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);',
  '[DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);',
  'public static void Aware() { SetProcessDPIAware(); }',
  'public static string Probe() {',
  '  int state; SHQueryUserNotificationState(out state);',
  '  IntPtr w = GetForegroundWindow(); uint pid = 0; bool full = false;',
  '  if (w != IntPtr.Zero) {',
  '    GetWindowThreadProcessId(w, out pid);',
  '    var cls = new System.Text.StringBuilder(64); GetClassName(w, cls, 64); string c = cls.ToString();',
  '    RECT r; var mi = new MONITORINFO(); mi.Size = Marshal.SizeOf(typeof(MONITORINFO));',
  '    if (c != "Progman" && c != "WorkerW" && GetWindowRect(w, out r) && GetMonitorInfo(MonitorFromWindow(w, 2), ref mi))',
  '      full = r.L <= mi.Monitor.L && r.T <= mi.Monitor.T && r.R >= mi.Monitor.R && r.B >= mi.Monitor.B;',
  '  }',
  '  return state + " " + (full ? 1 : 0) + " " + pid;',
  '}',
  "'@",
  '[LightshowAnalyzer.Desktop]::Aware()',
  'while ($true) {',
  "  $p = [LightshowAnalyzer.Desktop]::Probe().Split(' ')",
  "  $app = ''; try { $app = (Get-Process -Id ([int]$p[2]) -ErrorAction Stop).ProcessName } catch {}",
  "  $line = @{ state = [int]$p[0]; fullscreen = ($p[1] -eq '1'); app = $app } | ConvertTo-Json -Compress",
  '  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch { exit }',
  '  Start-Sleep -Seconds 5',
  '}',
].join('\n');

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED on the thread that asked, held until stdin reaches EOF.
export const HOLD_SCRIPT = [
  "Add-Type -Namespace LightshowAnalyzer -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] static extern uint SetThreadExecutionState(uint flags);"
    + " public static bool Hold() { return SetThreadExecutionState(0x80000001u) != 0; }'",
  'if (-not [LightshowAnalyzer.Power]::Hold()) { exit 1 }',
  "[Console]::Out.WriteLine('held'); [Console]::Out.Flush()",
  '$null = [Console]::In.ReadToEnd()',
].join('\n');

export function powershell(script, { exe = powershellPath(), start = spawn } = {}) {
  if (!exe) throw new Error('Windows PowerShell is not reachable from here');
  return start(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, cwd: exe.startsWith('/mnt/') ? '/mnt/c' : undefined });
}

const D3D_FULLSCREEN = 3;

/**
 * The fullscreen program that should keep the GPU to itself, or null. The notification state alone cannot say:
 * the party browser fullscreen on another screen makes it "busy" whatever is in front, so the foreground window
 * decides, and the allowed programs (that browser) never block.
 */
export function blockingApp(reading, allow) {
  if (!reading) return null;
  const app = String(reading.app || '').toLowerCase();
  if (reading.state !== D3D_FULLSCREEN && !(reading.fullscreen && !allow.includes(app))) return null;
  return app || 'a fullscreen program';
}

/** The desktop as the probe last saw it; null while it is unknown, which blocks nothing. */
export class DesktopWatch {
  constructor({ start = () => powershell(PROBE_SCRIPT), now = () => Date.now(), log = () => {}, retryMs = 30_000, staleMs = 20_000 } = {}) {
    Object.assign(this, { start, now, log, retryMs, staleMs });
    this.child = null; this.reading = null; this.stopped = false; this.warned = false; this.timer = null;
  }
  run() {
    if (this.stopped) return;
    let child, buffer = '';
    try { child = this.start(); } catch (err) { this.failed(err); return; }
    this.child = child;
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        try {
          const { state, fullscreen, app } = JSON.parse(line);
          if (Number.isInteger(state)) {
            this.reading = { state, fullscreen: fullscreen === true, app: typeof app === 'string' ? app : '', at: this.now() };
            this.warned = false;
          }
        } catch {}
      }
    });
    const gone = (err) => { if (this.child === child) { this.child = null; this.failed(err); } };
    child.on('error', gone); child.on('exit', () => gone(null));
  }
  failed(err) {
    if (this.stopped) return;
    if (!this.warned) { this.warned = true; this.log(`Desktop probe unavailable${err ? `: ${err.message}` : ''}; fullscreen programs cannot be seen, retrying`); }
    this.timer = setTimeout(() => this.run(), this.retryMs);
    this.timer.unref?.();
  }
  latest() {
    return this.reading && this.now() - this.reading.at < this.staleMs ? this.reading : null;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try { this.child?.kill(); } catch {}
  }
}

/** Keeps Windows from sleeping while a job runs: the PC is the operator's desktop, idle at a party. */
export class SystemHold {
  constructor({ start = () => powershell(HOLD_SCRIPT), log = () => {} } = {}) {
    Object.assign(this, { start, log });
    this.child = null; this.held = false; this.warned = false;
  }
  acquire() {
    if (this.child) return;
    let child;
    try { child = this.start(); } catch (err) { this.unavailable(err); return; }
    this.child = child;
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk) => { if (this.child === child && String(chunk).includes('held')) this.held = true; });
    const gone = () => { if (this.child === child) { this.child = null; this.held = false; } };
    child.on('error', (err) => { gone(); this.unavailable(err); });
    child.on('exit', gone);
  }
  unavailable(err) {
    if (!this.warned) { this.warned = true; this.log(`Cannot keep Windows awake during jobs: ${err.message}`); }
  }
  release() {
    const child = this.child;
    this.child = null; this.held = false;
    try { child?.stdin?.destroy(); child?.kill(); } catch {}
  }
}
