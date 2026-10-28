import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { dmxSig, wantDmx } from './state.js';
import { frames } from './frame-paint.js';

export function useDmxFeed(active = true) {
  useEffect(() => (active ? wantDmx() : undefined), [active]);
}

/**
 * Paint what follows the DMX feed without rendering for it: after every render
 * and, while `live`, once per animation frame in which a DMX frame arrived.
 * `paint` reads the feed with dmxSig.peek().
 */
export function useDmxPaint(paint, live = true) {
  const latest = useRef(paint);
  latest.current = paint;
  const job = useMemo(() => () => latest.current(), []);
  useLayoutEffect(() => {
    frames.cancel(job);
    latest.current();
  });
  useEffect(() => {
    if (!live) return undefined;
    const stop = effect(() => {
      dmxSig.value;
      frames.schedule(job);
    });
    return () => { stop(); frames.cancel(job); };
  }, [live]);
}
