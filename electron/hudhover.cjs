'use strict';

// Hover fade (2026-10-02): a HUD bubble under the cursor turns mostly
// transparent so whatever is behind it can be read, and comes back when the
// cursor leaves. Outside arrange mode only.
//
// The corner windows stay fully click-through (`setIgnoreMouseEvents(true)`,
// no `{ forward: true }`), so the page never receives mouse events of its own.
// Instead the main process polls `screen.getCursorScreenPoint()` and tells each
// corner window where the cursor is inside it (or that it isn't). Why polling
// rather than forwarded events:
//   - forwarding on Windows is built on a global low-level mouse hook, and a
//     window whose cursor leaves it often gets no mouseleave at all — a bubble
//     would stay faded until the cursor came back;
//   - every `setIgnoreMouseEvents()` call (syncHudWindows runs on each
//     preference write and display change) would have to re-pass `forward`,
//     and the arrange toggle would have to juggle three states, not two;
//   - polling cannot make a window take a click, focus or raise (Decisions §9),
//     because it never changes the window at all.
// The poll is quick near a HUD window and slow away from one, and stops while
// the HUD is hidden, in arrange mode, or with the fade switched off.

/** Poll interval while the cursor is in or near a HUD window. */
const HOVER_POLL_NEAR_MS = 50;
/** Poll interval while it is nowhere near one. */
const HOVER_POLL_FAR_MS = 200;
/** "Near": within this many DIPs of a window's edge. A cursor crossing it at an
 *  ordinary speed is caught by a near poll before it reaches the bubble. */
const HOVER_NEAR_PX = 160;

/** The cursor in a window's own coordinates (CSS px at zoom 1), or null when
 *  it is outside the window. Both arguments are in screen DIPs. */
function localPoint(cursor, bounds) {
  if (!cursor || !bounds) return null;
  const x = Math.round(cursor.x - bounds.x);
  const y = Math.round(cursor.y - bounds.y);
  return x >= 0 && y >= 0 && x < bounds.width && y < bounds.height ? { x, y } : null;
}

/** How long until the next poll: short when the cursor is within
 *  HOVER_NEAR_PX of any window, long otherwise. */
function nextPollDelay(cursor, boundsList) {
  if (!cursor) return HOVER_POLL_FAR_MS;
  for (const b of boundsList) {
    if (!b) continue;
    const dx = Math.max(b.x - cursor.x, 0, cursor.x - (b.x + b.width));
    const dy = Math.max(b.y - cursor.y, 0, cursor.y - (b.y + b.height));
    if (dx <= HOVER_NEAR_PX && dy <= HOVER_NEAR_PX) return HOVER_POLL_NEAR_MS;
  }
  return HOVER_POLL_FAR_MS;
}

/** A stable key for "what was last sent", so an unmoved cursor sends nothing. */
function pointKey(p) {
  return p ? `${p.x},${p.y}` : '';
}

/**
 * The poll itself. `wanted()` says whether it should run (HUD shown, not
 * arranging, fade on); `cursor()` is screen.getCursorScreenPoint; `windows()`
 * the live corner windows. Each window is sent `hud:hover` with its local
 * point, or null, only when that changes.
 *
 * `sync()` starts or stops it to match `wanted()` (stopping tells every window
 * null); `forget(win)` drops what a window was last told, for a page that has
 * just (re)loaded and knows nothing.
 */
function makeHoverPoll({ wanted, cursor, windows, onError = () => {}, timers = { setTimeout, clearTimeout } }) {
  let timer = null;
  /** What each window was last told; nothing yet counts as "not hovered". */
  const sent = new WeakMap();

  function send(w, point) {
    const key = pointKey(point);
    if ((sent.has(w) ? sent.get(w) : '') === key) return;
    sent.set(w, key);
    w.webContents.send('hud:hover', point);
  }

  function poll() {
    timer = null;
    if (!wanted()) return sync();
    let delay = HOVER_POLL_FAR_MS;
    try {
      const at = cursor();
      const wins = windows();
      const bounds = wins.map((w) => w.getBounds());
      wins.forEach((w, i) => send(w, localPoint(at, bounds[i])));
      delay = nextPollDelay(at, bounds);
    } catch (err) {
      onError(err);
    }
    timer = timers.setTimeout(poll, delay);
  }

  function sync() {
    if (wanted()) {
      if (!timer) poll();
      return;
    }
    if (timer) timers.clearTimeout(timer);
    timer = null;
    for (const w of windows()) send(w, null);
  }

  return {
    sync,
    forget: (w) => sent.delete(w),
    /** For tests: is a poll scheduled. */
    running: () => timer != null,
  };
}

module.exports = { HOVER_POLL_NEAR_MS, HOVER_POLL_FAR_MS, HOVER_NEAR_PX, localPoint, nextPollDelay, pointKey, makeHoverPoll };
