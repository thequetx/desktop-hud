import { useEffect, useState } from 'react';
import { fmtClock, fmtLongDay, sameDate } from '../lib/week';
import { fmt } from '../lib/fmt';
import { buildUpcoming } from '../lib/upcoming';
import { healthLine, isReviewTime, reviewPrompt, weekHealth } from '../lib/health';
import type { WeekAudit } from '../lib/audit';
import type { Streak } from '../lib/streaks';
import type { CalEvent, SkeletonBlock, VaultTask } from '../lib/types';
import { parseTaskMeta } from '../lib/taskmeta';
import { WeekStrip } from './WeekStrip';
import { Prio } from './hud/widgets';
import { debriefRows } from '../lib/extras';
import { rendererAddons } from '../lib/addons';
import type { DebriefRow } from '../lib/extras';
import { EXTRAS_OFF } from '../lib/presentation';
import type { Extras } from '../lib/presentation';

interface Props {
  weekStart: Date;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  intentions: VaultTask[];
  /** Phase 6 §3 — the numbers behind the health line. All already computed
   *  elsewhere; the ambient view only picks the four worth a glance. */
  tasks?: VaultTask[];
  streaks?: Streak[];
  audit?: WeekAudit | null;
  weekId?: string;
  error: string | null;
  /** Display & HUD → Extras: the debrief lives here. */
  extras?: Extras;
  /** Private add-ons' sections of presentation.json, for their idle-screen decorations. */
  addons?: Record<string, unknown>;
}

export function Ambient({
  weekStart,
  events,
  skeleton,
  intentions,
  tasks = [],
  streaks = [],
  audit = null,
  weekId,
  error,
  extras = EXTRAS_OFF,
  addons = {},
}: Props) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const upcoming = buildUpcoming(events, skeleton, now, 6);
  // Phase 6 §3 — how the week is going, in one line of large type rather than a
  // grid of tiles. On Sunday evening it stops reporting and asks instead.
  const health = weekHealth(intentions, tasks, streaks, audit);
  const reviewing = isReviewTime(now);
  const line = reviewing && weekId ? reviewPrompt(weekId, health) : healthLine(health);
  // Extras — mission debrief: on the Sunday review, the week's results sheet
  // in place of the one-line prompt (it still ends with the hotkey).
  const debrief = reviewing && weekId && extras.debrief ? debriefRows(health, streaks) : [];

  // Stand-alone (Phase 9.5): nothing draws behind the overlay but the
  // desktop itself, so it dims that deliberately (ambient--alone). Only an
  // add-on drawing a live wallpaper keeps the old light scrim.
  const live = rendererAddons().some((a) => {
    try {
      return Boolean(a.liveWallpaper?.(addons[a.id] as Record<string, unknown> | undefined));
    } catch {
      return false;
    }
  });
  const cls = ['ambient', live ? 'ambient--live' : 'ambient--alone', debrief.length > 0 ? 'has-debrief' : ''].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <div className="q-bracket tl" />
      <div className="q-bracket tr" />
      <div className="q-bracket bl" />
      <div className="q-bracket br" />

      <header className="ambient__clock">
        <span className="ambient__time q-num">{fmtClock(now)}</span>
        <span className="ambient__day q-label">{fmtLongDay(now)}</span>
      </header>

      <section className="ambient__sec ambient__thisweek">
        <h2 className="q-label">This week</h2>
        {intentions.length > 0 ? (
          <ul className="ambient__list">
            {intentions.map((t, i) => {
              // The Tasks priority emoji becomes the HUD's drawn mark; the
              // rest of the line is shown as written.
              const p = parseTaskMeta(t.text).priority;
              return (
                <li key={i} className={t.done ? 'is-done' : undefined}>
                  <Prio level={p?.level} />
                  {p ? t.text.replace(p.raw, '').replace(/\s{2,}/g, ' ').trim() : t.text}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="ambient__stub">set intentions in the weekly note</p>
        )}
      </section>

      <section className="ambient__sec ambient__nextup q-brackets">
        <h2 className="q-label">Next up</h2>
        <ul className="ambient__list ambient__next">
          {upcoming.map((u, i) => (
            <li key={i} className={`u u--${u.kind}`}>
              <span className="u__time q-num">
                {sameDate(u.when, now)
                  ? fmtClock(u.when)
                  : `${fmt().dow(u.when)} ${fmtClock(u.when)}`}
              </span>
              <span className="u__label">{u.label}</span>
            </li>
          ))}
          {upcoming.length === 0 && <li className="muted">nothing scheduled</li>}
        </ul>
      </section>

      {debrief.length > 0 && weekId ? (
        <Debrief weekId={weekId} rows={debrief} />
      ) : (
        line && <p className={reviewing ? 'ambient__health is-review' : 'ambient__health'}>{line}</p>
      )}

      <WeekStrip weekStart={weekStart} now={now} />

      {error && <div className="ambient__err">calendar offline</div>}
      {rendererAddons().map((a) => {
        const Decoration = a.ambientDecoration;
        return Decoration ? <Decoration key={a.id} section={addons[a.id] as Record<string, unknown> | undefined} /> : null;
      })}
    </div>
  );
}

/**
 * Extras — the end-of-mission results sheet, Sunday evening. Gold marks what
 * was completed in full; the rest stays in the overlay's own quiet steel.
 */
function Debrief({ weekId, rows }: { weekId: string; rows: DebriefRow[] }) {
  const all = rows.every((r) => r.done);
  return (
    <section className={all ? 'debrief is-complete q-brackets' : 'debrief q-brackets'} aria-label="Mission debrief">
      <h2 className="debrief__head q-label">
        <span>Mission debrief</span>
        <span className="debrief__week q-num">{weekId.replace(/^\d{4}-/, '')}</span>
        {all && <span className="debrief__all">Mission complete</span>}
      </h2>
      <dl className="debrief__rows">
        {rows.map((r) => (
          <div key={r.label} className={r.done ? 'is-done' : undefined}>
            <dt className="q-label">{r.label}</dt>
            <dd className="q-num">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="debrief__foot">Ctrl+Alt+W opens the week</p>
    </section>
  );
}
