// Passed blocks — what is left of Phase 4 §4 since the planner was archived.
//
// A block whose time has been and gone, on a task that is still unchecked, is
// the plan admitting it didn't happen. The HUD's week audit (lib/audit.ts)
// counts them. The planner's fit and replan engine (lib/gaps.ts, replanFit)
// went with the planner (Phase 9.4); these are the pieces the HUD still uses.
//
// Pure — the clock is handed in (`opts.now`), never read. That's what makes
// "passed" testable at all, and what lets both Sydney DST weeks be pinned in
// test/replan.test.ts.

import { parseTaskLine } from './duration';
import { DAY_PLANNER_RE } from './source';
import { parseTaskId } from './taskid';
import type { CalEvent, VaultTask } from './types';
import { dayIndex, minutesOfDay } from './week';

/** Default `min_block` for a window that doesn't name one — half an hour. */
export const DEFAULT_MIN_BLOCK = 30;

/** Title comparison key: the display title, lowercased, whitespace collapsed.
 *  Both sides go through `parseTaskLine`, so a `~90m` estimate or a `🆔` on the
 *  task can't stop it matching the event it produced. A Day Planner range in
 *  the task's title is dropped too: the event was titled without it. */
export function titleKey(text: string): string {
  return parseTaskLine(String(text ?? ''))
    .title.replace(DAY_PLANNER_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A block can't be shorter than the grid's own quantum once it's re-proposed;
 *  a 6-minute leftover isn't hours worth replanning. */
const SNAP_FLOOR = 30;

/**
 * **What "passed" means here.**
 *
 * A block has passed when its **end instant is at or before `now`** — not its
 * start. A block that is running right now hasn't failed; it's the thing the user
 * is presumably doing. Only once the whole slot is behind him is there anything
 * to replan, and only then are its hours actually free to spend again.
 *
 * The comparison is on absolute epoch milliseconds (`end.getTime() <=
 * now.getTime()`), never on wall-clock fields. That is the DST-safe form: on
 * Sydney's 23-hour Sunday in October a wall-clock comparison has an hour that
 * doesn't exist, and on the 25-hour Sunday in April it has an hour that happens
 * twice. Instants have neither problem. (Which *column* a block belongs to is
 * still a calendar-field question, so that goes through `dayIndex` — the same
 * split of responsibilities as `busyByDay`.)
 *
 * There is deliberately no grace period. A block that ended a minute ago either
 * happened — tick it — or didn't, and a timer that decides which is a board
 * making the call on the user's behalf.
 */
export function hasPassed(end: Date, now: Date): boolean {
  return end.getTime() <= now.getTime();
}

/** A block whose time has gone and whose source task is still unchecked. */
export interface PassedBlock {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  minutes: number;
  /** Column 0..6 in the rendered week. */
  day: number;
  startMin: number;
  /** The vault task this block was for, still open. */
  task: VaultTask;
  /** The task's Obsidian Tasks `🆔`, when it has one. */
  taskId?: string;
  /** How the block was matched back to its task — `id` is exact, `title` is the
   *  fallback for blocks created before the task had an id (a plain drag). */
  matchedBy: 'id' | 'title';
  /** 1-based session index and total, when the block is one sitting of a split
   *  task (Phase 4 §3). */
  session?: number;
  sessions?: number;
}

export interface PassedOptions {
  /** The caller's clock. Required — this is the whole question. */
  now: Date;
}

/**
 * Blocks in the rendered week that have passed with their task still open.
 *
 * Matching an event back to a task goes id-first, title-second:
 *   1. `extendedProperties.private.wdTaskId` on the event equals the task's
 *      `🆔` — exact, and what every block this app accepts carries.
 *   2. the event's title equals the task's display title. This is the fallback
 *      for a block made by dragging a task onto the grid before §3 existed, or
 *      one typed by hand to match. Without it, replanning would only ever see
 *      the blocks the app itself created, which is the smaller half of the week.
 *
 * All-day events are never candidates: a whole-day entry is leave or a trip,
 * not a work block that slipped.
 */
export function passedBlocks(
  weekStart: Date,
  events: CalEvent[],
  tasks: VaultTask[],
  opts: PassedOptions,
): PassedBlock[] {
  const open = tasks.filter((t) => !t.done);
  if (!open.length) return [];

  const byId = new Map<string, VaultTask>();
  const byTitle = new Map<string, VaultTask>();
  for (const t of open) {
    const id = parseTaskId(t.text);
    // First writer wins in both maps, so a duplicated title resolves to the
    // earliest line rather than depending on iteration order.
    if (id && !byId.has(id)) byId.set(id, t);
    const key = titleKey(t.text);
    if (key && !byTitle.has(key)) byTitle.set(key, t);
  }

  const out: PassedBlock[] = [];
  for (const ev of events) {
    if (ev.allDay) continue;
    const day = dayIndex(ev.start, weekStart);
    if (day < 0 || day > 6) continue;
    if (!hasPassed(ev.end, opts.now)) continue;

    let task: VaultTask | undefined;
    let matchedBy: 'id' | 'title' = 'id';
    if (ev.taskId) task = byId.get(ev.taskId);
    if (!task) {
      task = byTitle.get(titleKey(ev.title));
      matchedBy = 'title';
    }
    if (!task) continue;

    const minutes = Math.max(
      SNAP_FLOOR,
      Math.round((ev.end.getTime() - ev.start.getTime()) / 60000),
    );
    out.push({
      uid: ev.uid,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      minutes,
      day,
      startMin: minutesOfDay(ev.start),
      task,
      taskId: ev.taskId ?? parseTaskId(task.text) ?? undefined,
      matchedBy,
      session: ev.session,
      sessions: ev.sessions,
    });
  }

  // Chronological — the oldest slip is the one that has been waiting longest,
  // and it reads as a list of what went wrong in order.
  out.sort((a, b) => a.start.getTime() - b.start.getTime() || (a.uid < b.uid ? -1 : 1));
  return out;
}
