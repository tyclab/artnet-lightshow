export const VISUAL_INPUT_MAX_FPS = 60;
export const VISUAL_INPUT_MESSAGE_BUDGET = VISUAL_INPUT_MAX_FPS * 2 + 32;
const PERIOD_MS = 1000 / VISUAL_INPUT_MAX_FPS;

// Allow half a frame of arrival jitter, without accumulating credit or queued frames.
export function nextVisualFrame(now: number, previous: number): number | null {
  return now < previous - PERIOD_MS / 2 ? null : Math.max(now, previous) + PERIOD_MS;
}
