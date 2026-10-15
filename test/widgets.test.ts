import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRESENTATION_DEFAULTS } from '../src/lib/presentation';
import type { Bubble, PresentationPrefs } from '../src/lib/presentation';
import {
  activeKinds,
  activeTitles,
  isDuring,
  bubbleState,
  buildPlaced,
  customRequests,
  readersNeeded,
  visibleBubbles,
} from '../src/lib/widgets';
import type { CalEvent, SkeletonBlock, VaultTask } from '../src/lib/types';

const require_ = createRequire(import.meta.url);
const {
  makeWidgetSources,
  parseDailyNote,
  parseNoteSection,
  parseFields,
  resolveTokens,
  dueMatches,
} = require_('../electron/widgets.cjs') as any;

const stream: SkeletonBlock = { name: 'Stream', kind: 'stream', days: [0, 1, 3, 4], startMin: 18 * 60 + 30, endMin: 21 * 60 + 30 };
const task = (text: string, done = false): VaultTask => ({ text, done, file: 'Weekly/2026-W39.md', line: 1 });
const prefs = (): PresentationPrefs => structuredClone(PRESENTATION_DEFAULTS);

// Thursday 24 Sep 2026.
const thu = (h: number, m = 0) => new Date(2026, 8, 24, h, m);

describe('show rules', () => {
  const ctx = (now: Date, kinds: string[] = [], focus = false) => ({ now, kinds, focus });
  const custom = (show: Partial<Bubble['show']>): Bubble => ({
    id: 'b-x',
    type: 'text',
    enabled: true,
    anchor: 'top-right',
    title: '',
    rows: null,
    width: 'full',
    bgOpacity: null,
    show: { hideDuring: [], onlyDuring: [], days: [], hours: null, inFocus: null, ...show },
    source: { text: 'hi' },
  });

  it('knows which skeleton kinds are running', () => {
    expect(activeKinds([stream], thu(19))).toEqual(['stream']);
    expect(activeKinds([stream], thu(21, 30))).toEqual([]); // end is exclusive
    expect(activeKinds([stream], new Date(2026, 8, 23, 19))).toEqual([]); // Wednesday
  });

  it('treats a calendar event in progress as "during" its title words', () => {
    // the user's recurring blocks live on Google Calendar, not in the skeleton.
    const ev = (title: string, h: number): CalEvent => ({
      uid: title,
      title,
      start: thu(h),
      end: thu(h + 3),
      allDay: false,
    });
    const events = [ev('Twitch Stream', 18), ev('Gym', 6)];
    expect(activeTitles(events, thu(19))).toEqual(['twitch stream']);
    const at = (h: number) => ({ now: thu(h), kinds: [], titles: activeTitles(events, thu(h)), focus: false });
    expect(isDuring('stream', at(19))).toBe(true);
    expect(isDuring('stream', at(12))).toBe(false);
    expect(isDuring('gym', at(7))).toBe(true);
    // Whole words only: "stream" is not "streamline".
    expect(isDuring('stream', { ...at(12), titles: ['streamline the backlog'] })).toBe(false);
    expect(bubbleState(custom({ hideDuring: ['stream'] }), at(19))).toBe('hidden during stream');
    expect(bubbleState(custom({ onlyDuring: ['gym'] }), at(7))).toBeNull();
  });

  it('applies a stream rule only where one is set, and only in its own corner', () => {
    const p = prefs();
    const ids = (anchor: Parameters<typeof visibleBubbles>[1], kinds: string[]) =>
      visibleBubbles(p, anchor, ctx(thu(19), kinds)).map((w) => w.id);
    expect(ids('bottom-left', [])).toEqual(['daily']);
    // No stream rule by default since streaming became a private add-on (plan decision 9).
    expect(ids('bottom-left', ['stream'])).toEqual(['daily']);
    p.hud.bubbles = p.hud.bubbles.map((b) => (b.id === 'daily' ? { ...b, show: { ...b.show, hideDuring: ['stream'] } } : b));
    expect(ids('bottom-left', ['stream'])).toEqual([]);
    expect(ids('top-right', ['stream'])).toEqual(['clock', 'upcoming', 'placed', 'weekstrip']);
  });

  it('collapses to the countdown in focus mode', () => {
    const shown = (anchor: Parameters<typeof visibleBubbles>[1]) =>
      visibleBubbles(prefs(), anchor, ctx(thu(12), [], true)).map((w) => w.id);
    expect(shown('top-right')).toEqual(['clock', 'upcoming']);
    expect(shown('top-left')).toEqual(['intention', 'health']);
    expect(shown('bottom-left')).toEqual([]);
  });

  it('says why a bubble is hidden, for every kind of rule', () => {
    expect(bubbleState(custom({}), ctx(thu(12)))).toBeNull();
    expect(bubbleState(custom({ onlyDuring: ['stream'] }), ctx(thu(12)))).toBe('only during stream');
    expect(bubbleState(custom({ onlyDuring: ['stream'] }), ctx(thu(19), ['stream']))).toBeNull();
    expect(bubbleState(custom({ days: [5, 6] }), ctx(thu(12)))).toBe('not today'); // Thu = 3
    expect(bubbleState(custom({ days: [3] }), ctx(thu(12)))).toBeNull();
    expect(bubbleState(custom({ hours: { from: 9 * 60, to: 17 * 60 } }), ctx(thu(18)))).toBe('only 09:00–17:00');
    // Wrapping midnight.
    expect(bubbleState(custom({ hours: { from: 22 * 60, to: 2 * 60 } }), ctx(thu(23)))).toBeNull();
    expect(bubbleState(custom({ hours: { from: 22 * 60, to: 2 * 60 } }), ctx(thu(12)))).toBe('only 22:00–02:00');
    // Owner-defined bubbles hide in focus unless told otherwise.
    expect(bubbleState(custom({}), ctx(thu(12), [], true))).toBe('hidden in focus');
    expect(bubbleState(custom({ inFocus: true }), ctx(thu(12), [], true))).toBeNull();
    expect(bubbleState({ ...custom({}), enabled: false }, ctx(thu(12)))).toBe('switched off');
  });

  it('reads only what an enabled bubble needs', () => {
    const p = prefs();
    expect(readersNeeded(p).sort()).toEqual(['daily']);
    p.hud.bubbles = p.hud.bubbles.map((w) => (w.id === 'daily' ? { ...w, enabled: false } : w));
    expect(readersNeeded(p).sort()).toEqual([]);
    p.hud.bubbles.push(
      { ...custom({}), id: 'b-n', type: 'note', source: { path: 'x', heading: '', items: 'open' } },
      { ...custom({}), id: 'b-t' },
    );
    expect(customRequests(p).map((r) => r.id)).toEqual(['b-n']); // text needs no read
    expect(customRequests(p, 'top-left')).toEqual([]);
  });
});

describe('placed tasks', () => {
  const W39 = [
    task('13:30 - 17:30 Disambiguate scroll from drag ~4h 📅 2026-09-26 🔺 ⏳ 2026-09-26'),
    task('09:00 - 10:00 Check every tap target against the 44px minimum ~1h 📅 2026-09-26 ⏳ 2026-09-26'),
    task('19:30 - 21:30 Test on an actual phone and tablet ~2h 📅 2026-09-27 🔺 ⏳ 2026-09-26'),
    task('10:00 - 11:00 No scheduled date, so no day to put it on'),
    task('Unplaced line ⏳ 2026-09-26'),
    task('08:00 - 09:00 Already done ⏳ 2026-09-26', true),
  ];

  it('puts timed lines on their ⏳ day, in time order, with title and estimate', () => {
    const rows = buildPlaced(W39, [], thu(12));
    expect(rows.map((r) => [r.when.getDate(), r.when.getHours(), r.when.getMinutes(), r.label])).toEqual([
      [26, 9, 0, 'Check every tap target against the 44px minimum'],
      [26, 13, 30, 'Disambiguate scroll from drag'],
      [26, 19, 30, 'Test on an actual phone and tablet'],
    ]);
    expect(rows[1]).toMatchObject({ estMin: 240, priority: 'highest' });
  });

  it('drops finished blocks and ones already on the calendar', () => {
    const sat = (h: number, m = 0) => new Date(2026, 8, 26, h, m);
    const booked: CalEvent = { uid: 'e', title: 'x', start: sat(13, 30), end: sat(17, 30), allDay: false };
    const rows = buildPlaced(W39, [booked], sat(12));
    expect(rows.map((r) => r.label)).toEqual(['Test on an actual phone and tablet']);
  });

  it('escalates inside the lead window like a skeleton block', () => {
    const rows = buildPlaced(W39, [], new Date(2026, 8, 26, 8, 50));
    expect(rows[0]).toMatchObject({ imminent: true, inMin: 10 });
  });
});

describe('vault readers (electron/widgets.cjs)', () => {
  const DAILY = [
    '---',
    'tags:',
    '  - daily-note',
    'date: 2026-09-20',
    'energy: 6',
    'motivation:',
    '---',
    '',
    '# 2026-09-20',
    '',
    '## Goals',
    '',
    '- [ ] Build the narrow day view ~4h ⏳ 2026-09-19 ⏫',
    '- [x] Decide the narrow breakpoint ~1h 🔺',
    '- [ ] ',
    '',
    '## Notes',
    '- [ ] not a goal',
  ].join('\n');

  it('reads goals and the day scores from a daily note', () => {
    expect(parseDailyNote(DAILY)).toEqual({
      goals: [
        { text: 'Build the narrow day view ~4h ⏳ 2026-09-19 ⏫', done: false },
        { text: 'Decide the narrow breakpoint ~1h 🔺', done: true },
      ],
      energy: 6,
      motivation: null,
    });
    expect(parseDailyNote('# empty')).toEqual({ goals: [], energy: null, motivation: null });
  });

  it('reads a note section as tasks or as lines, skipping machinery', () => {
    const fence = '`'.repeat(3);
    const note = [
      '---',
      'status: active',
      'tags:',
      '  - hq',
      '  - game',
      '---',
      '# Dashboard',
      '',
      '## Now',
      '',
      '- [ ] Fix the save bug ⏫',
      '- [x] Ship the demo',
      '- [ ] ',
      'Next milestone is **the vertical slice** — see [[Roadmap|the roadmap]].',
      `${fence}dataview`,
      'TABLE file.name',
      fence,
      '> a quote line',
      '',
      '## Later',
      '- [ ] not now',
    ].join('\n');
    expect(parseNoteSection(note, 'Now', 'open').items.map((i: { text: string }) => i.text)).toEqual([
      'Fix the save bug ⏫',
    ]);
    expect(parseNoteSection(note, 'Now', 'tasks').items).toHaveLength(2);
    // Lines mode is the section as written: done tasks stay (drawn ticked).
    expect(parseNoteSection(note, 'Now', 'lines').items.map((i: { text: string }) => i.text)).toEqual([
      'Fix the save bug ⏫',
      'Ship the demo',
      'Next milestone is the vertical slice — see the roadmap.',
      'a quote line',
    ]);
    expect(parseNoteSection(note, 'Missing', 'open')).toEqual({ found: false, items: [] });
    // Whole note: everything after the frontmatter, open tasks only.
    expect(parseNoteSection(note, '', 'open').items).toHaveLength(2);
    expect(parseFields(note, ['status', 'tags', 'nope'])).toEqual([
      { key: 'status', value: 'active' },
      { key: 'tags', value: 'hq, game' },
      { key: 'nope', value: null },
    ]);
  });

  it('resolves date tokens and due filters', () => {
    expect(
      resolveTokens('Daily/{today}|{yesterday}|{tomorrow}|{week}|{year}-{month}|{typo}', '2026-09-23'),
    ).toBe('Daily/2026-09-23|2026-09-22|2026-09-24|2026-W39|2026-09|{typo}');
    expect(resolveTokens('{week}', '2026-12-31')).toBe('2026-W53');
    const t = '2026-09-23';
    expect(dueMatches('any', null, t)).toBe(true);
    expect(dueMatches('week', null, t)).toBe(false);
    expect(dueMatches('overdue', '2026-09-22', t)).toBe(true);
    expect(dueMatches('today', '2026-09-23', t)).toBe(true);
    expect(dueMatches('today', '2026-09-24', t)).toBe(false);
    expect(dueMatches('week', '2026-09-29', t)).toBe(true);
    expect(dueMatches('week', '2026-09-30', t)).toBe(false);
  });

  describe('against a vault on disk', () => {
    let root = '';
    beforeAll(() => {
      root = mkdtempSync(path.join(tmpdir(), 'wd-widgets-'));
      mkdirSync(path.join(root, 'Daily'));
      mkdirSync(path.join(root, 'Art', 'Week 02'), { recursive: true });
      mkdirSync(path.join(root, 'HQ', 'sub'), { recursive: true });
      writeFileSync(path.join(root, 'Daily', '2026-09-20.md'), DAILY);
      writeFileSync(
        path.join(root, 'Art', '04 - Dashboard.md'),
        '## Current week\n- [[Week 02/Weekly Plan|Week 02 — Simple forms]]\n',
      );
      writeFileSync(path.join(root, 'Art', 'Week 02', 'Weekly Plan.md'), '**Minimum:** One still life.\n');
      writeFileSync(
        path.join(root, 'HQ', 'Board.md'),
        '---\nstatus: alpha\n---\n## Now\n- [ ] one #hq 📅 2026-09-19\n- [ ] two 🔺\n',
      );
      writeFileSync(path.join(root, 'HQ', 'sub', 'More.md'), '- [ ] three #hq ⏫ 📅 2026-09-25\n- [x] four #hq\n');
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const sources = () =>
      makeWidgetSources({ root, dailyDir: 'Daily', artDashboard: 'Art/04 - Dashboard.md' });

    it('reads today’s note, and nothing for an id it has no reader for', async () => {
      // `art` moved to a private add-on (Phase 9.3): no longer a core reader.
      const r = await sources().read({ ids: ['daily', 'art', 'nope'] }, { today: '2026-09-20' });
      expect(r.daily).toMatchObject({ exists: true, energy: 6, file: 'Daily/2026-09-20.md' });
      expect(r.daily.goals).toHaveLength(2);
      expect('art' in r).toBe(false);
      expect('nope' in r).toBe(false);
    });

    it('reports a missing daily note rather than failing', async () => {
      const r = await sources().read({ ids: ['daily'] }, { today: '2026-09-21' });
      expect(r.daily).toMatchObject({ exists: false, goals: [] });
    });

    it('answers custom bubbles: a note section, a tasks query, fields', async () => {
      const r = await sources().read(
        {
          custom: [
            { id: 'b-a', type: 'note', source: { path: 'HQ/Board', heading: 'Now', items: 'open' } },
            { id: 'b-b', type: 'tasks', source: { folder: 'HQ', tag: 'hq', due: 'any', priority: 'any', includeDone: false } },
            { id: 'b-c', type: 'tasks', source: { folder: 'HQ', tag: '', due: 'any', priority: 'highest', includeDone: false } },
            { id: 'b-d', type: 'fields', source: { path: 'HQ/Board.md', keys: ['status'] } },
            { id: 'b-e', type: 'note', source: { path: 'Daily/{today}', heading: 'Goals', items: 'tasks' } },
          ],
        },
        { today: '2026-09-20' },
      );
      expect(r.custom['b-a'].items.map((i: { text: string }) => i.text)).toEqual(['one #hq 📅 2026-09-19', 'two 🔺']);
      // Tagged and open, soonest due first; the done one is left out.
      expect(r.custom['b-b'].items.map((i: { text: string }) => i.text)).toEqual([
        'one #hq 📅 2026-09-19',
        'three #hq ⏫ 📅 2026-09-25',
      ]);
      expect(r.custom['b-c'].items.map((i: { text: string }) => i.text)).toEqual(['two 🔺']);
      expect(r.custom['b-d'].fields).toEqual([{ key: 'status', value: 'alpha' }]);
      expect(r.custom['b-e']).toMatchObject({ exists: true, file: 'Daily/2026-09-20.md' });
    });

    it('describes a note for the editor, and lists notes', async () => {
      const d = await sources().describe('HQ/Board', '2026-09-20');
      expect(d).toMatchObject({ exists: true, headings: ['Now'], keys: ['status'] });
      expect(await sources().listNotes()).toContain('HQ/sub/More.md');
    });

    it('refuses paths that leave the vault', async () => {
      const s = makeWidgetSources({ root, dailyDir: '../outside' });
      const r = await s.read(
        { ids: ['daily'], custom: [{ id: 'b-z', type: 'note', source: { path: '../../etc/x' } }] },
        { today: '2026-09-20' },
      );
      expect(r.daily).toMatchObject({ exists: false });
      expect(r.custom['b-z']).toMatchObject({ exists: false });
    });
  });
});
