'use strict';
// Focus mode's two small decisions, kept pure so they can be tested without a
// running Electron: which calendar event "focus on the current block" means,
// and the Obsidian link Ctrl+Alt+W opens.

/** How soon an event may start and still count as "now" for focus. */
const FOCUS_SOON_MS = 10 * 60 * 1000;

/**
 * The event to focus on at `now` (ms): the timed event in progress — the
 * latest to start, if several overlap — else the next one starting within
 * FOCUS_SOON_MS. All-day events never count. `events` are wire events
 * (google.cjs `toWireEvent`: ISO `start`/`end`, `allDay`).
 */
function pickFocusEvent(events, now) {
  const timed = (events || []).filter((e) => e && !e.allDay && e.start && e.end);
  const on = timed
    .filter((e) => Date.parse(e.start) <= now && now < Date.parse(e.end))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  if (on[0]) return on[0];
  const soon = timed
    .filter((e) => Date.parse(e.start) > now && Date.parse(e.start) - now <= FOCUS_SOON_MS)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return soon[0] || null;
}

/** `obsidian://open` for a vault-relative note — the same shape as
 *  src/lib/source.ts `obsidianUri`. */
function obsidianUri(vaultName, file) {
  const note = String(file).replace(/\\/g, '/').replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(note)}`;
}

module.exports = { FOCUS_SOON_MS, pickFocusEvent, obsidianUri };
