import { describe, expect, it } from 'vitest';
import { hasPassed, passedBlocks, titleKey } from '../src/lib/replan';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type { AvailabilityWindow, CalEvent, DurationMap, VaultTask } from '../src/lib/types';

/**
 * Phase 4 §4 — replan undone.
 *
 * "Passed" is the whole question, so most of this file is about the clock: it
 * is injected (`opts.now`), compared as an absolute instant, and pinned across
 * both of Sydney's DST weekends. `vitest.config.ts` sets TZ=Australia/Melbourne;
 * test/dst.test.ts asserts that actually took.
 */

const WEEK = startOfISOWeek(new Date(2026, 8, 2)); // Mon 31 Aug 2026
const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;
const FRI = 4;

const at = (day: number, h: number, m = 0, weekStart = WEEK) => {
  const d = addDays(weekStart, day);
  d.setHours(h, m, 0, 0);
  return d;
};

const ev = (
  uid: string,
  start: Date,
  end: Date,
  over: Partial<CalEvent> = {},
): CalEvent => ({ uid, title: uid, start, end, allDay: false, ...over });

const win = (
  name: string,
  days: number[],
  startMin: number,
  endMin: number,
  minBlockMin = 0,
): AvailabilityWindow => ({ name, days, startMin, endMin, minBlockMin });

const task = (
  text: string,
  line = 0,
  done = false,
  file = 'Weekly/2026-W36.md',
): VaultTask => ({ text, done, file, line });

const DURATIONS: DurationMap = {
  defaultMinutes: 60,
  byKind: { content: 90, admin: 30, deep: 120 },
};

// ---------------------------------------------------------------------------
// "Passed"
// ---------------------------------------------------------------------------

describe('hasPassed — the definition', () => {
  const end = at(MON, 10);

  it('is true only once the whole block is behind now', () => {
    expect(hasPassed(end, at(MON, 9, 59))).toBe(false);
    expect(hasPassed(end, at(MON, 10))).toBe(true); // inclusive at the boundary
    expect(hasPassed(end, at(MON, 10, 1))).toBe(true);
  });

  it('is about the end, not the start — a block in progress has not failed', () => {
    // 09:00–10:00 at 09:30: half done is not undone. This is the clause that
    // stops the rail nagging about the thing the user is doing right now.
    expect(hasPassed(at(MON, 10), at(MON, 9, 30))).toBe(false);
  });

  it('has no grace period', () => {
    // A block that ended a minute ago either happened — tick it — or didn't. A
    // timer that decides which is the board making the call.
    expect(hasPassed(end, new Date(end.getTime() + 1))).toBe(true);
  });
});

describe('hasPassed across a DST transition', () => {
  // Sydney: 04 Oct 2026 is the 23-hour day (02:00 -> 03:00, no 2am), and
  // 05 Apr 2026 is the 25-hour one (03:00 -> 02:00, 2am twice). Comparing
  // absolute instants survives both; comparing wall-clock fields would not.
  it('a block before the spring-forward jump has passed by the time after it', () => {
    const end = new Date(2026, 9, 4, 1, 30); // 01:30, before the skip
    const now = new Date(2026, 9, 4, 3, 30); // 03:30, after it
    expect(hasPassed(end, now)).toBe(true);
    // Only one hour of real time separates them, despite two on the clock.
    expect(now.getTime() - end.getTime()).toBe(60 * 60 * 1000);
  });

  it('a block inside the repeated autumn hour is judged on its instant', () => {
    const end = new Date(2026, 3, 5, 2, 30); // ambiguous wall clock (2:30 twice)
    // An hour after the *first* 02:30 the clock reads 02:30 again — and the
    // block has still passed, because the instant has.
    const now = new Date(end.getTime() + 60 * 60 * 1000);
    expect(hasPassed(end, now)).toBe(true);
    expect(hasPassed(end, new Date(end.getTime() - 1))).toBe(false);
  });

  it('detects a passed block in the 23-hour DST week', () => {
    const dstWeek = startOfISOWeek(new Date(2026, 9, 4)); // Mon 28 Sep 2026
    const blocks = passedBlocks(
      dstWeek,
      [ev('a', at(SUN_OF, 1, 0, dstWeek), at(SUN_OF, 1, 30, dstWeek), { title: 'Edit video A' })],
      [task('Edit video A')],
      { now: at(SUN_OF, 4, 0, dstWeek) },
    );
    expect(blocks.map((b) => b.uid)).toEqual(['a']);
    // Still the last column of the week, not spilled into the next one.
    expect(blocks[0].day).toBe(SUN_OF);
  });
});

const SUN_OF = 6;

// ---------------------------------------------------------------------------
// passedBlocks
// ---------------------------------------------------------------------------

describe('passedBlocks', () => {
  const tasks = [task('Edit video A', 0), task('Book dentist', 1)];

  it('finds a block whose time has gone with the task still unchecked', () => {
    const blocks = passedBlocks(
      WEEK,
      [ev('a', at(MON, 9), at(MON, 10), { title: 'Edit video A' })],
      tasks,
      { now: at(MON, 12) },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      uid: 'a',
      minutes: 60,
      day: MON,
      startMin: 540,
      matchedBy: 'title',
    });
    expect(blocks[0].task.text).toBe('Edit video A');
  });

  it('ignores a block whose task is already ticked', () => {
    expect(
      passedBlocks(
        WEEK,
        [ev('a', at(MON, 9), at(MON, 10), { title: 'Edit video A' })],
        [task('Edit video A', 0, true)],
        { now: at(MON, 12) },
      ),
    ).toEqual([]);
  });

  it('ignores an event that matches no task at all', () => {
    expect(
      passedBlocks(WEEK, [ev('a', at(MON, 9), at(MON, 10))], tasks, {
        now: at(MON, 12),
      }),
    ).toEqual([]);
  });

  it('ignores a block that has not finished yet, and one still to come', () => {
    const blocks = passedBlocks(
      WEEK,
      [
        ev('running', at(MON, 11), at(MON, 13), { title: 'Edit video A' }),
        ev('later', at(THU, 9), at(THU, 10), { title: 'Book dentist' }),
      ],
      tasks,
      { now: at(MON, 12) },
    );
    expect(blocks).toEqual([]);
  });

  it('ignores all-day events — leave is not a work block that slipped', () => {
    expect(
      passedBlocks(
        WEEK,
        [ev('a', at(MON, 0), at(TUE, 0), { title: 'Edit video A', allDay: true })],
        tasks,
        { now: at(WED, 12) },
      ),
    ).toEqual([]);
  });

  it('ignores events outside the rendered week', () => {
    const lastWeek = addDays(WEEK, -7);
    expect(
      passedBlocks(
        WEEK,
        [ev('a', at(MON, 9, 0, lastWeek), at(MON, 10, 0, lastWeek), { title: 'Edit video A' })],
        tasks,
        { now: at(WED, 12) },
      ),
    ).toEqual([]);
  });

  it('matches on the task id first, and says so', () => {
    const blocks = passedBlocks(
      WEEK,
      [ev('a', at(MON, 9), at(MON, 10), { title: 'Renamed in Google', taskId: 'dg1st4' })],
      [task('Edit video A 🆔 dg1st4')],
      { now: at(MON, 12) },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].matchedBy).toBe('id');
    expect(blocks[0].taskId).toBe('dg1st4');
  });

  it('falls back to the title for a block created by a plain drag', () => {
    // The estimate is stripped from both sides, so `~90m` on the task can't
    // stop it matching the event it produced.
    const blocks = passedBlocks(
      WEEK,
      [ev('a', at(MON, 9), at(MON, 10), { title: 'Edit video A' })],
      [task('Edit video A ~90m 🆔 dg1st4')],
      { now: at(MON, 12) },
    );
    expect(blocks[0].matchedBy).toBe('title');
    // The id is still reported, read off the task rather than off the event.
    expect(blocks[0].taskId).toBe('dg1st4');
  });

  it('reports every passed session of a split task', () => {
    const blocks = passedBlocks(
      WEEK,
      [
        ev('s1', at(MON, 9), at(MON, 11), { title: 'Edit video A', taskId: 'x', session: 1, sessions: 3 }),
        ev('s2', at(TUE, 9), at(TUE, 10), { title: 'Edit video A', taskId: 'x', session: 2, sessions: 3 }),
        ev('s3', at(FRI, 9), at(FRI, 10), { title: 'Edit video A', taskId: 'x', session: 3, sessions: 3 }),
      ],
      [task('Edit video A 🆔 x')],
      { now: at(WED, 12) },
    );
    expect(blocks.map((b) => b.uid)).toEqual(['s1', 's2']); // Friday hasn't happened
    expect(blocks.map((b) => b.session)).toEqual([1, 2]);
  });

  it('comes back oldest first', () => {
    const blocks = passedBlocks(
      WEEK,
      [
        ev('later', at(TUE, 9), at(TUE, 10), { title: 'Book dentist' }),
        ev('earlier', at(MON, 9), at(MON, 10), { title: 'Edit video A' }),
      ],
      tasks,
      { now: at(WED, 12) },
    );
    expect(blocks.map((b) => b.uid)).toEqual(['earlier', 'later']);
  });

  it('is empty when nothing is open', () => {
    expect(passedBlocks(WEEK, [ev('a', at(MON, 9), at(MON, 10))], [], { now: at(WED, 1) })).toEqual(
      [],
    );
  });
});

describe('titleKey', () => {
  it('ignores the estimate, the id and the casing', () => {
    expect(titleKey('Edit  video A ~90m 🆔 dg1st4')).toBe('edit video a');
    expect(titleKey('edit video a')).toBe('edit video a');
  });

  it('keeps tags, because the event title keeps them too', () => {
    // The dropped/proposed event is titled with exactly the parsed title, tags
    // included — so both sides must agree, not both be clever.
    expect(titleKey('Edit video A #content')).toBe('edit video a #content');
  });
});

// ---------------------------------------------------------------------------
// The proposal path
// ---------------------------------------------------------------------------
