import { useEffect, useRef, useState } from 'react';
import type { Streak } from '../lib/streaks';
import { hitMap, newlyHit } from '../lib/extras';

/** A target hit within this long of the bubble appearing is the data arriving,
 *  not the moment it happened — no wipe for it. */
const SETTLE_MS = 10_000;
/** How long the gold wipe runs (keep in step with base.css .streaks__wipe). */
const WIPE_MS = 1_400;

interface Props {
  streaks: Streak[];
  /** Extras: weeks in a row on target, by kind; null draws no LV. */
  levels?: Record<string, number> | null;
  /** Extras: play the one-time gold wipe when a target is hit. */
  celebrate?: boolean;
}

export function Streaks({ streaks, levels = null, celebrate = false }: Props) {
  const wipe = useHitWipe(streaks, celebrate);
  if (streaks.length === 0) return null;
  return (
    <div className="streaks">
      {streaks.map((s) => (
        <div key={s.kind} className={s.target > 0 && s.done >= s.target ? "streak is-hit" : "streak"}>
          <span className="streak__label q-label">{s.label}</span>
          <span className="streak__bar">
            {Array.from({ length: s.target }, (_, i) => (
              <i key={i} className={i < s.done ? 'is-on' : undefined} />
            ))}
          </span>
          <span className="streak__count q-num">
            {s.done}/{s.target}
          </span>
          {levels && levels[s.kind] != null && (
            <span
              className={levels[s.kind] > 0 ? 'streak__lv q-num' : 'streak__lv is-zero q-num'}
              title="Weeks in a row on target"
            >
              LV {levels[s.kind]}
            </span>
          )}
        </div>
      ))}
      {wipe > 0 && <span key={wipe} className="streaks__wipe" aria-hidden="true" />}
    </div>
  );
}

/**
 * Extras: a counter that ticks each time a streak *reaches* its target while
 * the bubble is up — the wipe is keyed on it, so it plays once per hit. Never
 * on the first render, and not while the week's data is still arriving.
 */
function useHitWipe(streaks: Streak[], on: boolean): number {
  const prev = useRef<Record<string, boolean> | null>(null);
  const since = useRef(Date.now());
  const [n, setN] = useState(0);
  const [showing, setShowing] = useState(false);
  useEffect(() => {
    const settled = Date.now() - since.current >= SETTLE_MS;
    const hits = on && settled ? newlyHit(prev.current, streaks) : [];
    prev.current = hitMap(streaks);
    if (hits.length > 0) {
      setN((x) => x + 1);
      setShowing(true);
    }
  }, [streaks, on]);
  useEffect(() => {
    if (!showing) return;
    const t = window.setTimeout(() => setShowing(false), WIPE_MS);
    return () => window.clearTimeout(t);
  }, [showing, n]);
  return showing ? n : 0;
}
