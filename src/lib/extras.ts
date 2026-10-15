// Extras — the optional flourishes (Display & HUD → Screens → Extras).
//
// Every one is off by default (`presentation.extras`, validated in
// electron/presentation.cjs), and with all of them off the HUD draws exactly
// what it did before they existed. This file is their pure half: each answers
// one question from data the app already has, so it can be tested without a
// window. The drawing lives beside the bubble each one decorates.
//
// Colour, by the app's rule: gold is done / a streak hit / an achievement,
// crimson only ever escalation, and
// cobalt is the accent. Nothing here brings a new hue.

import { fmtHours } from './duration';
import { computeStreaks, skeletonSlots } from './streaks';
import { withDayPlannerRange } from './source';
import { parseTaskMeta } from './taskmeta';
import { addDays, addWeeks, fmtClock } from './week';
import type { ExtraId } from './presentation';
import type { WeekHealth } from './health';
import type { Streak } from './streaks';
import type { CalEvent, SkeletonBlock } from './types';

/** What each switch is called and does, as the Extras card lists them. */
export const EXTRAS_META: Record<ExtraId, { label: string; hint: string }> = {
  streakLevels: {
    label: 'Streak levels',
    hint: 'LV n beside each streak (weeks in a row on target), and a gold wipe the moment a target is hit.',
  },
  bossBar: {
    label: 'Week boss bar',
    hint: 'The Week meter drains like a boss bar as the week’s work gets done; WEEK CLEARED in gold at the end.',
  },
  objectiveComplete: {
    label: 'Objective complete',
    hint: 'A gold plate over Intentions or Today when you tick one off in the vault. Shows on stream unless that corner is private.',
  },
  dayNight: {
    label: 'Day/night shift',
    hint: 'The HUD cools and dims a touch after dark; the idle screen deepens late at night.',
  },
  debrief: {
    label: 'Mission debrief',
    hint: 'Sunday evening the idle screen shows the week’s results sheet instead of the one-line prompt.',
  },
  upNext: {
    label: 'Up next',
    hint: 'The next two songs in the queue, under Now playing, when the player shares one.',
  },
};

// ---- 1. streak levels ----------------------------------------------------------

/** The most weeks a level counts back. */
export const MAX_LEVEL = 12;

/**
 * Per streak kind, how many consecutive past weeks — last week, the week
 * before, … — met their target, up to `max`. The rule is `computeStreaks`
 * itself run on each earlier week, so "on target" means exactly what the
 * `4/5` in the bubble means. This week doesn't count until it's over.
 *
 * Past weeks are judged against today's recurring blocks: a skeleton that
 * changed shape is read as if it had always been this one.
 */
export function streakLevels(
  weekStart: Date,
  events: CalEvent[],
  skeleton: SkeletonBlock[],
  max = MAX_LEVEL,
): Record<string, number> {
  const levels: Record<string, number> = {};
  const alive = new Set<string>();
  for (const s of computeStreaks(weekStart, [], skeleton)) {
    levels[s.kind] = 0;
    alive.add(s.kind);
  }
  for (let k = 1; k <= max && alive.size > 0; k++) {
    const week = addWeeks(weekStart, -k);
    const end = addWeeks(week, 1);
    const inWeek = events.filter((e) => e.start >= addDays(week, -1) && e.start < addDays(end, 1));
    for (const s of computeStreaks(week, inWeek, skeleton)) {
      if (!alive.has(s.kind)) continue;
      if (s.target > 0 && s.done >= s.target) levels[s.kind] += 1;
      else alive.delete(s.kind);
    }
  }
  return levels;
}

/** Which streak kinds are on target, keyed by kind. */
export function hitMap(streaks: Streak[]): Record<string, boolean> {
  return Object.fromEntries(streaks.map((s) => [s.kind, s.target > 0 && s.done >= s.target]));
}

/**
 * Kinds that have *just* reached their target: known and short of it before,
 * on it now. A kind appearing for the first time (the first load, a new
 * week) is never "just hit", so the wipe plays on the change, not on a render.
 */
export function newlyHit(prev: Record<string, boolean> | null, streaks: Streak[]): string[] {
  if (!prev) return [];
  const now = hitMap(streaks);
  return Object.keys(now).filter((k) => now[k] && prev[k] === false);
}

// ---- 2. week boss bar ------------------------------------------------------------

export interface BossBar {
  /** Boss health left, 0–100: what's still to do this week. */
  hp: number;
  cleared: boolean;
  /** `WEEK · 62%`, or `WEEK CLEARED`. */
  caption: string;
}

/** Minutes of recurring blocks in the whole week — the boss's full health
 *  when the week is measured in hours. */
export function weekPlannedMin(skeleton: SkeletonBlock[]): number {
  return skeletonSlots(skeleton).reduce((n, s) => n + Math.max(0, s.endMin - s.startMin), 0);
}

/**
 * The Week bubble's meter as a boss bar: full at the start of the week,
 * draining as the work is done. Measured like the plain meter — hours kept
 * when there are planned hours, else tasks done — except that hours are
 * counted against the **whole week's** recurring blocks (`weekMin`), not the
 * audit's planned-so-far, which grows as the week goes and would refill the
 * bar. Kept time only accumulates, so the bar only drains.
 *
 * Cleared when every task is done; on the Sunday review, also when every
 * planned hour was kept. Falling behind is never an alarm here: the bar only
 * drains, it doesn't redden.
 */
export function bossBar(h: WeekHealth, weekMin = 0, review = false): BossBar | null {
  const hours = h.plannedMin > 0 && weekMin > 0;
  if (!hours && h.tasksTotal === 0) return null;
  const done = hours
    ? Math.min(100, Math.round((h.keptMin / weekMin) * 100))
    : Math.round((h.tasksDone / h.tasksTotal) * 100);
  const cleared =
    (h.tasksTotal > 0 && h.tasksDone === h.tasksTotal) || (review && h.tasksTotal === 0 && done >= 100);
  const hp = cleared ? 0 : Math.max(0, 100 - done);
  return { hp, cleared, caption: cleared ? 'Week cleared' : `Week · ${hp}%` };
}

// ---- 4. objective complete ------------------------------------------------------------

/** What an item is, for matching the same line across two reads: its title,
 *  without the metadata a tick adds (`✅ 2026-09-24`) or a Day Planner range. */
export function objectiveKey(text: string): string {
  return parseTaskMeta(withDayPlannerRange(text, null)).title.trim().toLowerCase();
}

/**
 * The titles that flipped to done between two reads of a list. A pure diff:
 * `before` null (the first read) is never a completion, nor is a line that
 * arrived already ticked, nor one that was deleted. Duplicate lines count
 * separately.
 */
export function newlyDone(
  before: { text: string; done: boolean }[] | null,
  after: { text: string; done: boolean }[],
): string[] {
  if (!before) return [];
  const tally = (list: { text: string; done: boolean }[]) => {
    const m = new Map<string, { open: number; done: number }>();
    for (const it of list) {
      const k = objectiveKey(it.text);
      const c = m.get(k) ?? { open: 0, done: 0 };
      if (it.done) c.done += 1;
      else c.open += 1;
      m.set(k, c);
    }
    return m;
  };
  const a = tally(before);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of after) {
    const k = objectiveKey(it.text);
    if (!it.done || seen.has(k)) continue;
    seen.add(k);
    const was = a.get(k);
    if (!was) continue;
    const doneNow = after.filter((x) => x.done && objectiveKey(x.text) === k).length;
    const n = Math.min(was.open, doneNow - was.done);
    const title = parseTaskMeta(withDayPlannerRange(it.text, null)).title.trim();
    for (let i = 0; i < n; i++) out.push(title);
  }
  return out;
}

/** How long one OBJECTIVE COMPLETE plate stays up. */
export const OBJECTIVE_MS = 5_000;

export interface ObjectivePlate {
  /** Distinguishes one plate from the next, for the entrance to replay. */
  id: number;
  bubbleId: string;
  titles: string[];
}

/**
 * Add completions to the plate queue. `queue[0]` is the plate on screen and is
 * never changed; completions for a bubble that already has a plate waiting
 * join that plate, so a burst of ticks becomes one plate ("3 objectives
 * complete") and at most one plate per bubble is ever waiting.
 */
export function enqueueObjectives(
  queue: ObjectivePlate[],
  bubbleId: string,
  titles: string[],
  id: number,
): ObjectivePlate[] {
  if (titles.length === 0) return queue;
  // The plate on screen keeps its identity, so its timer isn't restarted.
  const out = queue.map((p, i) => (i === 0 ? p : { ...p, titles: [...p.titles] }));
  const waiting = out.slice(1).find((p) => p.bubbleId === bubbleId);
  if (waiting) waiting.titles.push(...titles);
  else out.push({ id, bubbleId, titles: [...titles] });
  return out;
}

/** The plate's words: the heading, and what was completed. */
export function objectiveText(p: ObjectivePlate): { head: string; detail: string } {
  const n = p.titles.length;
  return {
    head: n > 1 ? `${n} objectives complete` : 'Objective complete',
    detail: n > 1 ? `${p.titles[0]} +${n - 1}` : p.titles[0] ?? '',
  };
}

// ---- 5. day/night shift -------------------------------------------------------------

export type DayPhase = 'day' | 'dusk' | 'night';

/** Day 07–19, dusk 19–22, night 22–07, by the local clock. */
export function dayPhase(now: Date): DayPhase {
  const h = now.getHours();
  if (h >= 7 && h < 19) return 'day';
  if (h >= 19 && h < 22) return 'dusk';
  return 'night';
}

// ---- 6. today radar --------------------------------------------------------------------

/** The radar's span of the day, minutes since midnight: 06:00 (the gym) to midnight. */
export const RADAR_FROM = 6 * 60;
export const RADAR_TO = 24 * 60;
/** More than this and the strip stops being calm; the earliest are kept. */
export const RADAR_MAX = 12;

export interface RadarItem {
  /** Position along the strip, 0–100. */
  left: number;
  width: number;
  label: string;
  kind: 'event' | 'block';
  past: boolean;
  current: boolean;
}

export interface RadarModel {
  items: RadarItem[];
  /** The now-marker, 0–100, or null outside the strip's hours. */
  now: number | null;
  next: { label: string; when: Date; time: string } | null;
  /** What's on right now, when nothing else is still to come. */
  current: string | null;
}

/**
 * Today as a thin strip: a segment per timed event and recurring block, the
 * now-marker, and the next thing named. A recurring block a real event
 * already covers (same day, start within 90 minutes — Next up's rule) is
 * drawn once. Null when today has nothing on it, so the bubble goes.
 */
export function radarModel(events: CalEvent[], skeleton: SkeletonBlock[], now: Date): RadarModel | null {
  const day0 = new Date(now);
  day0.setHours(0, 0, 0, 0);
  const at = (min: number) => new Date(day0.getFullYear(), day0.getMonth(), day0.getDate(), 0, min, 0, 0);
  const from = at(RADAR_FROM).getTime();
  const to = at(RADAR_TO).getTime();
  const span = to - from;
  const NEAR = 90 * 60_000;

  const raw: { start: number; end: number; label: string; kind: 'event' | 'block' }[] = [];
  for (const e of events) {
    if (e.allDay) continue;
    const s = e.start.getTime();
    const en = e.end.getTime();
    if (en <= from || s >= to) continue;
    raw.push({ start: s, end: en, label: e.title, kind: 'event' });
  }
  const col = (now.getDay() + 6) % 7;
  for (const b of skeleton) {
    if (!b.days.includes(col)) continue;
    const s = at(b.startMin).getTime();
    const en = at(b.endMin).getTime();
    if (en <= from || s >= to) continue;
    if (raw.some((r) => r.kind === 'event' && Math.abs(r.start - s) <= NEAR)) continue;
    raw.push({ start: s, end: en, label: b.name, kind: 'block' });
  }
  if (raw.length === 0) return null;
  raw.sort((a, b) => a.start - b.start || a.label.localeCompare(b.label));

  const t = now.getTime();
  const pct = (ms: number) => Math.round(((Math.min(to, Math.max(from, ms)) - from) / span) * 1000) / 10;
  const items = raw.slice(0, RADAR_MAX).map((r) => ({
    left: pct(r.start),
    width: Math.max(0.6, pct(r.end) - pct(r.start)),
    label: r.label,
    kind: r.kind,
    past: r.end <= t,
    current: r.start <= t && t < r.end,
  }));
  const n = raw.find((r) => r.start > t);
  const on = raw.find((r) => r.start <= t && t < r.end);
  return {
    items,
    now: t >= from && t <= to ? pct(t) : null,
    next: n ? { label: n.label, when: new Date(n.start), time: fmtClock(new Date(n.start)) } : null,
    current: !n && on ? on.label : null,
  };
}

// ---- 7. mission debrief ---------------------------------------------------------------

export interface DebriefRow {
  label: string;
  value: string;
  /** All of it done — drawn in gold. */
  done: boolean;
}

/**
 * The Sunday results sheet: intentions, tasks, hours kept against planned
 * (only when there were planned hours) and streaks on target. A line with
 * nothing to count is left off, as the health line does.
 */
export function debriefRows(h: WeekHealth, streaks: Streak[]): DebriefRow[] {
  const rows: DebriefRow[] = [];
  if (h.intentionsTotal > 0) {
    rows.push({
      label: 'Intentions',
      value: `${h.intentionsDone}/${h.intentionsTotal}`,
      done: h.intentionsDone >= h.intentionsTotal,
    });
  }
  if (h.tasksTotal > 0) {
    rows.push({ label: 'Tasks', value: `${h.tasksDone}/${h.tasksTotal}`, done: h.tasksDone >= h.tasksTotal });
  }
  if (h.plannedMin > 0) {
    rows.push({
      label: 'Hours kept',
      value: `${fmtHours(h.keptMin)} / ${fmtHours(h.plannedMin)}`,
      done: h.keptMin >= h.plannedMin,
    });
  }
  if (streaks.length > 0) {
    const hit = streaks.filter((s) => s.target > 0 && s.done >= s.target).length;
    rows.push({ label: 'Streaks hit', value: `${hit}/${streaks.length}`, done: hit === streaks.length });
  }
  return rows;
}
