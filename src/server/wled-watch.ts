// DDP is never answered, so a WLED in live override takes the stream into the void: ask it.

import { logger } from './log.ts';
import { wledLive } from './wled.ts';
import { messageOf } from '../errors.ts';
import type { Logger } from 'pino';
import type { Fixture } from '../types/rig.ts';
import type { WledLive } from './wled.ts';

export type WledStreamStatus = 'checking' | 'live' | 'override' | 'not-live' | 'unreachable';

export interface WledBoard {
  host: string;
  fixtures: { id: number; label: string }[];
}

/** What /api/state and /api/health carry per patched WLED while armed; it changes only on a transition. */
export interface WledBoardStatus {
  host: string;
  fixtures: number[];
  status: WledStreamStatus;
  lor: number | null;
  live: boolean | null;
  problem: string | null;
}

export interface WledWatchDeps {
  boards: () => WledBoard[];
  armed: () => boolean;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  now?: () => number;
  log?: Pick<Logger, 'info' | 'warn'>;
}

export interface WledWatch {
  tick(): Promise<void>;
  status(): WledBoardStatus[];
  start(): void;
  stop(): void;
}

interface Entry {
  status: WledStreamStatus;
  said: WledStreamStatus | null;
  reading: WledLive | null;
  error: string | null;
  failures: number;
  notLive: number;
  nextAt: number;
  inFlight: boolean;
}

const INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
// Two in a row: one miss or one quiet reading right after arming is not a fault.
const CONFIRM = 2;
const keyOf = (host: string) => host.toLowerCase();

function wledBoards(fixtures: readonly Pick<Fixture, 'id' | 'label' | 'output'>[]): WledBoard[] {
  const boards = new Map<string, WledBoard>();
  for (const fix of fixtures) {
    if (fix.output?.protocol !== 'ddp') continue;
    const key = keyOf(fix.output.host);
    const board = boards.get(key) || { host: fix.output.host, fixtures: [] };
    board.fixtures.push({ id: fix.id, label: fix.label });
    boards.set(key, board);
  }
  return [...boards.values()];
}

function who(board: WledBoard): string {
  return `${board.fixtures.map((f) => `"${f.label}"`).join(', ')} at ${board.host}`;
}

function problemOf(board: WledBoard, entry: Entry): string | null {
  if (entry.status === 'override') return `${who(board)}: WLED live override active (lor ${entry.reading?.lor}) — the board ignores the show`;
  if (entry.status === 'not-live') return `${who(board)}: WLED answers but is not taking the stream (live false) — the board ignores the show`;
  if (entry.status === 'unreachable') return `${who(board)}: WLED does not answer (${entry.error})`;
  return null;
}

function createWledWatch({ boards, armed, fetchImpl = fetch, intervalMs = INTERVAL_MS, now = () => performance.now(),
  log = logger('wled') }: WledWatchDeps): WledWatch {
  let entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const fresh = (): Entry => ({ status: 'checking', said: null, reading: null, error: null, failures: 0, notLive: 0, nextAt: 0, inFlight: false });

  function nextStatus(entry: Entry, reading: WledLive | null): WledStreamStatus {
    if (!reading) return entry.failures >= CONFIRM ? 'unreachable' : entry.status;
    if (reading.lor !== 0) return 'override';
    if (reading.live !== false) return 'live';
    if (entry.notLive >= CONFIRM) return 'not-live';
    return entry.status === 'live' ? 'live' : 'checking';
  }

  function settle(board: WledBoard, entry: Entry, reading: WledLive | null): void {
    entry.notLive = reading && reading.lor === 0 && reading.live === false ? entry.notLive + 1 : 0;
    if (reading) entry.reading = reading;
    entry.status = nextStatus(entry, reading);
    const problem = problemOf(board, entry);
    const fields = () => ({ host: board.host, fixtures: board.fixtures.map((f) => f.id), status: entry.status, lor: entry.reading?.lor ?? null, live: entry.reading?.live ?? null });
    if (problem && entry.said !== entry.status) {
      entry.said = entry.status;
      log.warn(fields(), problem);
    } else if (entry.status === 'live' && entry.said) {
      entry.said = null;
      log.info(fields(), `${who(board)}: WLED takes the show again`);
    }
  }

  async function poll(board: WledBoard, entry: Entry): Promise<void> {
    entry.inFlight = true;
    let reading: WledLive | null = null;
    try {
      reading = await wledLive(board.host, { fetchImpl });
      entry.failures = 0;
      entry.error = null;
    } catch (err) {
      entry.failures++;
      entry.error = messageOf(err);
      entry.nextAt = now() + Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** entry.failures);
    } finally {
      entry.inFlight = false;
    }
    if (entries.get(keyOf(board.host)) === entry) settle(board, entry, reading);
  }

  async function tick(): Promise<void> {
    if (!armed()) {
      entries = new Map();
      return;
    }
    const wanted = boards();
    const kept = new Map<string, Entry>();
    const polls: Promise<void>[] = [];
    for (const board of wanted) {
      const key = keyOf(board.host);
      const entry = entries.get(key) || fresh();
      kept.set(key, entry);
      if (!entry.inFlight && now() >= entry.nextAt) polls.push(poll(board, entry));
    }
    entries = kept;
    await Promise.all(polls);
  }

  function status(): WledBoardStatus[] {
    if (!armed()) return [];
    return boards().map((board) => {
      const entry = entries.get(keyOf(board.host)) || fresh();
      const reading = entry.status === 'unreachable' ? null : entry.reading;
      return {
        host: board.host, fixtures: board.fixtures.map((f) => f.id), status: entry.status,
        lor: reading ? reading.lor : null, live: reading ? reading.live : null, problem: problemOf(board, entry),
      };
    });
  }

  return {
    tick,
    status,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((err) => log.warn({}, `watch failed: ${messageOf(err)}`)); }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      entries = new Map();
    },
  };
}

let current: WledWatch | null = null;

function startWledWatch(deps: WledWatchDeps): WledWatch {
  current?.stop();
  current = createWledWatch(deps);
  current.start();
  return current;
}

function stopWledWatch(): void {
  current?.stop();
  current = null;
}

function wledStatus(): WledBoardStatus[] {
  return current ? current.status() : [];
}

export {
  createWledWatch,
  startWledWatch,
  stopWledWatch,
  wledStatus,
  wledBoards,
};
