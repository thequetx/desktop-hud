// Phase 8 — what each bubble draws: the built-in widgets keyed by id, and the
// owner-defined bubble types keyed by type.
//
// Every bubble here is **read-only**: the HUD windows are click-through, so a
// control drawn in one can never be pressed (bug #20). Where there is
// something to act on, the bubble says where to do it instead.
//
// A bubble with nothing to say returns null and disappears — the HUD should
// never show an empty card or a `0/0` at you. (Arrange mode and the editor
// preview show a placeholder instead, so an empty bubble can still be found.)
//
// These are plain functions with **no hooks**: Hud.tsx calls them directly so
// it can see the null before deciding whether to draw a bubble at all.
//
// Empty states (Phase 9.5). A bubble whose *source isn't set up* says so in
// one line of text, naming where to fix it; a bubble whose source is set up but
// has nothing to say right now hides. Text, never a button: the HUD is
// click-through. Per bubble:
//   - Next up: no calendar and no recurring blocks → "No calendar yet".
//   - Intentions: the notes folder can't be found → "Notes folder not found".
//   - Clock, Week strip: always have something to show.
//   - Everything else (Today radar, Placed, Week, Streaks, Today, Backlog, Now
//     playing, note sections, tasks, fields, text) hides when empty: each reads
//     a source that always exists (the built-in notes, Windows' media
//     controls), so empty only means nothing is written or playing yet.

import { addonWidget, rendererAddons } from '../../lib/addons';
import type { ReactNode } from 'react';
import { fmtClock, fmtLongDay, sameDate } from '../../lib/week';
import { fmt } from '../../lib/fmt';
import { buildUpcoming, syntheticUpcoming } from '../../lib/upcoming';
import { fmtEstimate, fmtHours } from '../../lib/duration';
import { weekHealth, isReviewTime, reviewPrompt } from '../../lib/health';
import { parseTaskMeta } from '../../lib/taskmeta';
import { withDayPlannerRange } from '../../lib/source';
import {
  bubbleTitle,
  buildPlaced,
  DEFAULT_CUSTOM_ROWS,
  localIsoDate,
  nowPlayingState,
  PRIORITY_MARK,
  progressTarget,
  trackKey,
} from '../../lib/widgets';
import type { FieldsData, NoteData, TasksData, WidgetData } from '../../lib/widgets';
import type { Bubble, PresentationPrefs, WidgetId } from '../../lib/presentation';
import type { WeekAudit } from '../../lib/audit';
import type { Streak } from '../../lib/streaks';
import type { CalEvent, FocusSession, SkeletonBlock, VaultTask, VaultWeek } from '../../lib/types';
import { bossBar, objectiveText, radarModel, weekPlannedMin } from '../../lib/extras';
import type { BossBar, ObjectivePlate as Plate } from '../../lib/extras';
import { Streaks } from '../Streaks';
import { WeekStrip } from '../WeekStrip';

export interface WidgetProps {
  bubble: Bubble;
  now: Date;
  weekStart: Date;
  weekId: string;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  streaks: Streak[];
  vault: VaultWeek | null;
  audit: WeekAudit | null;
  data: WidgetData;
  backlog: VaultTask[];
  focus: FocusSession | null;
  presentation: PresentationPrefs;
  error: string | null;
  /** Debug placeholder rows (Ctrl+Alt+Shift+H), or null. */
  debugRows: number | null;
  /** Extras: streak levels by kind, once the past weeks have been read. */
  levels?: Record<string, number> | null;
  /** What is set up (Phase 9.5), for the empty states. Absent = unknown, and
   *  no set-up line is drawn. */
  setup?: SetupState;
}

/** Which sources are connected, as the HUD last heard. */
export interface SetupState {
  /** Calendar links and files added; null until known. */
  calendars: number | null;
  /** The notes folder is set but can't be read. */
  notesMissing: boolean;
  /** Offline (Phase 9.6): when a calendar link has been failing and its last
   *  good copy is older than STALE_AFTER_MS, the time of that copy. */
  staleSince?: number | null;
}

/** How old a failing calendar's copy gets before Next up says so. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** The oldest last-good time among calendar links that are failing and older
 *  than STALE_AFTER_MS, or null when every calendar is fresh enough. */
export function staleSince(sources: { kind: string; fetchedAt: number | null; lastError: string | null }[], now = Date.now()): number | null {
  const old = sources
    .filter((s) => s.kind === 'ics-url' && s.lastError && s.fetchedAt && now - s.fetchedAt > STALE_AFTER_MS)
    .map((s) => s.fetchedAt as number);
  return old.length ? Math.min(...old) : null;
}

/** A source isn't set up: one line saying so, and where to do it. */
function SetupLine({ what, todo }: { what: string; todo: string }) {
  return (
    <p className="bub__setup">
      <span className="bub__setup-what">{what}</span> <span className="bub__setup-where">{todo} in Display &amp; HUD → Integrations.</span>
    </p>
  );
}

/** `Thu 06:00`, or just `06:00` when it's today. */
function when(d: Date, now: Date): string {
  return fmt().when(d, now);
}

/** `Thu 26`, or `today` / `overdue` — for a due date on a task row. */
function dueLabel(iso: string, now: Date): string {
  const today = localIsoDate(now);
  if (iso < today) return 'overdue';
  if (iso === today) return 'today';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${fmt().dow(dt)} ${d}`;
}

export const rowsOf = (p: WidgetProps, fallback: number) => p.bubble.rows ?? fallback;

export function Title({ p, note }: { p: WidgetProps; note?: ReactNode }) {
  return (
    <p className="bub__title q-label">
      <span>{bubbleTitle(p.bubble)}</span>
      {note != null && <span className="bub__note">{note}</span>}
    </p>
  );
}

/** A Tasks priority as a small drawn mark (chevrons up or down) in the HUD's
 *  own colours, named for screen readers and on hover. */
export function Prio({ level }: { level: string | null | undefined }) {
  const m = level ? PRIORITY_MARK[level] : undefined;
  if (!m) return null;
  return (
    <span className={`prio prio--${level} prio--${m.dir}`} role="img" aria-label={m.name} title={m.name}>
      <i />
      {m.n === 2 && <i />}
    </span>
  );
}

/** A task line as the HUD shows it: priority mark, title without metadata or
 *  a Day Planner range, and the due date when there is one. */
function TaskRow({ text, done, due, now }: { text: string; done: boolean; due?: string | null; now: Date }) {
  const meta = parseTaskMeta(withDayPlannerRange(text, null));
  return (
    <li className={done ? 'is-done' : undefined}>
      <Prio level={meta.priority?.level} />
      {meta.title}
      {due ? <span className="u__est"> · {dueLabel(due, now)}</span> : null}
    </li>
  );
}

// ---- built-ins -----------------------------------------------------------------

function Clock({ now, events, skeleton, presentation }: WidgetProps) {
  return (
    <header className="hud__head">
      <span className="hud__time q-num">{fmtClock(now)}</span>
      <span className="hud__day q-label">{fmtLongDay(now)}</span>
      {/* Private add-ons' Clock extras (Phase 9.3), e.g. a stream countdown. */}
      {rendererAddons().map((a) => {
        const Extra = a.clockExtra;
        if (!Extra) return null;
        const section = (presentation.addons ?? {})[a.id] as Record<string, unknown> | undefined;
        return <Extra key={a.id} section={section} presentation={presentation} events={events} skeleton={skeleton} now={now} />;
      })}
    </header>
  );
}

/**
 * Phase 6 §2 — the focus panel. One block, one countdown; deliberately not a
 * Pomodoro app (no intervals, no breaks, no sound). It takes the `upcoming`
 * bubble's place while a session runs.
 */
function FocusPanel({ focus, now }: { focus: FocusSession; now: Date }) {
  const end = new Date(focus.end);
  const leftMs = end.getTime() - now.getTime();
  const over = leftMs <= 0;
  const mins = Math.max(0, Math.ceil(leftMs / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return (
    <div className={over ? 'focus focus--over' : 'focus'}>
      <p className="focus__label q-label">Focus</p>
      <p className="focus__title">{focus.title}</p>
      <p className="focus__left q-num">
        {over ? 'time' : h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`}
      </p>
      {/* Click-through window, so the way out is a hotkey or the tray (bug #20).
          It also ends by itself when the block does. */}
      <p className="focus__hint">{over ? 'ending' : 'Ctrl+Alt+F or the tray to stop'}</p>
    </div>
  );
}

function Upcoming(p: WidgetProps) {
  if (p.focus) return <FocusPanel focus={p.focus} now={p.now} />;
  const rows =
    p.debugRows != null
      ? syntheticUpcoming(p.debugRows, p.now)
      : buildUpcoming(p.events, p.skeleton, p.now, rowsOf(p, p.presentation.hud.upcomingRows));
  return (
    <>
      {p.bubble.title && <Title p={p} />}
      {rows.length === 0 && p.setup?.calendars === 0 && p.skeleton.length === 0 ? (
        <SetupLine what="No calendar yet." todo="Add one" />
      ) : (
      <ul className="hud__list">
        {rows.map((u, i) => (
          <li key={i} className={`u u--${u.kind}${u.imminent ? ' u--imminent' : ''}`}>
            {/* Phase 6 §1 — inside its lead window the time becomes a live
                countdown; crimson is the HUD's one escalation colour. */}
            <span className="u__time q-num">{u.imminent ? `in ${u.inMin}m` : when(u.when, p.now)}</span>
            <span className="u__label">{u.label}</span>
          </li>
        ))}
        {rows.length === 0 && <li className="muted">nothing scheduled</li>}
      </ul>
      )}
      {p.setup?.staleSince ? (
        <p className="bub__stale">Calendar not updated since {when(new Date(p.setup.staleSince), p.now)}</p>
      ) : null}
      {p.error && <div className="hud__err">calendar offline</div>}
    </>
  );
}

function Placed(p: WidgetProps) {
  const rows = buildPlaced(
    [...(p.vault?.tasks ?? []), ...(p.vault?.thisweek ?? [])],
    p.events,
    p.now,
    rowsOf(p, p.presentation.hud.upcomingRows),
  );
  if (rows.length === 0) return null;
  return (
    <>
      <Title p={p} />
      <ul className="hud__list">
        {rows.map((r, i) => (
          <li key={i} className={`u u--placed${r.imminent ? ' u--imminent' : ''}`}>
            <span className="u__time q-num">{r.imminent ? `in ${r.inMin}m` : when(r.when, p.now)}</span>
            <span className="u__label">
              <Prio level={r.priority} />
              {r.label}
              {r.estMin ? <span className="u__est"> · {fmtEstimate(r.estMin)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Intention(p: WidgetProps) {
  const list = p.vault?.intentions ?? [];
  if (list.length === 0) {
    if (!p.setup?.notesMissing) return null;
    return (
      <>
        <Title p={p} />
        <SetupLine what="Notes folder not found." todo="Fix it" />
      </>
    );
  }
  const done = list.filter((t) => t.done).length;
  return (
    <>
      <Title p={p} note={<span className="q-num">{done}/{list.length}</span>} />
      <ul className="chk">
        {list.slice(0, rowsOf(p, 4)).map((t, i) => (
          <TaskRow key={i} text={t.text} done={t.done} now={p.now} />
        ))}
      </ul>
    </>
  );
}

function Health(p: WidgetProps) {
  const h = weekHealth(
    p.vault?.intentions ?? [],
    [...(p.vault?.tasks ?? []), ...(p.vault?.thisweek ?? [])],
    p.streaks,
    p.audit,
  );
  // Sunday evening it stops reporting and asks — the same turn the idle
  // screen takes (Phase 6 §3).
  const boss = p.presentation.extras.bossBar ? bossBar(h, weekPlannedMin(p.skeleton), isReviewTime(p.now)) : null;
  if (isReviewTime(p.now)) {
    return (
      <>
        <Title p={p} />
        <p className="bub__line">{reviewPrompt(p.weekId, h)}</p>
        {boss && <BossMeter boss={boss} />}
      </>
    );
  }
  if (h.plannedMin <= 0 && h.tasksTotal === 0) return null;
  // Hours kept against planned when there are planned hours (recurring blocks
  // in the skeleton); otherwise the week's tasks, which is what a week planned
  // in the vault actually has.
  const hours = h.plannedMin > 0;
  const pct = hours
    ? Math.min(100, Math.round((h.keptMin / h.plannedMin) * 100))
    : Math.round((h.tasksDone / h.tasksTotal) * 100);
  return (
    <>
      <Title p={p} note={h.unplanned > 0 ? `${h.unplanned} unplanned` : undefined} />
      {hours ? (
        <p className="bub__line">
          <span className="q-num">{fmtHours(h.keptMin)}</span> kept of{' '}
          <span className="q-num">{fmtHours(h.plannedMin)}</span> planned
        </p>
      ) : (
        <p className="bub__line">
          <span className="q-num">{h.tasksDone}</span> of <span className="q-num">{h.tasksTotal}</span> tasks done
          {h.placed > 0 && <span className="muted"> · {h.placed} placed</span>}
        </p>
      )}
      {boss ? (
        <BossMeter boss={boss} />
      ) : (
        <div className="meter">
          <b style={{ width: `${pct}%` }} />
        </div>
      )}
    </>
  );
}

/** Extras: the Week meter as a boss bar — its health is what's left to do.
 *  Cobalt while it drains, gold once cleared; never crimson. */
function BossMeter({ boss }: { boss: BossBar }) {
  return (
    <div className={boss.cleared ? 'boss is-cleared' : 'boss'}>
      <span className="boss__cap q-label">{boss.caption}</span>
      <div className="meter boss__bar">
        <b style={{ width: `${boss.cleared ? 100 : boss.hp}%` }} />
      </div>
    </div>
  );
}

function StreakBars(p: WidgetProps) {
  if (p.debugRows != null || p.streaks.length === 0) return null;
  return (
    <>
      {p.bubble.title && <Title p={p} />}
      <Streaks
        streaks={p.streaks}
        levels={p.presentation.extras.streakLevels ? p.levels ?? null : null}
        celebrate={p.presentation.extras.streakLevels}
      />
    </>
  );
}

function Strip({ weekStart, now }: WidgetProps) {
  return <WeekStrip weekStart={weekStart} now={now} />;
}

function Daily(p: WidgetProps) {
  const d = p.data.daily;
  if (!d || !d.exists) return null;
  const goals = d.goals
    .map((g) => ({ ...g, meta: parseTaskMeta(g.text) }))
    // Open first, then by the Tasks priority — the same order as the rail.
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) || (a.meta.priority?.rank ?? 3) - (b.meta.priority?.rank ?? 3),
    );
  const score = [
    d.energy != null ? `energy ${d.energy}` : null,
    d.motivation != null ? `motivation ${d.motivation}` : null,
  ].filter(Boolean);
  if (goals.length === 0 && score.length === 0) return null;
  const done = goals.filter((g) => g.done).length;
  return (
    <>
      <Title p={p} note={goals.length ? <span className="q-num">{done}/{goals.length}</span> : undefined} />
      {goals.length > 0 && (
        <ul className="chk">
          {goals.slice(0, rowsOf(p, 4)).map((g, i) => (
            <TaskRow key={i} text={g.text} done={g.done} now={p.now} />
          ))}
        </ul>
      )}
      {score.length > 0 && <p className="bub__sub">{score.join(' · ')}</p>}
    </>
  );
}

function Backlog(p: WidgetProps) {
  const open = p.backlog.filter((t) => !t.done);
  if (open.length === 0) return null;
  return (
    <>
      <Title p={p} note={<span className="q-num">{open.length}</span>} />
      <p className="bub__sub">last · {parseTaskMeta(open[open.length - 1].text).title}</p>
    </>
  );
}

/**
 * What Windows' media controls say is playing (electron/nowplaying.cjs). Shows
 * only while something is actually playing, and for a while after a pause.
 * Display-only: play/pause buttons would need clicks, and the HUD never takes
 * them.
 */
function NowPlayingBubble(p: WidgetProps) {
  const np = p.data.nowplaying;
  const state = nowPlayingState(np, p.now.getTime());
  if (!np || state === 'hidden') return null;
  const paused = state === 'paused';
  // Keyed on the track, so a new song re-mounts this and its CSS entrance
  // plays — the "swipe". No state, no timers: the key change is the event.
  // The swipe comes in from the corner's own side.
  const from = p.bubble.anchor.endsWith('left') ? 'np--from-left' : 'np--from-right';
  // Extras — Up next: the next songs in the queue, as the card's footer.
  const next = p.presentation.extras.upNext ? (np.queue ?? []).slice(0, 2) : [];
  const card = (
    <div
      className={`np ${from}${paused ? ' np--paused' : ''}`}
      key={trackKey(np)}
    >
      {np.cover ? <img className="np__art" src={np.cover} alt="" /> : <span className="np__art np__art--none">♪</span>}
      <span className="np__text">
        <span className="np__cap q-label">
          {paused ? 'Paused' : p.bubble.title || 'Now playing'}
          {paused ? (
            <span className="np__pause" aria-hidden="true">
              <i />
              <i />
            </span>
          ) : (
            // Decoration, not a meter: the HUD can't hear the audio.
            <span className="np__eq" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
        <span className="np__title">{np.title}</span>
        {np.artist && <span className="np__artist">{np.artist}</span>}
      </span>
      {progressTarget(np) != null && (
        <span className="np__bar" aria-hidden="true">
          <b style={{ transform: `scaleX(${progressTarget(np)})` }} />
        </span>
      )}
    </div>
  );
  if (next.length === 0) return card;
  return (
    <>
      {card}
      {/* Keyed on the song and the queue, so a song change (or a new request)
          deals the rows in again, from the same side as the card's swipe. */}
      <div
        className={`npq ${from}${paused ? ' npq--paused' : ''}`}
        key={`${trackKey(np)}\u0001${next.map(trackKey).join('\u0001')}`}
      >
        <p className="npq__cap q-label">Up next</p>
        <ol className="npq__list">
          {next.map((t, i) => (
            <li key={i} className="npq__row" style={{ '--i': i } as Record<string, number>}>
              {t.cover ? (
                <img className="npq__art" src={t.cover} alt="" />
              ) : (
                <span className="npq__art npq__art--n q-num">{i + 1}</span>
              )}
              <span className="npq__text">
                <span className="npq__title">{t.title}</span>
                {/* A requested song shows who asked instead of the artist, so a
                    Fit card keeps room for the title (the owner's call, 2026-09-24). */}
                {t.artist && !t.requester && <span className="npq__artist">{t.artist}</span>}
              </span>
              {t.requester && <span className="npq__req q-label">req · {t.requester}</span>}
              {t.length && <span className="npq__len q-num">{t.length}</span>}
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

/**
 * Extras: OBJECTIVE COMPLETE — a gold-edged plate over the bubble whose
 * intention or goal was just ticked off in the vault. Drawn inside that
 * bubble's own card (no window, no notification); Hud.tsx queues them so
 * only one shows at a time, for OBJECTIVE_MS.
 */
export function ObjectivePlate({ plate }: { plate: Plate }) {
  const t = objectiveText(plate);
  return (
    <div className="objective q-plate" role="status">
      <span className="objective__head q-label">{t.head}</span>
      <span className="objective__detail">{t.detail}</span>
    </div>
  );
}

/**
 * Today radar (an Extra, off by default): today as one thin strip, 06:00 to
 * midnight — a segment per event and recurring block, a now-marker that
 * slides along it, and the next thing named underneath. Nothing else is
 * labelled on the strip: the names are what Next up is for.
 */
function Radar(p: WidgetProps) {
  const m = radarModel(p.events, p.skeleton, p.now);
  if (!m) return null;
  return (
    <>
      <Title p={p} />
      <div className="radar" aria-hidden="true">
        <span className="radar__track">
          {m.items.map((it, i) => (
            <i
              key={i}
              className={`radar__seg radar__seg--${it.kind}${it.past ? ' is-past' : ''}${it.current ? ' is-now' : ''}`}
              style={{ left: `${it.left}%`, width: `${it.width}%` }}
            />
          ))}
          {m.now != null && <b className="radar__now" style={{ left: `${m.now}%` }} />}
        </span>
        <span className="radar__scale q-num">
          <span style={{ left: '0%' }}>06</span>
          <span style={{ left: '33.333%' }}>12</span>
          <span style={{ left: '66.667%' }}>18</span>
          <span style={{ left: '100%' }}>24</span>
        </span>
      </div>
      <p className="radar__next">
        {m.next ? (
          <>
            <span className="radar__cap q-label">Next</span>
            <span className="u__time q-num">{m.next.time}</span>
            <span className="radar__label">{m.next.label}</span>
          </>
        ) : m.current ? (
          <>
            <span className="radar__cap q-label">Now</span>
            <span className="radar__label">{m.current}</span>
          </>
        ) : (
          <span className="muted">Nothing else today</span>
        )}
      </p>
    </>
  );
}

/**
 * Extra style a bubble's *card* needs from its data — today only the Now
 * playing glow colour, which has to sit on the card (not inside it) so the
 * border and tint can use it. Not while paused: the stylesheet greys the
 * card then, and an inline colour would win over it.
 */
export function bubbleDataStyle(b: Bubble, data: WidgetData, now = Date.now()): Record<string, string> | undefined {
  if (b.id !== 'nowplaying') return undefined;
  const np = data.nowplaying;
  if (!np?.accent || nowPlayingState(np, now) === 'paused') return undefined;
  return { '--np-accent': np.accent };
}


export const WIDGET_COMPONENTS: Record<WidgetId, (p: WidgetProps) => ReactNode> = {
  clock: Clock,
  upcoming: Upcoming,
  placed: Placed,
  weekstrip: Strip,
  intention: Intention,
  health: Health,
  streaks: StreakBars,
  daily: Daily,
  backlog: Backlog,
  nowplaying: NowPlayingBubble,
  radar: Radar,
};

// ---- owner-defined bubbles -------------------------------------------------------

function customData<T>(p: WidgetProps): T | null {
  return (p.data.custom?.[p.bubble.id] as T | undefined) ?? null;
}

function NoteBubble(p: WidgetProps) {
  const d = customData<NoteData>(p);
  if (!d || !d.exists || !d.found || d.items.length === 0) return null;
  const rows = d.items.slice(0, rowsOf(p, DEFAULT_CUSTOM_ROWS));
  const tasks = d.items.filter((i) => i.kind === 'task');
  const note = tasks.length > 0 && p.bubble.source.items === 'tasks'
    ? `${tasks.filter((t) => t.done).length}/${tasks.length}`
    : d.items.length > rows.length
      ? `+${d.items.length - rows.length}`
      : undefined;
  return (
    <>
      <Title p={p} note={note && <span className="q-num">{note}</span>} />
      <ul className="chk chk--mixed">
        {rows.map((it, i) =>
          it.kind === 'task' ? (
            <TaskRow key={i} text={it.text} done={it.done} now={p.now} />
          ) : (
            <li key={i} className="is-text">
              {it.text}
            </li>
          ),
        )}
      </ul>
    </>
  );
}

function TasksBubble(p: WidgetProps) {
  const d = customData<TasksData>(p);
  if (!d || d.items.length === 0) return null;
  const rows = d.items.slice(0, rowsOf(p, DEFAULT_CUSTOM_ROWS));
  return (
    <>
      <Title p={p} note={<span className="q-num">{d.total}</span>} />
      <ul className="chk">
        {rows.map((t, i) => (
          <TaskRow key={i} text={t.text} done={t.done} due={t.due} now={p.now} />
        ))}
      </ul>
    </>
  );
}

function FieldsBubble(p: WidgetProps) {
  const d = customData<FieldsData>(p);
  const shown = d?.exists ? d.fields.filter((f) => f.value != null) : [];
  if (shown.length === 0) return null;
  return (
    <>
      <Title p={p} />
      <dl className="bub__fields">
        {shown.map((f) => (
          <div key={f.key}>
            <dt>{f.key}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function TextBubble(p: WidgetProps) {
  const text = (p.bubble.source.text ?? '').trim();
  if (!text) return null;
  return (
    <>
      {p.bubble.title && <Title p={p} />}
      <p className="bub__text">{text}</p>
    </>
  );
}

const CUSTOM_COMPONENTS: Record<string, (p: WidgetProps) => ReactNode> = {
  note: NoteBubble,
  tasks: TasksBubble,
  fields: FieldsBubble,
  text: TextBubble,
};

/** Draw one bubble's content, or null when it has nothing to say. */
export function renderBubble(p: WidgetProps): ReactNode {
  const b = p.bubble;
  // A built-in, or a private add-on's bubble (lib/addons.ts); an add-on bubble
  // in a build without that add-on has no component and draws nothing.
  const fn =
    b.type === 'builtin'
      ? (WIDGET_COMPONENTS as Record<string, ((p: WidgetProps) => ReactNode) | undefined>)[b.id] ?? addonWidget(b.id)?.component
      : CUSTOM_COMPONENTS[b.type];
  return fn ? fn(p) : null;
}
