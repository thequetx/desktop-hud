import { describe, expect, it } from 'vitest';
import {
  bossBar,
  dayPhase,
  debriefRows,
  enqueueObjectives,
  EXTRAS_META,
  newlyDone,
  newlyHit,
  objectiveKey,
  objectiveText,
  radarModel,
  streakLevels,
  weekPlannedMin,
} from '../src/lib/extras';
import { EXTRA_IDS } from '../src/lib/presentation';
import { computeStreaks } from '../src/lib/streaks';
import { addWeeks, startOfISOWeek } from '../src/lib/week';
import type { WeekHealth } from '../src/lib/health';
import type { CalEvent, SkeletonBlock } from '../src/lib/types';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const WEEK = startOfISOWeek(at(2026, 9, 21)); // Mon 21 Sep 2026

const GYM: SkeletonBlock = { name: 'Gym', kind: 'gym', days: [0, 1, 2, 3, 4], startMin: 360, endMin: 420 };
const STREAM: SkeletonBlock = { name: 'Twitch Stream', kind: 'stream', days: [0, 1, 3, 4], startMin: 1110, endMin: 1290 };

let uid = 0;
const ev = (title: string, start: Date, mins = 60, allDay = false): CalEvent => ({
  uid: `u${++uid}`,
  title,
  start,
  end: new Date(start.getTime() + mins * 60_000),
  allDay,
});

/** Every slot of `block` in the week starting `ws`, kept (minus the first `skip`). */
const keptWeek = (ws: Date, block: SkeletonBlock, skip = 0) =>
  block.days.slice(skip).map((d) => {
    const s = new Date(ws);
    s.setDate(s.getDate() + d);
    s.setHours(Math.floor(block.startMin / 60), block.startMin % 60, 0, 0);
    return ev(block.name, s);
  });

const health = (p: Partial<WeekHealth> = {}): WeekHealth => ({
  intentionsDone: 0,
  intentionsTotal: 0,
  keptMin: 0,
  plannedMin: 0,
  streaksKept: 0,
  streaksTotal: 0,
  tasksDone: 0,
  tasksTotal: 0,
  placed: 0,
  unplanned: 0,
  ...p,
});

describe('extras meta', () => {
  it('describes every switch in one line', () => {
    expect(Object.keys(EXTRAS_META)).toEqual([...EXTRA_IDS]);
    for (const k of EXTRA_IDS) expect(EXTRAS_META[k].hint.length).toBeLessThan(140);
    expect(EXTRAS_META.objectiveComplete.hint).toMatch(/shows on stream unless that corner is private/i);
  });
});

describe('streak levels', () => {
  it('counts consecutive past weeks on target, stopping at the first miss', () => {
    const events = [
      ...keptWeek(addWeeks(WEEK, -1), GYM),
      ...keptWeek(addWeeks(WEEK, -2), GYM),
      ...keptWeek(addWeeks(WEEK, -3), GYM, 1), // 4/5: a miss
      ...keptWeek(addWeeks(WEEK, -4), GYM),
      ...keptWeek(addWeeks(WEEK, -1), STREAM),
    ];
    expect(streakLevels(WEEK, events, [GYM, STREAM])).toEqual({ gym: 2, stream: 1 });
  });

  it('uses the same rule as computeStreaks, and ignores this week', () => {
    const lastWeek = keptWeek(addWeeks(WEEK, -1), GYM);
    const s = computeStreaks(addWeeks(WEEK, -1), lastWeek, [GYM])[0];
    expect(s.done).toBe(s.target);
    expect(streakLevels(WEEK, [...lastWeek, ...keptWeek(WEEK, GYM)], [GYM])).toEqual({ gym: 1 });
    // 90 minutes late is still that slot (NEAR_MS); two hours isn't.
    const shift = (min: number) =>
      lastWeek.map((e, i) => (i === 0 ? { ...e, start: new Date(e.start.getTime() + min * 60_000) } : e));
    expect(streakLevels(WEEK, shift(90), [GYM])).toEqual({ gym: 1 });
    expect(streakLevels(WEEK, shift(120), [GYM])).toEqual({ gym: 0 });
  });

  it('caps at twelve weeks and is empty with no recurring blocks', () => {
    const events = Array.from({ length: 20 }, (_, k) => keptWeek(addWeeks(WEEK, -(k + 1)), GYM)).flat();
    expect(streakLevels(WEEK, events, [GYM])).toEqual({ gym: 12 });
    expect(streakLevels(WEEK, events, [])).toEqual({});
  });

  it('a target reached is "just hit" only on the change, never on first sight', () => {
    const s = (done: number) => [{ kind: 'gym', label: 'Gym', done, target: 5 }];
    expect(newlyHit(null, s(5))).toEqual([]);
    expect(newlyHit({ gym: false }, s(5))).toEqual(['gym']);
    expect(newlyHit({ gym: true }, s(5))).toEqual([]);
    expect(newlyHit({ gym: false }, s(4))).toEqual([]);
    expect(newlyHit({}, s(5))).toEqual([]); // a kind that just appeared
  });
});

describe('week boss bar', () => {
  it('drains with tasks done', () => {
    expect(bossBar(health({ tasksDone: 3, tasksTotal: 8 }))).toEqual({ hp: 62, cleared: false, caption: 'Week · 62%' });
    expect(bossBar(health({ tasksDone: 0, tasksTotal: 4 }))!.hp).toBe(100);
  });

  it('uses hours kept against the whole week when there are planned hours', () => {
    // Monday: an hour planned so far and kept, of a 12-hour week — mostly left.
    expect(bossBar(health({ keptMin: 60, plannedMin: 60, tasksDone: 1, tasksTotal: 4 }), 720)!.hp).toBe(92);
    expect(bossBar(health({ keptMin: 180, plannedMin: 360, tasksDone: 1, tasksTotal: 4 }), 720)!.hp).toBe(75);
    expect(bossBar(health({ keptMin: 900, plannedMin: 720, tasksDone: 1, tasksTotal: 4 }), 720)!.hp).toBe(0);
    // Nothing planned yet this week: tasks, as the plain meter does.
    expect(bossBar(health({ tasksDone: 1, tasksTotal: 4 }), 720)!.hp).toBe(75);
  });

  it('knows the whole week of recurring blocks', () => {
    expect(weekPlannedMin([GYM, STREAM])).toBe(5 * 60 + 4 * 180);
    expect(weekPlannedMin([])).toBe(0);
  });

  it('is cleared, in words, once every task is done', () => {
    expect(bossBar(health({ tasksDone: 4, tasksTotal: 4, keptMin: 60, plannedMin: 360 }), 720)).toEqual({
      hp: 0,
      cleared: true,
      caption: 'Week cleared',
    });
  });

  it('hours alone clear it only at the Sunday review', () => {
    const h = health({ keptMin: 360, plannedMin: 360 });
    expect(bossBar(h, 360)!.cleared).toBe(false);
    expect(bossBar(h, 360, true)!.cleared).toBe(true);
    expect(bossBar(health({ keptMin: 300, plannedMin: 360 }), 360, true)!.cleared).toBe(false);
  });

  it('has nothing to show with nothing planned', () => {
    expect(bossBar(health())).toBeNull();
  });
});

describe('objective complete', () => {
  const t = (text: string, done = false) => ({ text, done });

  it('never fires on the first read', () => {
    expect(newlyDone(null, [t('Ship it', true)])).toEqual([]);
  });

  it('finds a line that flipped to done, through the metadata a tick adds', () => {
    expect(newlyDone([t('Ship it ⏫'), t('Rest')], [t('Ship it ⏫ ✅ 2026-09-24', true), t('Rest')])).toEqual([
      'Ship it',
    ]);
    expect(objectiveKey('Ship it ⏫ ✅ 2026-09-24')).toBe(objectiveKey('Ship it'));
  });

  it('ignores lines added already done, deleted, unticked or unchanged', () => {
    expect(newlyDone([t('A')], [t('A'), t('B', true)])).toEqual([]);
    expect(newlyDone([t('A'), t('B')], [t('B')])).toEqual([]);
    expect(newlyDone([t('A', true)], [t('A')])).toEqual([]);
    expect(newlyDone([t('A', true)], [t('A', true)])).toEqual([]);
  });

  it('counts duplicate lines separately', () => {
    expect(newlyDone([t('Stretch'), t('Stretch')], [t('Stretch', true), t('Stretch', true)])).toEqual([
      'Stretch',
      'Stretch',
    ]);
    expect(newlyDone([t('Stretch'), t('Stretch', true)], [t('Stretch', true), t('Stretch', true)])).toEqual([
      'Stretch',
    ]);
  });

  it('queues one plate at a time and merges a burst per bubble', () => {
    let q = enqueueObjectives([], 'intention', ['A'], 1);
    expect(q).toEqual([{ id: 1, bubbleId: 'intention', titles: ['A'] }]);
    const showing = q[0];
    q = enqueueObjectives(q, 'intention', ['B'], 2); // the plate showing isn't changed
    q = enqueueObjectives(q, 'daily', ['C'], 3);
    q = enqueueObjectives(q, 'intention', ['D'], 4);
    expect(q).toEqual([
      { id: 1, bubbleId: 'intention', titles: ['A'] },
      { id: 2, bubbleId: 'intention', titles: ['B', 'D'] },
      { id: 3, bubbleId: 'daily', titles: ['C'] },
    ]);
    expect(q[0]).toBe(showing); // so its timer runs on undisturbed
    expect(enqueueObjectives(q, 'daily', [], 5)).toBe(q);
  });

  it('words a plate', () => {
    expect(objectiveText({ id: 1, bubbleId: 'x', titles: ['Ship it'] })).toEqual({ head: 'Objective complete', detail: 'Ship it' });
    expect(objectiveText({ id: 1, bubbleId: 'x', titles: ['A', 'B', 'C'] })).toEqual({
      head: '3 objectives complete',
      detail: 'A +2',
    });
  });
});

describe('day/night phase', () => {
  it('is day 07–19, dusk 19–22, night 22–07', () => {
    const p = (h: number, m = 0) => dayPhase(at(2026, 9, 21, h, m));
    expect([p(6, 59), p(7), p(18, 59), p(19), p(21, 59), p(22), p(0, 40), p(3)]).toEqual([
      'night',
      'day',
      'day',
      'dusk',
      'dusk',
      'night',
      'night',
      'night',
    ]);
  });
});

describe('today radar', () => {
  const now = at(2026, 9, 21, 10);

  it('places events and blocks on a 06:00–24:00 strip, with the next one named', () => {
    const m = radarModel([ev('Call with Sam', at(2026, 9, 21, 15), 60)], [GYM], now)!;
    expect(m.items.map((i) => [i.label, i.left, i.kind, i.past])).toEqual([
      ['Gym', 0, 'block', true],
      ['Call with Sam', 50, 'event', false],
    ]);
    expect(m.items[1].width).toBeCloseTo(5.6, 1);
    expect(m.now).toBeCloseTo(22.2, 1);
    expect(m.next).toMatchObject({ label: 'Call with Sam' });
  });

  it('draws a block once when a real event covers it, and marks what is on now', () => {
    const m = radarModel([ev('Gym (legs)', at(2026, 9, 21, 6, 30), 60)], [GYM], at(2026, 9, 21, 6, 45))!;
    expect(m.items.map((i) => i.label)).toEqual(['Gym (legs)']);
    expect(m.items[0].current).toBe(true);
    expect(m.next).toBeNull();
    expect(m.current).toBe('Gym (legs)');
    // With something still to come, that is named instead.
    expect(radarModel([ev('Call with Sam', at(2026, 9, 21, 15), 60)], [GYM], at(2026, 9, 21, 6, 30))!.current).toBeNull();
  });

  it('leaves off other days, all-day events and anything outside the strip', () => {
    const m = radarModel(
      [ev('Tomorrow', at(2026, 9, 22, 12)), ev('Holiday', at(2026, 9, 21, 0), 1440, true), ev('Early', at(2026, 9, 21, 4))],
      [],
      now,
    );
    expect(m).toBeNull();
  });

  it('stays calm: at most twelve marks, and no marker before 06:00', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev(`E${i}`, at(2026, 9, 21, 7, i * 30), 15));
    expect(radarModel(many, [], now)!.items).toHaveLength(12);
    expect(radarModel(many, [], at(2026, 9, 21, 5))!.now).toBeNull();
  });
});

describe('mission debrief', () => {
  it('lists what there is to count, gold where it is all done', () => {
    const rows = debriefRows(
      health({ intentionsDone: 3, intentionsTotal: 3, tasksDone: 5, tasksTotal: 8, keptMin: 540, plannedMin: 720 }),
      [
        { kind: 'gym', label: 'Gym', done: 5, target: 5 },
        { kind: 'stream', label: 'Stream', done: 3, target: 4 },
      ],
    );
    expect(rows).toEqual([
      { label: 'Intentions', value: '3/3', done: true },
      { label: 'Tasks', value: '5/8', done: false },
      { label: 'Hours kept', value: '9h / 12h', done: false },
      { label: 'Streaks hit', value: '1/2', done: false },
    ]);
  });

  it('leaves off hours with nothing planned, and streaks with none', () => {
    expect(debriefRows(health({ tasksDone: 2, tasksTotal: 2 }), []).map((r) => r.label)).toEqual(['Tasks']);
    expect(debriefRows(health(), [])).toEqual([]);
  });
});

