import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// The ICS parser (electron/icsparse.cjs), which runs in the ICS worker. It is
// the only place the app expands recurrence rules itself. Times in the
// fixtures are UTC so the expectations don't move with the run's timezone.
// Moved from test/ics.test.ts with the parser (Phase 9.4), plus the caps.

const require_ = createRequire(import.meta.url);
const { parseIcs, LIMITS } = require_('../electron/icsparse.cjs') as any;

function cal(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//desktop-hud//test//EN', ...events, 'END:VCALENDAR'].join('\r\n');
}
const ms = (s: string) => Date.parse(s);
const WEEK: [number, number] = [ms('2026-08-24T00:00:00Z'), ms('2026-08-31T00:00:00Z')];
const parse = (text: string, range = WEEK, limits?: unknown) => parseIcs(text, range[0], range[1], limits);
const inWindow = (evs: any[], [a, b] = WEEK) => evs.filter((e) => ms(e.start) >= a && ms(e.start) < b);

describe('parseIcs — plain events', () => {
  it('returns events that overlap the range, as wire events', () => {
    const { events, truncated } = parse(
      cal(
        'BEGIN:VEVENT\r\nUID:in\r\nSUMMARY:In range\r\nDTSTART:20260826T083000Z\r\nDTEND:20260826T093000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:before\r\nSUMMARY:Long past\r\nDTSTART:20260101T000000Z\r\nDTEND:20260101T010000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:after\r\nSUMMARY:Far future\r\nDTSTART:20271201T000000Z\r\nDTEND:20271201T010000Z\r\nEND:VEVENT',
      ),
    );
    expect(truncated).toBeNull();
    expect(events).toEqual([
      { uid: 'in', title: 'In range', description: undefined, start: '2026-08-26T08:30:00.000Z', end: '2026-08-26T09:30:00.000Z', allDay: false },
    ]);
  });

  it('reads a file that starts with a UTF-8 byte-order mark (Bug Log #90)', () => {
    const { events } = parse('﻿' + cal('BEGIN:VEVENT\r\nUID:bom\r\nSUMMARY:Saved by Notepad\r\nDTSTART:20260826T083000Z\r\nDTEND:20260826T093000Z\r\nEND:VEVENT'));
    expect(events.map((e: any) => e.title)).toEqual(['Saved by Notepad']);
  });

  it('marks a DATE-valued event as all-day', () => {
    const { events } = parse(
      cal('BEGIN:VEVENT\r\nUID:ad\r\nSUMMARY:Public holiday\r\nDTSTART;VALUE=DATE:20260826\r\nDTEND;VALUE=DATE:20260827\r\nEND:VEVENT'),
    );
    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(true);
  });

  it('falls back to (untitled) when there is no SUMMARY', () => {
    const { events } = parse(cal('BEGIN:VEVENT\r\nUID:bare\r\nDTSTART:20260826T083000Z\r\nDTEND:20260826T093000Z\r\nEND:VEVENT'));
    expect(events[0].title).toBe('(untitled)');
  });

  it('sorts by start time regardless of file order', () => {
    const { events } = parse(
      cal(
        'BEGIN:VEVENT\r\nUID:late\r\nSUMMARY:Late\r\nDTSTART:20260828T200000Z\r\nDTEND:20260828T210000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:early\r\nSUMMARY:Early\r\nDTSTART:20260825T060000Z\r\nDTEND:20260825T070000Z\r\nEND:VEVENT',
      ),
    );
    expect(events.map((e: any) => e.uid)).toEqual(['early', 'late']);
  });

  it('throws on a file that is not iCalendar (the worker turns it into an error)', () => {
    expect(() => parse('this is not a calendar')).toThrow();
  });
});

describe('parseIcs — recurrence expansion', () => {
  const WEEKLY =
    'BEGIN:VEVENT\r\nUID:stream\r\nSUMMARY:Twitch Stream\r\nDTSTART:20260602T083000Z\r\nDTEND:20260602T113000Z\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH\r\nEND:VEVENT';

  it('expands a rule into one entry per occurrence in the window', () => {
    const got = inWindow(parse(cal(WEEKLY)).events);
    expect(got.map((e: any) => e.start)).toEqual(['2026-08-25T08:30:00.000Z', '2026-08-27T08:30:00.000Z']);
    expect(got.every((e: any) => e.uid === 'stream' && e.title === 'Twitch Stream')).toBe(true);
  });

  it('carries the duration onto every occurrence', () => {
    for (const e of parse(cal(WEEKLY)).events) expect(ms(e.end) - ms(e.start)).toBe(3 * 3_600_000);
  });

  it('stops at the end of the window', () => {
    expect(parse(cal(WEEKLY)).events.filter((e: any) => ms(e.start) > WEEK[1] + 7 * 86_400_000)).toEqual([]);
  });

  it('honours UNTIL', () => {
    const { events } = parse(
      cal(
        'BEGIN:VEVENT\r\nUID:ends\r\nSUMMARY:Ends\r\nDTSTART:20260804T083000Z\r\nDTEND:20260804T093000Z\r\n' +
          'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260819T000000Z\r\nEND:VEVENT',
      ),
    );
    expect(events).toEqual([]);
  });

  it('skips an EXDATEd occurrence', () => {
    const { events } = parse(
      cal(
        'BEGIN:VEVENT\r\nUID:stream\r\nSUMMARY:Twitch Stream\r\nDTSTART:20260602T083000Z\r\nDTEND:20260602T113000Z\r\n' +
          'RRULE:FREQ=WEEKLY;BYDAY=TU,TH\r\nEXDATE:20260825T083000Z\r\nEND:VEVENT',
      ),
    );
    expect(inWindow(events).map((e: any) => e.start)).toEqual(['2026-08-27T08:30:00.000Z']);
  });

  it('applies a RECURRENCE-ID override — the moved/renamed occurrence wins', () => {
    const { events } = parse(
      cal(
        WEEKLY,
        'BEGIN:VEVENT\r\nUID:stream\r\nSUMMARY:Twitch Stream (guest)\r\nRECURRENCE-ID:20260825T083000Z\r\n' +
          'DTSTART:20260825T100000Z\r\nDTEND:20260825T130000Z\r\nEND:VEVENT',
      ),
    );
    const tue = events.filter((e: any) => ms(e.start) >= WEEK[0] && ms(e.start) < ms('2026-08-26T00:00:00Z'));
    expect(tue).toHaveLength(1);
    expect(tue[0]).toMatchObject({ title: 'Twitch Stream (guest)', start: '2026-08-25T10:00:00.000Z', end: '2026-08-25T13:00:00.000Z' });
    expect(events.some((e: any) => e.start === '2026-08-27T08:30:00.000Z')).toBe(true);
  });

  it('walks a daily rule that started years ago into the window (the old 1000-step limit dropped it)', () => {
    const { events, truncated } = parse(
      cal('BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Standup\r\nDTSTART:20180102T230000Z\r\nDTEND:20180102T231500Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT'),
    );
    expect(truncated).toBeNull();
    expect(inWindow(events)).toHaveLength(7);
  });
});

describe('parseIcs — caps (trust model S3)', () => {
  it('caps occurrences across the file and says so', () => {
    const minutely =
      'BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Every minute\r\nDTSTART:20260824T000000Z\r\nDTEND:20260824T000100Z\r\nRRULE:FREQ=MINUTELY\r\nEND:VEVENT';
    const { events, truncated } = parse(cal(minutely), WEEK, { ...LIMITS, maxOccurrences: 500 });
    expect(events).toHaveLength(500);
    expect(truncated).toBe('occurrences');
  });

  it('caps recurrence steps, so a rule that never reaches the window cannot spin', () => {
    // Every second since 2000: millions of steps before August 2026.
    const secondly =
      'BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Hostile\r\nDTSTART:20000101T000000Z\r\nDTEND:20000101T000001Z\r\nRRULE:FREQ=SECONDLY\r\nEND:VEVENT';
    const t = Date.now();
    const { events, truncated } = parse(cal(secondly));
    expect(Date.now() - t).toBeLessThan(5000);
    expect(events).toEqual([]);
    expect(truncated).toBe('steps');
  });

  it('caps the number of events read from one file', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      `BEGIN:VEVENT\r\nUID:e${i}\r\nSUMMARY:E${i}\r\nDTSTART:20260826T0800${String(i).padStart(2, '0')}Z\r\nDTEND:20260826T090000Z\r\nEND:VEVENT`,
    );
    const { events, truncated } = parse(cal(...many), WEEK, { ...LIMITS, maxEvents: 10 });
    expect(events).toHaveLength(10);
    expect(truncated).toBe('events');
  });

  it('trims very long titles and descriptions', () => {
    const { events } = parse(
      cal(
        `BEGIN:VEVENT\r\nUID:long\r\nSUMMARY:${'x'.repeat(2000)}\r\nDESCRIPTION:${'y'.repeat(9000)}\r\nDTSTART:20260826T083000Z\r\nDTEND:20260826T093000Z\r\nEND:VEVENT`,
      ),
    );
    expect(events[0].title).toHaveLength(500);
    expect(events[0].description).toHaveLength(4000);
  });
});
