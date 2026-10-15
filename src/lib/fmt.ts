// Formatting dates and times for the screen (Phase 9.4): the one place week
// start, 12/24-hour time and locale apply.
//
// The rule: data stays ISO and Monday-indexed everywhere else (weekly notes
// are ISO weeks, skeleton `days` are Monday-first columns, streaks and the
// audit count Monday to Sunday). Only what is drawn goes through here, so
// flipping the week start changes rendering and nothing else
// (test/fmt.test.ts).
//
// Names come from Intl in the system locale; the compact HUD order ("Thu 15
// Oct", "9:30am") is this app's own and stays the same in every locale.

import type { LocalePrefs } from './presentation';

export type ClockStyle = '12h' | '24h';

export interface Fmt {
  /** 0 when the week starts on Sunday, 1 on Monday (Date#getDay numbering). */
  readonly firstDay: 0 | 1;
  readonly clockStyle: ClockStyle;
  /** "9:30am" / "9am", or "09:30" in 24-hour time. */
  clock(d: Date): string;
  /** The same, from minutes since midnight. */
  minutes(min: number): string;
  /** "Thu", in the locale. */
  dow(d: Date): string;
  /** "THU 15 OCT". */
  longDay(d: Date): string;
  /** "Thu 9:30am" when `d` isn't today, else just the time. */
  when(d: Date, now: Date): string;
  /** Midnight on the first day of the displayed week holding `d`. */
  displayWeekStart(d: Date): Date;
  /** The last day of the displayed week: Sunday, or Saturday for a Sunday start. */
  isLastDayOfWeek(d: Date): boolean;
}

/** 12- or 24-hour time as the system locale has it. */
export function systemClockStyle(locale?: string): ClockStyle {
  try {
    const hc = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h23' || hc === 'h24' ? '24h' : '12h';
  } catch {
    return '12h';
  }
}

export function makeFmt(prefs: Partial<LocalePrefs> = {}, locale?: string): Fmt {
  const firstDay: 0 | 1 = prefs.weekStart === 'sun' ? 0 : 1;
  const clockStyle: ClockStyle = prefs.clock === '12h' || prefs.clock === '24h' ? prefs.clock : systemClockStyle(locale);
  let dowF: Intl.DateTimeFormat;
  let monF: Intl.DateTimeFormat;
  try {
    dowF = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    monF = new Intl.DateTimeFormat(locale, { month: 'short' });
  } catch {
    dowF = new Intl.DateTimeFormat('en', { weekday: 'short' });
    monF = new Intl.DateTimeFormat('en', { month: 'short' });
  }
  // Some locales add a full stop ("Do.", "oct."); the HUD's compact style doesn't.
  const short = (s: string) => s.replace(/\.$/, '');

  const hm = (h: number, m: number) => {
    if (clockStyle === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const ampm = h < 12 ? 'am' : 'pm';
    const h12 = ((h + 11) % 12) + 1;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  };

  const fmt: Fmt = {
    firstDay,
    clockStyle,
    clock: (d) => hm(d.getHours(), d.getMinutes()),
    minutes: (min) => hm(Math.floor(min / 60) % 24, min % 60),
    dow: (d) => short(dowF.format(d)),
    longDay: (d) => `${short(dowF.format(d))} ${d.getDate()} ${short(monF.format(d))}`.toUpperCase(),
    when: (d, now) => {
      const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      return same ? fmt.clock(d) : `${fmt.dow(d)} ${fmt.clock(d)}`;
    },
    displayWeekStart: (d) => {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      x.setDate(x.getDate() - ((x.getDay() - firstDay + 7) % 7));
      return x;
    },
    isLastDayOfWeek: (d) => d.getDay() === (firstDay + 6) % 7,
  };
  return fmt;
}

// The app's current formatter: set from presentation.json's `locale` section
// whenever it loads or changes (App.tsx), read by everything that draws.
let current = makeFmt();

export function fmt(): Fmt {
  return current;
}

export function setFmtPrefs(prefs: Partial<LocalePrefs> | undefined): void {
  current = makeFmt(prefs ?? {});
}

/** The seven days of the displayed week holding `d`, in display order. */
export function displayWeekDays(f: Fmt, d: Date): Date[] {
  const start = f.displayWeekStart(d);
  // Calendar days, not 24-hour steps: a DST week has a 23- or 25-hour day.
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
