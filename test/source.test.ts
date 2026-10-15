import { describe, expect, it } from 'vitest';
import {
  DAY_PLANNER_RE,
  dayPlannerRange,
  formatSource,
  obsidianUri,
  parseSource,
  withDayPlannerRange,
  isPlaced,
} from '../src/lib/source';
import { parseTaskMeta } from '../src/lib/taskmeta';

describe('the wdSource anchor', () => {
  it('round-trips a path and line', () => {
    const s = formatSource('Weekly/2026-W36.md', 12);
    expect(s).toBe('Weekly/2026-W36.md#L12');
    expect(parseSource(s)).toEqual({ file: 'Weekly/2026-W36.md', line: 12 });
  });

  it('normalises Windows separators — the vault side always speaks forward slash', () => {
    expect(formatSource(String.raw`Weekly\2026-W36.md`, 3)).toBe('Weekly/2026-W36.md#L3');
  });

  it('survives a path that itself contains spaces and a hash-free name', () => {
    const s = formatSource('Claude Conversations/Week Dashboard/Backlog.md', 0);
    expect(parseSource(s)).toEqual({
      file: 'Claude Conversations/Week Dashboard/Backlog.md',
      line: 0,
    });
  });

  it('is null for anything that is not an anchor', () => {
    for (const bad of [undefined, null, '', 'Weekly/2026-W36.md', '#L4', 'x#Lnope']) {
      expect(parseSource(bad as string)).toBeNull();
    }
  });
});

describe('the obsidian:// URI', () => {
  it('encodes the separator and the spaces', () => {
    // encodeURI would leave both the slash and the spaces literal, and the
    // handler truncates at the first space.
    expect(obsidianUri('quetx', 'Claude Conversations/Week Dashboard/Backlog.md')).toBe(
      'obsidian://open?vault=quetx&file=Claude%20Conversations%2FWeek%20Dashboard%2FBacklog',
    );
  });

  it('drops the .md — Obsidian addresses notes by name', () => {
    expect(obsidianUri('quetx', 'Weekly/2026-W36.md')).toContain('2026-W36');
    expect(obsidianUri('quetx', 'Weekly/2026-W36.md')).not.toContain('.md');
  });

  it('encodes a vault name that needs it', () => {
    expect(obsidianUri('my vault', 'a.md')).toContain('vault=my%20vault');
  });
});

describe('the Day Planner range', () => {
  it('formats as the plugin parses it', () => {
    expect(dayPlannerRange(9 * 60, 10 * 60 + 30)).toBe('09:00 - 10:30');
    expect(dayPlannerRange(0, 30)).toBe('00:00 - 00:30');
    expect(dayPlannerRange(23 * 60 + 30, 24 * 60)).toBe('23:30 - 00:00');
  });

  it('replaces a range rather than stacking one', () => {
    const once = withDayPlannerRange('Fix badge alpha', '09:00 - 10:30');
    expect(once).toBe('09:00 - 10:30 Fix badge alpha');
    // Rescheduling the same task must not produce two ranges.
    expect(withDayPlannerRange(once, '11:00 - 12:00')).toBe(
      '11:00 - 12:00 Fix badge alpha',
    );
  });

  it('takes one back off when the block is deleted', () => {
    expect(withDayPlannerRange('09:00 - 10:30 Fix badge alpha', null)).toBe(
      'Fix badge alpha',
    );
    expect(withDayPlannerRange('Fix badge alpha', null)).toBe('Fix badge alpha');
  });

  it('only matches a range at the start of the body', () => {
    // A time mentioned mid-title is part of the title.
    expect(DAY_PLANNER_RE.test('Call Sam about 09:00 - 10:30')).toBe(false);
  });

  /**
   * The division of labour this whole feature rests on: the range is a
   * *placement*, `~90m` is an *estimate*, and they live on one line without
   * either eating the other.
   */
  it('coexists with the metadata parser rather than being eaten by it', () => {
    const line = withDayPlannerRange('Fix badge alpha ~90m 📅 2026-09-04', '09:00 - 10:30');
    expect(line).toBe('09:00 - 10:30 Fix badge alpha ~90m 📅 2026-09-04');

    const meta = parseTaskMeta(line);
    // The estimate and the due date are parsed out; the range stays in the
    // title, which is where Day Planner and a human reader both expect it.
    expect(meta.fields['wd:est']?.minutes).toBe(90);
    expect(meta.dates.due?.date).toBe('2026-09-04');
    expect(meta.title).toBe('09:00 - 10:30 Fix badge alpha');
    // And it survives a round trip back out.
    expect(DAY_PLANNER_RE.exec(meta.title)?.[1]).toBe('09:00');
  });
});

describe('isPlaced — one predicate for the engine and the rail', () => {
  // Bug #32. The engine and the rail were answering "is this scheduled?"
  // differently: fitTasks correctly refused to propose work that already had
  // a time, while the rail went on counting it as unscheduled — six tasks and
  // nine hours "committed" in a week where nothing was actually outstanding.

  it('a leading range means placed', () => {
    expect(isPlaced('09:00 - 12:00 Restore the ICS parser ~3h')).toBe(true);
    expect(isPlaced('9:00 - 10:30 Book dentist')).toBe(true);
  });

  it('no range means outstanding', () => {
    expect(isPlaced('Book dentist ~1h 📅 2026-09-05')).toBe(false);
    expect(isPlaced('')).toBe(false);
  });

  it('a time inside the title is not a placement', () => {
    expect(isPlaced('Call Sam about the 09:00 - 10:30 slot')).toBe(false);
  });

  it('agrees with what withDayPlannerRange writes and clears', () => {
    // The round trip is the contract: whatever the scheduler stamps on, the
    // predicate must recognise, and whatever it clears must read as open.
    const open = 'Restore the ICS parser ~3h';
    const stamped = withDayPlannerRange(open, dayPlannerRange(540, 720));
    expect(isPlaced(stamped)).toBe(true);
    expect(isPlaced(withDayPlannerRange(stamped, null))).toBe(false);
  });
});
