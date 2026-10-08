// Shared throwaway paths keyed by E2E_PORT for the server and browser tests.

import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT) || 3999;

export const E2E_DIR = path.join(os.tmpdir(), `lightshow-e2e-${PORT}`);
export const E2E_TRACK = path.join(E2E_DIR, 'track.wav');
