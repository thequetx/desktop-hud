import { useEffect, useRef, useState } from 'react';

/**
 * Lean idle (the owner's call, 2026-10-15, option A): the HUD's decorative loops (the
 * Now playing equaliser, the cat's ripple) play for a few seconds after
 * something changes, then hold still. An endless CSS animation keeps
 * Chromium's frame loop running at the monitor's refresh rate (180 Hz on the
 * HUD monitor), which cost a quarter of a core at idle (Bug Log #62); a still
 * HUD costs about 1%.
 *
 * "Something changes" is whatever the caller folds into the key: a new track,
 * play/pause, the HUD being shown again, a block going imminent.
 */
export const LIVELY_MS = 8_000;

/**
 * Until when the HUD stays lively, given the key it last saw. A changed key
 * opens a fresh window from `now`; the same key keeps the current one.
 */
export function livelyUntil(prevKey: string | null, nextKey: string, now: number, until: number): number {
  return prevKey === nextKey ? until : now + LIVELY_MS;
}

/** True for LIVELY_MS after `key` changes (and after mount), then false. */
export function useLively(key: string): boolean {
  const last = useRef<{ key: string | null; until: number }>({ key: null, until: 0 });
  const [lively, setLively] = useState(true);
  useEffect(() => {
    const now = Date.now();
    const until = livelyUntil(last.current.key, key, now, last.current.until);
    last.current = { key, until };
    if (until <= now) {
      setLively(false);
      return;
    }
    setLively(true);
    const id = window.setTimeout(() => setLively(false), until - now);
    return () => window.clearTimeout(id);
  }, [key]);
  return lively;
}
