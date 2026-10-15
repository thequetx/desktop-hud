// Phase 8 — the HUD's bubble registry and the pure rules behind it.
//
// The HUD is a list of **bubbles**, each placed at an anchor (a corner, and its
// own click-through window). A bubble is either a built-in widget or one the
// owner defines in Display & HUD — a note section, a tasks query, a note's
// fields, or plain text. This file answers the questions that don't need React:
//
//   - what each built-in and each bubble type *is* — `WIDGETS`, `BUBBLE_TYPES`;
//   - which bubbles an anchor draws right now, and why the others don't —
//     `bubbleState` / `visibleBubbles`;
//   - what to ask the main process to read — `readersNeeded`, `customRequests`;
//   - the one data shape built from the weekly note — `buildPlaced`.
//
// The drawing lives in `components/hud/widgets.tsx`, keyed by the same ids.
//
// ## Adding a built-in widget
//
//   1. `electron/presentation.cjs` WIDGET_DEFAULTS — the id and its default
//      placement (and `src/lib/presentation.ts`, which a test keeps equal).
//   2. `WIDGETS` below — label, source, focus behaviour, and `reader` if it
//      needs a main-process reader.
//   3. If it reads a note the app doesn't already: a parser + reader in
//      `electron/widgets.cjs`, and its data type in `WidgetData` here.
//   4. The component in `components/hud/widgets.tsx`.
//
// Most new things should not be built-ins at all: a note section, a tasks
// query or a note's fields is a bubble the owner can make in the editor.
//
// The Phase 8 note in the vault (`Action Plan/Phase 8 HUD Widgets.md`) keeps
// the catalogue of built and planned bubbles.

import { addonWidget } from './addons';
import { DEFAULT_LEAD_MIN, leadState } from './upcoming';
import { DAY_PLANNER_RE, isPlaced, withDayPlannerRange } from './source';
import { parseTaskMeta } from './taskmeta';
import type { Anchor, Bubble, BubbleType, PresentationPrefs, WidgetId } from './presentation';
import type { CalEvent, SkeletonBlock, VaultTask } from './types';

/** How a bubble behaves while a focus session is running. The countdown takes
 *  the `upcoming` slot; everything that competes with it for attention goes. */
export type FocusBehaviour = 'keep' | 'hide' | 'replace';

export interface WidgetMeta {
  label: string;
  /** Where the data comes from, named by its slot rather than a product —
   *  shown in Display & HUD after "From". */
  source: string;
  focus: FocusBehaviour;
  /** A main-process reader in electron/widgets.cjs, when it needs one. */
  reader?: 'daily';
  /** Takes a row limit (`rows`). */
  hasRows?: boolean;
}

export const WIDGETS: Record<WidgetId, WidgetMeta> = {
  clock: { label: 'Clock', source: 'your PC’s clock', focus: 'keep' },
  upcoming: { label: 'Next up', source: 'your calendars + recurring blocks', focus: 'replace', hasRows: true },
  placed: { label: 'Placed', source: 'timed tasks in this week’s note', focus: 'hide', hasRows: true },
  weekstrip: { label: 'Week strip', source: 'today’s date and your week start', focus: 'hide' },
  intention: { label: 'Intentions', source: 'this week’s note, under ## Intentions', focus: 'keep', hasRows: true },
  health: { label: 'Week', source: 'this week’s note, your calendars + recurring blocks', focus: 'keep' },
  streaks: { label: 'Streaks', source: 'your recurring blocks, kept or missed', focus: 'hide' },
  daily: { label: 'Today', source: 'today’s daily note: ## Goals, energy', focus: 'hide', reader: 'daily', hasRows: true },
  backlog: { label: 'Backlog', source: 'your backlog note', focus: 'hide' },
  nowplaying: { label: 'Now playing', source: 'what Windows’ media controls say is playing', focus: 'hide' },
  radar: { label: 'Today radar', source: 'today in your calendars + recurring blocks', focus: 'hide' },
};

/** A bubble's registry entry: a built-in, or a private add-on's (lib/addons.ts). Null for neither. */
export function widgetMeta(id: string): WidgetMeta | null {
  return (WIDGETS as Record<string, WidgetMeta>)[id] ?? addonWidget(id) ?? null;
}

/** The bubble types an owner can create, as the editor offers them. */
export const BUBBLE_TYPES: Record<Exclude<BubbleType, 'builtin'>, { label: string; hint: string }> = {
  note: { label: 'Note section', hint: 'The tasks or lines under one heading of a note' },
  tasks: { label: 'Tasks query', hint: 'Open tasks from a folder, filtered by tag, due date or priority' },
  fields: { label: 'Note fields', hint: 'Values from a note’s frontmatter (status, energy…)' },
  text: { label: 'Text', hint: 'Words you type — a reminder, a rule, a mantra' },
};

/** The default number of rows for a bubble that lists things. */
export const DEFAULT_CUSTOM_ROWS = 5;

/** The title a bubble shows: its own, or its type's. */
export function bubbleTitle(b: Bubble): string {
  if (b.title) return b.title;
  if (b.type === 'builtin') return widgetMeta(b.id)?.label ?? b.id;
  return BUBBLE_TYPES[b.type].label;
}

// ---- data from electron/widgets.cjs ---------------------------------------

export interface DailyData {
  file: string;
  exists: boolean;
  goals: { text: string; done: boolean }[];
  energy: number | null;
  motivation: number | null;
}

export interface NoteData {
  exists: boolean;
  file: string;
  /** The heading was there (always true for a whole-note bubble). */
  found: boolean;
  items: { kind: 'task' | 'text'; text: string; done: boolean }[];
}

export interface TasksData {
  items: (VaultTask & { due: string | null })[];
  total: number;
}

export interface FieldsData {
  exists: boolean;
  file: string;
  fields: { key: string; value: string | null }[];
}

export type CustomData = NoteData | TasksData | FieldsData | null;

/** What is playing, from electron/nowplaying.cjs (Windows' media controls). */
export interface NowPlaying {
  playing: boolean;
  title: string;
  artist: string;
  /** The album art as a data: URL, or null. */
  cover: string | null;
  /** Elapsed and total ms, for the progress bar; null when the player omits them. */
  progressMs: number | null;
  totalMs: number | null;
  /** The cover's accent colour (#rrggbb), for the glow; null = cobalt. */
  accent: string | null;
  /** When paused: the last time this same track was seen playing (Hud.tsx). */
  pausedAt?: number | null;
  /** The next songs after this one (at most two), when an add-on supplies a queue. */
  queue?: QueuedTrack[];
}

/** One song waiting in a queue (supplied by an add-on's nowPlayingExtras). */
export interface QueuedTrack {
  title: string;
  artist: string;
  /** An https cover, or null. */
  cover: string | null;
  /** `2:24`, or null. */
  length: string | null;
  /** Who requested it, when it was a request; null otherwise. */
  requester: string | null;
}

/** How long a paused track stays on the HUD (dimming) before it hides. */
export const PAUSE_LINGER_MS = 2 * 60 * 1000;

/** The track's identity: a pause/resume keeps it, a new song changes it. */
export const trackKey = (np: Pick<NowPlaying, 'title' | 'artist'>) => `${np.title}\u0000${np.artist}`;

/**
 * What the Now playing bubble shows: `playing`, `paused` (dimmed, for a
 * while after a pause), or `hidden`.
 *
 * "Paused" needs `pausedAt` — the track was seen playing this session — so
 * starting the PC with Spotify paused doesn't put yesterday's song on the
 * desktop; and it lasts PAUSE_LINGER_MS, after which a pause means "done".
 */
export function nowPlayingState(np: NowPlaying | null | undefined, now: number): 'playing' | 'paused' | 'hidden' {
  if (!np) return 'hidden';
  if (np.playing) return 'playing';
  if (np.pausedAt == null || now - np.pausedAt > PAUSE_LINGER_MS) return 'hidden';
  return 'paused';
}

/** How often Hud.tsx asks what is playing. */
export const NOW_PLAYING_POLL_MS = 4_000;

/**
 * How far through the song the progress bar shows: where it is now. The bar
 * used to aim one poll ahead and slide there over the poll interval; since
 * lean idle (Bug Log #62) it jumps at each poll instead, so it shows the
 * current position.
 */
export function progressTarget(np: Pick<NowPlaying, 'progressMs' | 'totalMs' | 'playing'>): number | null {
  if (np.progressMs == null || !np.totalMs) return null;
  return Math.max(0, Math.min(1, np.progressMs / np.totalMs));
}

export interface WidgetData {
  /** Phase 9.3 — a private add-on bubble's data, by bubble id (lib/addons.ts). */
  addons?: Record<string, unknown>;
  nowplaying?: NowPlaying | null;
  daily?: DailyData | null;
  /** Owner-defined bubbles' data, by bubble id. */
  custom?: Record<string, CustomData>;
}

const inAnchor = (prefs: PresentationPrefs, anchor: Anchor | null) =>
  prefs.hud.bubbles.filter((b) => b.enabled && (anchor == null || b.anchor === anchor));

/** Built-in reader ids the enabled bubbles need — the only notes worth reading. */
export function readersNeeded(prefs: PresentationPrefs, anchor: Anchor | null = null): string[] {
  const ids = new Set<string>();
  for (const b of inAnchor(prefs, anchor)) {
    const r = b.type === 'builtin' ? widgetMeta(b.id)?.reader : undefined;
    if (r) ids.add(r);
  }
  return [...ids];
}

/** The owner-defined bubbles that need a vault read (text needs none). */
export function customRequests(prefs: PresentationPrefs, anchor: Anchor | null = null) {
  return inAnchor(prefs, anchor)
    .filter((b) => b.type === 'note' || b.type === 'tasks' || b.type === 'fields')
    .map((b) => ({ id: b.id, type: b.type, source: b.source }));
}

// ---- show rules ------------------------------------------------------------

/** Skeleton block kinds in progress at `now` — what a `hideDuring` rule is
 *  matched against. Only the recurring skeleton: it is the one place a block
 *  has a *kind*, and "stream" is a kind there. */
export function activeKinds(skeleton: SkeletonBlock[], now: Date): string[] {
  const col = (now.getDay() + 6) % 7;
  const min = now.getHours() * 60 + now.getMinutes();
  const kinds = new Set<string>();
  for (const b of skeleton) {
    if (b.days.includes(col) && b.startMin <= min && min < b.endMin) kinds.add(b.kind);
  }
  return [...kinds];
}

/**
 * Titles of the calendar events in progress at `now`, lower-cased.
 *
 * Found by using it (2026-09-23): the user's recurring blocks live on Google
 * Calendar, not in `week-skeleton.yaml` (`blocks: []`), so a rule keyed only
 * to skeleton kinds would never see a stream. A rule's word is therefore also
 * matched against what's on the calendar right now.
 */
export function activeTitles(events: CalEvent[], now: Date): string[] {
  const t = now.getTime();
  return events
    .filter((e) => !e.allDay && e.start.getTime() <= t && t < e.end.getTime())
    .map((e) => e.title.toLowerCase());
}

export interface ShowContext {
  /** Skeleton block kinds in progress (`activeKinds`). */
  kinds: string[];
  /** Calendar event titles in progress, lower-cased (`activeTitles`). */
  titles?: string[];
  focus: boolean;
  now: Date;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is `word` going on right now — a skeleton block of that kind, or a
 *  calendar event with that word in its title ("Stream", "Twitch stream")? */
export function isDuring(word: string, ctx: ShowContext): boolean {
  if (ctx.kinds.includes(word)) return true;
  return (ctx.titles ?? []).some((t) => titleHasWord(t, word));
}

/** Does a lower-cased event title contain `word` as a whole word? The one
 *  rule for "is this event a stream" — show rules and the stream countdown. */
export function titleHasWord(lowerTitle: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`).test(lowerTitle);
}

/** Stays up during focus mode? The bubble's own choice, else its type's. */
function keepsInFocus(b: Bubble): boolean {
  if (b.show.inFocus != null) return b.show.inFocus;
  return b.type === 'builtin' ? widgetMeta(b.id)?.focus !== 'hide' : false;
}

/**
 * Why a bubble isn't showing right now, in words — or null when it is. Arrange
 * mode and the editor print this, so a rule is never a mystery.
 *
 * Rules only ever *hide*. Nothing here can raise a window, steal focus or make
 * a sound — the HUD's passive posture ([[Decisions]] §9) holds per bubble.
 */
export function bubbleState(b: Bubble, ctx: ShowContext): string | null {
  if (!b.enabled) return 'switched off';
  const hit = b.show.hideDuring.find((k) => isDuring(k, ctx));
  if (hit) return `hidden during ${hit}`;
  if (b.show.onlyDuring.length && !b.show.onlyDuring.some((k) => isDuring(k, ctx))) {
    return `only during ${b.show.onlyDuring.join(' / ')}`;
  }
  const dow = (ctx.now.getDay() + 6) % 7;
  if (b.show.days.length && !b.show.days.includes(dow)) return 'not today';
  if (b.show.hours) {
    const m = ctx.now.getHours() * 60 + ctx.now.getMinutes();
    const { from, to } = b.show.hours;
    const inside = from < to ? m >= from && m < to : m >= from || m < to;
    if (!inside) return `only ${fmtMin(from)}–${fmtMin(to)}`;
  }
  if (ctx.focus && !keepsInFocus(b)) return 'hidden in focus';
  return null;
}

/** `09:30`, from minutes since midnight. */
export function fmtMin(m: number): string {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

/** The bubbles one anchor draws right now, in order. */
export function visibleBubbles(prefs: PresentationPrefs, anchor: Anchor, ctx: ShowContext): Bubble[] {
  return prefs.hud.bubbles.filter((b) => b.anchor === anchor && bubbleState(b, ctx) == null);
}

// ---- placed tasks ------------------------------------------------------------

export interface PlacedRow {
  when: Date;
  endMin: number;
  label: string;
  estMin: number | null;
  priority: string | null;
  imminent?: boolean;
  inMin?: number;
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** `YYYY-MM-DD` in local time, for comparing with a note's `⏳` date. */
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * The week's **placed** vault tasks — lines carrying a leading `HH:MM - HH:MM`
 * — as upcoming rows.
 *
 * The range says *when*; the day comes from the line's `⏳` scheduled date,
 * which is what Weekfit stamps alongside the range when it places a task. A
 * range with no `⏳` has no day to sit on and is skipped rather than guessed.
 *
 * A line the dashboard booked onto the calendar also has an event at the same
 * minute, which the `upcoming` widget already shows — those are dropped here
 * so one piece of work isn't listed twice.
 */
export function buildPlaced(
  tasks: VaultTask[],
  events: CalEvent[],
  now: Date,
  limit = 4,
): PlacedRow[] {
  const eventStarts = new Set(events.map((e) => Math.floor(e.start.getTime() / 60_000)));
  const rows: PlacedRow[] = [];
  for (const t of tasks) {
    if (t.done || !isPlaced(t.text)) continue;
    const range = t.text.trimStart().match(DAY_PLANNER_RE);
    const meta = parseTaskMeta(withDayPlannerRange(t.text, null));
    const day = meta.dates.scheduled?.date;
    if (!range || !day) continue;
    const [y, mo, d] = day.split('-').map(Number);
    const when = new Date(y, mo - 1, d, 0, hm(range[1]), 0, 0);
    const endMin = hm(range[2]);
    const end = new Date(y, mo - 1, d, 0, endMin, 0, 0);
    if (end <= now) continue;
    if (eventStarts.has(Math.floor(when.getTime() / 60_000))) continue;
    rows.push({
      when,
      endMin,
      label: meta.title,
      estMin: meta.fields['wd:est']?.minutes ?? null,
      priority: meta.priority?.level ?? null,
      ...leadState(when, now, DEFAULT_LEAD_MIN),
    });
  }
  return rows.sort((a, b) => a.when.getTime() - b.when.getTime()).slice(0, limit);
}

/**
 * How a Tasks plugin priority (🔺 ⏫ 🔼 🔽 ⏬) is drawn on a HUD row: a small
 * mark in the app's own colours rather than the emoji tile, and the name it is
 * read out as. `none` (`[priority:: normal]`) draws nothing.
 */
export const PRIORITY_MARK: Record<string, { name: string; dir: 'up' | 'down'; n: 1 | 2 }> = {
  highest: { name: 'Highest priority', dir: 'up', n: 2 },
  high: { name: 'High priority', dir: 'up', n: 2 },
  medium: { name: 'Medium priority', dir: 'up', n: 1 },
  low: { name: 'Low priority', dir: 'down', n: 1 },
  lowest: { name: 'Lowest priority', dir: 'down', n: 2 },
};
