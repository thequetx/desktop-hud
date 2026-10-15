import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { obsidianUri as rendererUri } from '../src/lib/source';

const require_ = createRequire(import.meta.url);
const { FOCUS_SOON_MS, pickFocusEvent, obsidianUri } = require_('../electron/focus.cjs') as any;

const NOW = Date.parse('2026-09-24T19:00:00+10:00');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const ev = (uid: string, startMin: number, endMin: number, allDay = false) => ({
  uid,
  title: uid,
  start: at(startMin),
  end: at(endMin),
  allDay,
});

describe('pickFocusEvent — "focus on the current block"', () => {
  it('takes the event in progress', () => {
    expect(pickFocusEvent([ev('later', 60, 90), ev('now', -30, 30)], NOW)?.uid).toBe('now');
  });

  it('prefers the most recently started when events overlap', () => {
    // A call that started inside a long stream block is what you are doing.
    expect(pickFocusEvent([ev('stream', -30, 150), ev('call', -5, 25)], NOW)?.uid).toBe('call');
  });

  it('falls back to something starting within ten minutes', () => {
    expect(pickFocusEvent([ev('soon', 8, 60), ev('sooner', 5, 30)], NOW)?.uid).toBe('sooner');
    expect(FOCUS_SOON_MS).toBe(10 * 60_000);
  });

  it('offers nothing when the next event is further off, or already over', () => {
    expect(pickFocusEvent([ev('far', 11, 60), ev('done', -60, 0)], NOW)).toBeNull();
    expect(pickFocusEvent([], NOW)).toBeNull();
  });

  it('never picks an all-day event', () => {
    expect(pickFocusEvent([ev('holiday', -600, 600, true)], NOW)).toBeNull();
  });
});

describe('obsidianUri (main process)', () => {
  it('matches the renderer’s link for the same note', () => {
    const file = 'My Weekly/2026-W39.md';
    expect(obsidianUri('quetx', file)).toBe(rendererUri('quetx', file));
    expect(obsidianUri('quetx', file)).toBe('obsidian://open?vault=quetx&file=My%20Weekly%2F2026-W39');
  });
});
