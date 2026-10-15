import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { displayWeekDays, fmt, makeFmt, setFmtPrefs, systemClockStyle } from '../src/lib/fmt';
import { asLocale, LOCALE_DEFAULTS } from '../src/lib/presentation';
import { WeekStrip } from '../src/components/WeekStrip';
import { auditWeek } from '../src/lib/audit';
import { computeStreaks } from '../src/lib/streaks';
import { streakLevels } from '../src/lib/extras';
import { buildUpcoming } from '../src/lib/upcoming';
import { isReviewTime, weekHealth } from '../src/lib/health';
import { isoWeekId, startOfISOWeek } from '../src/lib/week';
import type { CalEvent, SkeletonBlock, VaultTask } from '../src/lib/types';

// lib/fmt.ts (Phase 9.4): week start, 12/24-hour time and locale apply only to
// what is drawn. The flip test at the bottom is the plan's gate: flipping the
// week start changes rendering, and nothing the app computes.

const require_ = createRequire(import.meta.url);
const presentationStore = require_('../electron/presentation.cjs') as any;

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

afterEach(() => setFmtPrefs(LOCALE_DEFAULTS));

describe('makeFmt — time', () => {
  it('12-hour: the HUD’s compact am/pm', () => {
    const f = makeFmt({ clock: '12h' }, 'en-AU');
    expect(f.clock(at(2026, 10, 15, 9, 30))).toBe('9:30am');
    expect(f.clock(at(2026, 10, 15, 21, 0))).toBe('9pm');
    expect(f.clock(at(2026, 10, 15, 0, 5))).toBe('12:05am');
    expect(f.minutes(390)).toBe('6:30am');
  });

  it('24-hour', () => {
    const f = makeFmt({ clock: '24h' }, 'en-AU');
    expect(f.clock(at(2026, 10, 15, 9, 30))).toBe('09:30');
    expect(f.clock(at(2026, 10, 15, 21, 0))).toBe('21:00');
    expect(f.minutes(1410)).toBe('23:30');
  });

  it('auto follows the locale', () => {
    expect(systemClockStyle('en-US')).toBe('12h');
    expect(systemClockStyle('de-DE')).toBe('24h');
    expect(makeFmt({ clock: 'auto' }, 'de-DE').clock(at(2026, 10, 15, 14, 5))).toBe('14:05');
  });
});

describe('makeFmt — days', () => {
  it('names days and months in the locale, in the HUD’s order', () => {
    expect(makeFmt({}, 'en-AU').longDay(at(2026, 10, 15))).toBe('THU 15 OCT');
    expect(makeFmt({}, 'de-DE').longDay(at(2026, 10, 15))).toBe('DO 15 OKT');
    expect(makeFmt({}, 'fr-FR').dow(at(2026, 10, 15))).toBe('jeu');
  });

  it('says the day only when it isn’t today', () => {
    const f = makeFmt({ clock: '12h' }, 'en-AU');
    const now = at(2026, 10, 15, 8);
    expect(f.when(at(2026, 10, 15, 9), now)).toBe('9am');
    expect(f.when(at(2026, 10, 16, 9), now)).toBe('Fri 9am');
  });

  it('starts the displayed week on Monday or Sunday', () => {
    const thu = at(2026, 10, 15, 12);
    expect(displayWeekDays(makeFmt({ weekStart: 'mon' }), thu).map((d) => d.getDate())).toEqual([12, 13, 14, 15, 16, 17, 18]);
    expect(displayWeekDays(makeFmt({ weekStart: 'sun' }), thu).map((d) => d.getDate())).toEqual([11, 12, 13, 14, 15, 16, 17]);
    // A Sunday is the first day of its own Sunday-start week, the last of a Monday-start one.
    const sun = at(2026, 10, 18, 12);
    expect(displayWeekDays(makeFmt({ weekStart: 'sun' }), sun)[0].getDate()).toBe(18);
    expect(displayWeekDays(makeFmt({ weekStart: 'mon' }), sun)[6].getDate()).toBe(18);
  });

  it('keeps calendar days across the April DST change (Sydney, 25-hour Sunday)', () => {
    const days = displayWeekDays(makeFmt({ weekStart: 'mon' }), at(2026, 4, 8, 12));
    expect(days.map((d) => d.getDate())).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(days.every((d) => d.getHours() === 0)).toBe(true);
  });
});

describe('the locale section of presentation.json', () => {
  it('defaults to Monday and the system clock; refuses anything else', () => {
    expect(presentationStore.defaults().locale).toEqual({ weekStart: 'mon', clock: 'auto' });
    expect(presentationStore.normalise({ v: 3, locale: { weekStart: 'sun', clock: '24h' } }).locale).toEqual({ weekStart: 'sun', clock: '24h' });
    expect(presentationStore.normalise({ v: 3, locale: { weekStart: 'fri', clock: 'sundial', x: 1 } }).locale).toEqual(LOCALE_DEFAULTS);
    expect(presentationStore.normalise({ v: 3 }).locale).toEqual(LOCALE_DEFAULTS);
  });

  it('the renderer fills it in for an older main process', () => {
    expect(asLocale(undefined)).toEqual(LOCALE_DEFAULTS);
    const whole = { weekStart: 'sun', clock: '12h' } as const;
    expect(asLocale(whole)).toBe(whole);
  });
});

describe('the week-start flip changes rendering only', () => {
  const NOW = at(2026, 10, 15, 13, 40); // Thursday
  const WEEK = startOfISOWeek(NOW);
  const skeleton: SkeletonBlock[] = [{ name: 'Gym', kind: 'gym', days: [0, 2, 4], startMin: 360, endMin: 420 }];
  const ev = (title: string, s: Date, mins = 60): CalEvent => ({ uid: title + s.getTime(), title, start: s, end: new Date(s.getTime() + mins * 60_000), allDay: false });
  const events = [ev('Gym', at(2026, 10, 12, 6)), ev('Dentist', at(2026, 10, 16, 10)), ev('Gym', at(2026, 10, 5, 6)), ev('Lunch', at(2026, 10, 18, 12))];
  const tasks: VaultTask[] = [
    { text: 'Ship it', done: false, file: 'Weekly/2026-W42.md', line: 10 },
    { text: 'Book dentist', done: true, file: 'Weekly/2026-W42.md', line: 11 },
  ];

  const compute = () => {
    const streaks = computeStreaks(WEEK, events, skeleton);
    const audit = auditWeek(WEEK, { skeleton, windows: [], events, tasks }, { now: NOW });
    return {
      weekId: isoWeekId(NOW),
      weekStart: startOfISOWeek(NOW).toISOString(),
      streaks,
      levels: streakLevels(WEEK, events, skeleton),
      audit,
      health: weekHealth([], tasks, streaks, audit),
      upcoming: buildUpcoming(events, skeleton, NOW).map((u) => ({ ...u, when: u.when.toISOString() })),
    };
  };
  const draw = () => renderToStaticMarkup(createElement(WeekStrip, { weekStart: WEEK, now: NOW }));

  it('the same week, streaks, audit, health and Next up either way; a different strip', () => {
    setFmtPrefs({ weekStart: 'mon', clock: '12h' });
    const monData = compute();
    const monStrip = draw();
    setFmtPrefs({ weekStart: 'sun', clock: '12h' });
    const sunData = compute();
    const sunStrip = draw();
    expect(sunData).toEqual(monData);
    expect(sunStrip).not.toEqual(monStrip);
    // Monday first: 12…18; Sunday first: 11…17.
    expect(monStrip.match(/q-num">(\d+)</g)!.map((m) => m.replace(/\D/g, ''))).toEqual(['12', '13', '14', '15', '16', '17', '18']);
    expect(sunStrip.match(/q-num">(\d+)</g)!.map((m) => m.replace(/\D/g, ''))).toEqual(['11', '12', '13', '14', '15', '16', '17']);
  });

  it('the end-of-week review moves to the last day of the displayed week', () => {
    const satEvening = at(2026, 10, 17, 18);
    const sunEvening = at(2026, 10, 18, 18);
    setFmtPrefs({ weekStart: 'mon' });
    expect([isReviewTime(satEvening), isReviewTime(sunEvening)]).toEqual([false, true]);
    setFmtPrefs({ weekStart: 'sun' });
    expect([isReviewTime(satEvening), isReviewTime(sunEvening)]).toEqual([true, false]);
    expect(fmt().firstDay).toBe(0);
  });
});
