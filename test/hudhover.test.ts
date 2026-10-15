import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { hoveredBubble } from '../src/lib/hudhover';

const require_ = createRequire(import.meta.url);
const { localPoint, nextPollDelay, pointKey, makeHoverPoll, HOVER_POLL_NEAR_MS, HOVER_POLL_FAR_MS, HOVER_NEAR_PX } = require_(
  '../electron/hudhover.cjs',
) as any;

// A top-right corner window on a second monitor left of the primary one.
const win = { x: -400, y: 20, width: 384, height: 300 };

describe('hud hover: the main-process poll', () => {
  it('maps the cursor into a window, null outside it', () => {
    expect(localPoint({ x: -400, y: 20 }, win)).toEqual({ x: 0, y: 0 });
    expect(localPoint({ x: -17, y: 319 }, win)).toEqual({ x: 383, y: 299 });
    // Right and bottom edges are exclusive, like a hit test.
    expect(localPoint({ x: -16, y: 100 }, win)).toBeNull();
    expect(localPoint({ x: -100, y: 320 }, win)).toBeNull();
    expect(localPoint({ x: -401, y: 100 }, win)).toBeNull();
    expect(localPoint({ x: 500, y: 100 }, win)).toBeNull();
    expect(localPoint(null, win)).toBeNull();
    expect(localPoint({ x: 0, y: 0 }, null)).toBeNull();
  });

  it('rounds fractional DIPs (a scaled display) to whole CSS px', () => {
    expect(localPoint({ x: -299.6, y: 40.4 }, win)).toEqual({ x: 100, y: 20 });
  });

  it('polls quickly only in or near a HUD window', () => {
    expect(nextPollDelay({ x: -200, y: 100 }, [win])).toBe(HOVER_POLL_NEAR_MS);
    expect(nextPollDelay({ x: -16 + HOVER_NEAR_PX, y: 100 }, [win])).toBe(HOVER_POLL_NEAR_MS);
    expect(nextPollDelay({ x: -16 + HOVER_NEAR_PX + 1, y: 100 }, [win])).toBe(HOVER_POLL_FAR_MS);
    expect(nextPollDelay({ x: -200, y: 320 + HOVER_NEAR_PX + 5 }, [win])).toBe(HOVER_POLL_FAR_MS);
    expect(nextPollDelay({ x: 2000, y: 2000 }, [win, { x: 1900, y: 1950, width: 50, height: 10 }])).toBe(HOVER_POLL_NEAR_MS);
    expect(nextPollDelay({ x: 0, y: 0 }, [])).toBe(HOVER_POLL_FAR_MS);
    expect(nextPollDelay(null, [win])).toBe(HOVER_POLL_FAR_MS);
    expect(HOVER_POLL_NEAR_MS).toBeLessThan(HOVER_POLL_FAR_MS);
  });

  it('keys points so an unmoved cursor sends nothing, and "outside" is the empty key', () => {
    expect(pointKey({ x: 3, y: 4 })).toBe('3,4');
    expect(pointKey(null)).toBe('');
    expect(pointKey({ x: 3, y: 4 })).toBe(pointKey({ x: 3, y: 4 }));
  });
});

describe('hud hover: which bubble', () => {
  const rects = [
    { id: 'clock', left: 0, top: 0, right: 384, bottom: 60 },
    { id: 'upcoming', left: 0, top: 68, right: 384, bottom: 180 },
    // A Fit bubble hugging the right side.
    { id: 'nowplaying', left: 164, top: 188, right: 384, bottom: 240 },
  ];

  it('finds the bubble under the point', () => {
    expect(hoveredBubble({ x: 10, y: 10 }, rects)).toBe('clock');
    expect(hoveredBubble({ x: 383, y: 179 }, rects)).toBe('upcoming');
    expect(hoveredBubble({ x: 200, y: 200 }, rects)).toBe('nowplaying');
  });

  it('is none between bubbles, beside a Fit bubble, or with no point', () => {
    expect(hoveredBubble({ x: 10, y: 64 }, rects)).toBeNull();
    expect(hoveredBubble({ x: 100, y: 200 }, rects)).toBeNull();
    expect(hoveredBubble({ x: 10, y: 260 }, rects)).toBeNull();
    expect(hoveredBubble(null, rects)).toBeNull();
    expect(hoveredBubble({ x: 10, y: 10 }, [])).toBeNull();
  });
});

describe('hud hover: the poll loop', () => {
  /** A fake window: fixed bounds, records what it's sent. */
  const fakeWin = (bounds: object) => {
    const got: unknown[] = [];
    return { got, getBounds: () => bounds, webContents: { send: (_ch: string, p: unknown) => got.push(p) } };
  };
  /** Manual timers: run() fires the one pending callback. */
  const manual = () => {
    let pending: null | (() => void) = null;
    let lastDelay = -1;
    return {
      timers: {
        setTimeout: (fn: () => void, ms: number) => ((pending = fn), (lastDelay = ms), 1),
        clearTimeout: () => (pending = null),
      },
      run: () => {
        const fn = pending;
        pending = null;
        fn?.();
      },
      delay: () => lastDelay,
      pending: () => pending != null,
    };
  };

  function setup() {
    const state = { wanted: true, cursor: { x: 2000, y: 2000 } as { x: number; y: number } | null };
    const a = fakeWin({ x: 0, y: 0, width: 300, height: 200 });
    const b = fakeWin({ x: 1000, y: 0, width: 300, height: 200 });
    const t = manual();
    const errors: unknown[] = [];
    const poll = makeHoverPoll({
      wanted: () => state.wanted,
      cursor: () => {
        if (!state.cursor) throw new Error('no cursor');
        return state.cursor;
      },
      windows: () => [a, b],
      onError: (e: unknown) => errors.push(e),
      timers: t.timers,
    });
    return { state, a, b, t, poll, errors };
  }

  it('sends a window its point only when it changes, and null when the cursor leaves', () => {
    const { state, a, b, t, poll } = setup();
    poll.sync(); // far from both: nothing sent, slow poll
    expect(a.got).toEqual([]);
    expect(t.delay()).toBe(HOVER_POLL_FAR_MS);
    state.cursor = { x: 50, y: 60 };
    t.run();
    expect(a.got).toEqual([{ x: 50, y: 60 }]);
    expect(b.got).toEqual([]);
    expect(t.delay()).toBe(HOVER_POLL_NEAR_MS);
    t.run(); // unmoved: nothing new
    expect(a.got).toHaveLength(1);
    state.cursor = { x: 1010, y: 5 }; // straight into the other corner
    t.run();
    expect(a.got).toEqual([{ x: 50, y: 60 }, null]);
    expect(b.got).toEqual([{ x: 10, y: 5 }]);
  });

  it('stops and clears every hover when no longer wanted (arrange mode, HUD hidden, fade off)', () => {
    const { state, a, t, poll } = setup();
    state.cursor = { x: 50, y: 60 };
    poll.sync();
    expect(poll.running()).toBe(true);
    state.wanted = false;
    poll.sync();
    expect(poll.running()).toBe(false);
    expect(t.pending()).toBe(false);
    expect(a.got).toEqual([{ x: 50, y: 60 }, null]);
    // Coming back re-sends the point the window had been cleared of.
    state.wanted = true;
    poll.sync();
    expect(a.got).toEqual([{ x: 50, y: 60 }, null, { x: 50, y: 60 }]);
  });

  it('a scheduled poll that finds itself unwanted stops on its own', () => {
    const { state, a, t, poll } = setup();
    state.cursor = { x: 50, y: 60 };
    poll.sync();
    state.wanted = false;
    t.run();
    expect(poll.running()).toBe(false);
    expect(a.got.at(-1)).toBeNull();
  });

  it('sync is idempotent while running, and forget() makes a reloaded page hear again', () => {
    const { state, a, poll } = setup();
    state.cursor = { x: 50, y: 60 };
    poll.sync();
    poll.sync();
    expect(a.got).toHaveLength(1);
    poll.forget(a);
    state.wanted = false;
    poll.sync(); // a fresh page already shows nothing: no null needed
    expect(a.got).toHaveLength(1);
  });

  it('survives a failing cursor read and keeps polling', () => {
    const { state, t, poll, errors } = setup();
    state.cursor = null;
    poll.sync();
    expect(errors).toHaveLength(1);
    expect(poll.running()).toBe(true);
    expect(t.delay()).toBe(HOVER_POLL_FAR_MS);
  });
});
