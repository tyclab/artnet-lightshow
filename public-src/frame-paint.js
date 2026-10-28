/**
 * Paint jobs run at most once per animation frame, however often they are asked
 * for: the DMX feed arrives at the engine's rate, and a view paints the latest
 * frame when the display is ready for it rather than on every message.
 */
export function createFrameQueue(request = (run) => requestAnimationFrame(run), cancelFrame = (handle) => cancelAnimationFrame(handle)) {
  const jobs = new Set();
  let handle = 0;
  const run = (now) => {
    handle = 0;
    const due = [...jobs];
    jobs.clear();
    for (const job of due) job(now);
  };
  return {
    schedule(job) {
      jobs.add(job);
      if (!handle) handle = request(run);
    },
    cancel(job) {
      jobs.delete(job);
      if (!jobs.size && handle) {
        cancelFrame(handle);
        handle = 0;
      }
    },
  };
}

export const frames = createFrameQueue();
