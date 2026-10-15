import { describe, expect, it } from 'vitest';
import { LIVELY_MS, livelyUntil } from '../src/lib/lively';

describe('livelyUntil — lean idle (option A, Bug Log #62)', () => {
  const now = 1_000_000;

  it('opens a window on the first key and on every change', () => {
    expect(livelyUntil(null, 'track-a|on|shown|', now, 0)).toBe(now + LIVELY_MS);
    expect(livelyUntil('track-a|on|shown|', 'track-b|on|shown|', now, now - 1)).toBe(now + LIVELY_MS);
  });

  it('keeps the current window while nothing changes, so the HUD goes still', () => {
    const until = now - 5;
    expect(livelyUntil('track-a|on|shown|', 'track-a|on|shown|', now, until)).toBe(until);
  });

  it('wakes on play/pause, on the HUD being shown again, and on a block going imminent', () => {
    for (const next of ['track-a|off|shown|', 'track-a|on|hidden|', 'track-a|on|shown|Gym@2026-10-15T07:00']) {
      expect(livelyUntil('track-a|on|shown|', next, now, 0)).toBe(now + LIVELY_MS);
    }
  });

  it('is a few seconds, not a loop', () => {
    expect(LIVELY_MS).toBeGreaterThanOrEqual(3_000);
    expect(LIVELY_MS).toBeLessThanOrEqual(15_000);
  });
});
