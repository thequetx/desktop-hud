import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderBubble } from '../src/components/hud/widgets';
import type { SetupState, WidgetProps } from '../src/components/hud/widgets';
import { PRESENTATION_DEFAULTS } from '../src/lib/presentation';
import type { Bubble } from '../src/lib/presentation';
import { WIDGETS } from '../src/lib/widgets';
import type { CalEvent, SkeletonBlock, VaultWeek } from '../src/lib/types';

// Phase 9.5: a bubble whose source isn't set up says so, in text (the HUD is
// click-through); one whose source is set up but empty hides.

const now = new Date(2026, 9, 15, 10, 0);
const bubble = (id: string): Bubble => ({ ...PRESENTATION_DEFAULTS.hud.bubbles.find((b) => b.id === id)!, enabled: true });
const emptyWeek: VaultWeek = { weekId: '2026-W42', notePath: null, weeklyDir: 'Weekly', intentions: [], tasks: [], thisweek: [] };

function props(id: string, setup?: SetupState, extra: Partial<WidgetProps> = {}): WidgetProps {
  return {
    bubble: bubble(id),
    now,
    weekStart: new Date(2026, 9, 12),
    weekId: '2026-W42',
    events: [] as CalEvent[],
    skeleton: [] as SkeletonBlock[],
    streaks: [],
    vault: emptyWeek,
    audit: null,
    data: {},
    backlog: [],
    focus: null,
    presentation: PRESENTATION_DEFAULTS,
    error: null,
    debugRows: null,
    setup,
    ...extra,
  };
}
const html = (node: ReactNode) => (node == null ? null : renderToStaticMarkup(createElement('div', null, node)));

describe('empty states (Phase 9.5)', () => {
  it('Next up asks for a calendar when there is none and no recurring block', () => {
    const out = html(renderBubble(props('upcoming', { calendars: 0, notesMissing: false })));
    expect(out).toContain('No calendar yet.');
    expect(out).toContain('Add one in Display &amp; HUD → Integrations.');
    expect(out).not.toContain('nothing scheduled');
    expect(out).not.toContain('<button');
  });

  it('Next up just says nothing is scheduled once a calendar is connected', () => {
    const out = html(renderBubble(props('upcoming', { calendars: 1, notesMissing: false })));
    expect(out).toContain('nothing scheduled');
    expect(out).not.toContain('No calendar yet');
  });

  it('a recurring block counts: no set-up line with blocks but no calendar', () => {
    const gym: SkeletonBlock = { name: 'Gym', kind: 'gym', days: [6], startMin: 6 * 60, endMin: 7 * 60 };
    const out = html(renderBubble(props('upcoming', { calendars: 0, notesMissing: false }, { skeleton: [gym] })));
    expect(out).not.toContain('No calendar yet');
  });

  it('draws no set-up line while it doesn\'t yet know what is set up', () => {
    expect(html(renderBubble(props('upcoming')))).not.toContain('No calendar yet');
  });

  it('Intentions says where to fix a notes folder that has gone, and hides otherwise', () => {
    const missing = html(renderBubble(props('intention', { calendars: 1, notesMissing: true })));
    expect(missing).toContain('Notes folder not found.');
    expect(missing).toContain('Fix it in Display &amp; HUD → Integrations.');
    expect(renderBubble(props('intention', { calendars: 1, notesMissing: false }))).toBeNull();
  });

  it('every other bubble hides when it has nothing, and never errors', () => {
    const setup: SetupState = { calendars: 0, notesMissing: false };
    for (const id of ['radar', 'placed', 'health', 'streaks', 'daily', 'backlog', 'nowplaying'] as const) {
      expect(renderBubble(props(id, setup))).toBeNull();
      expect(() => renderBubble(props(id, setup, { vault: null }))).not.toThrow();
    }
    // The clock and the week strip always have something to show.
    expect(renderBubble(props('clock', setup))).not.toBeNull();
    expect(renderBubble(props('weekstrip', setup))).not.toBeNull();
  });

  it('names each source by its slot, not a product', () => {
    for (const w of Object.values(WIDGETS)) expect(w.source).not.toMatch(/google|spotify|songify|obsidian|outlook/i);
    expect(WIDGETS.upcoming.source).toBe('your calendars + recurring blocks');
  });
});

describe('staleSince — the offline line (Phase 9.6)', () => {
  const NOW = Date.parse('2026-10-16T02:00:00Z');
  const src = (o: Partial<{ kind: string; fetchedAt: number | null; lastError: string | null }>) => ({ kind: 'ics-url', fetchedAt: NOW - 60 * 60 * 1000, lastError: 'calendar fetch failed (network)', ...o });
  it('the oldest failing link past half an hour; nothing when fresh, healthy or a file', async () => {
    const { staleSince } = await import('../src/components/hud/widgets');
    expect(staleSince([src({})], NOW)).toBe(NOW - 60 * 60 * 1000);
    expect(staleSince([src({}), src({ fetchedAt: NOW - 3 * 60 * 60 * 1000 })], NOW)).toBe(NOW - 3 * 60 * 60 * 1000);
    expect(staleSince([src({ fetchedAt: NOW - 10 * 60 * 1000 })], NOW)).toBeNull();
    expect(staleSince([src({ lastError: null })], NOW)).toBeNull();
    expect(staleSince([src({ kind: 'ics-file' })], NOW)).toBeNull();
    expect(staleSince([], NOW)).toBeNull();
  });
});
