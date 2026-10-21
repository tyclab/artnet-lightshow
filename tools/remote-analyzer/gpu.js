import { execFile } from 'node:child_process';

// WSL's own nvidia-smi: it sees the whole card, the Windows desktop's share of its memory included.
export const WSL_SMI = '/usr/lib/wsl/lib/nvidia-smi';

export function parseSmi(text) {
  const [name, total, used] = String(text).split('\n')[0].split(',').map((part) => part.trim());
  const totalMiB = Number(total), usedMiB = Number(used);
  if (!name || !Number.isFinite(totalMiB) || !Number.isFinite(usedMiB)) return null;
  return { name, totalMiB, usedMiB };
}

export function probeGpu({ smi = WSL_SMI, run = execFile } = {}) {
  return new Promise((resolve) => {
    run(smi, ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'],
      { timeout: 10_000, env: { ...process.env, LD_LIBRARY_PATH: '/usr/lib/wsl/lib' } }, (err, stdout) => {
        const parsed = err ? null : parseSmi(stdout);
        resolve(parsed ? { ok: true, ...parsed } : { ok: false, error: err ? err.message : 'unreadable nvidia-smi output' });
      });
  });
}
