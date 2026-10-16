import { setPollingInterval, clearPollingInterval } from '../lib/polling';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { buildUpcoming } from '../lib/upcoming';
import {
  arrangeAction,
  arrangeDrag,
  calendarSources,
  googleStatus,
  notesStatus,
  onEventsChange,
  onGoogleChange,
  focusGet,
  getArrange,
  loadEvents,
  onArrange,
  onArrangeTarget,
  onFocusChange,
  onHudDebugCycle,
  onHudHover,
  onVaultChange,
  readBacklog,
  readNowPlaying,
  callAddon,
  readWidgets,
  reportImminent,
  resizeHud,
  setArrange,
} from '../lib/shell';
import {
  activeKinds,
  activeTitles,
  bubbleState,
  bubbleTitle,
  buildPlaced,
  customRequests,
  localIsoDate,
  NOW_PLAYING_POLL_MS,
  trackKey,
  readersNeeded,
  visibleBubbles,
} from '../lib/widgets';
import { addonWidget, rendererAddons } from '../lib/addons';
import type { WidgetData } from '../lib/widgets';
import { bubbleAlphaStyle, hudAlphaStyle } from '../lib/presentation';
import { bubbleRects, hoveredBubble } from '../lib/hudhover';
import type { HoverPoint } from '../lib/hudhover';
import type { Anchor, Bubble, PresentationPrefs } from '../lib/presentation';
import type { WeekAudit } from '../lib/audit';
import type { CalEvent, FocusSession, SkeletonBlock, VaultTask, VaultWeek } from '../lib/types';
import type { Streak } from '../lib/streaks';
import { enqueueObjectives, newlyDone, OBJECTIVE_MS, streakLevels } from '../lib/extras';
import type { ObjectivePlate as Plate } from '../lib/extras';
import { addWeeks } from '../lib/week';
import { bubbleDataStyle, ObjectivePlate, renderBubble, staleSince } from './hud/widgets';
import { useHudShown } from '../lib/hudshown';
import { useLively } from '../lib/lively';
import type { SetupState, WidgetProps } from './hud/widgets';
import { IconClose, IconDown, IconEdit, IconGrip, IconLock, IconPlus, IconUndo, IconUp } from './icons';

const CORNER_NAME: Record<Anchor, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
};

// Debug: `?rows=N` seeds N placeholder rows; Ctrl+Alt+Shift+H cycles through these.
const DEBUG_STEPS: (number | null)[] = [null, 1, 3, 6, 10];

function initialDebugRows(): number | null {
  const v = new URLSearchParams(location.search).get('rows');
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 40) : null;
}

interface Props {
  /** Which corner this window is. Each anchor is its own window (Phase 8) and
   *  draws only the bubbles placed there. */
  anchor: Anchor;
  weekStart: Date;
  weekId: string;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  streaks: Streak[];
  vault: VaultWeek | null;
  audit: WeekAudit | null;
  error: string | null;
  presentation: PresentationPrefs;
}

/**
 * The persistent HUD — Phase 8: a stack of bubbles for one corner.
 *
 * Normally click-through and never focusable (Ctrl+Alt+H shows/hides it).
 * What it shows is `presentation.hud.bubbles`; *when* each shows is
 * `lib/widgets.ts` `bubbleState` (block kinds, days, hours, focus mode).
 *
 * **Arrange mode** (tray → Arrange HUD, or Display & HUD) is the one time it
 * takes clicks: every enabled bubble is drawn — including ones a rule is
 * hiding right now, labelled with why — with a drag handle and ↑ ↓ ✎ ×. The
 * main process applies each action and pushes the new layout back.
 */
export function Hud({
  anchor,
  weekStart,
  weekId,
  events,
  skeleton,
  streaks,
  vault,
  audit,
  error,
  presentation,
}: Props) {
  const [now, setNow] = useState(() => new Date());
  const [debugRows, setDebugRows] = useState<number | null>(initialDebugRows);
  // Phase 6 §2 — owned by the main process, so a session started from the
  // tray or Ctrl+Alt+F reaches every HUD corner at once.
  const [focus, setFocus] = useState<FocusSession | null>(null);
  const [data, setData] = useState<WidgetData>({});
  const [backlog, setBacklog] = useState<VaultTask[]>([]);
  const [vaultTick, setVaultTick] = useState(0);
  const [arranging, setArranging] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Hover fade: the cursor's point in this window (from the main process's
  // poll — the window itself stays click-through) and the bubble under it.
  const [hoverPt, setHoverPt] = useState<HoverPoint | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 30s is plenty for a list of rows; a countdown wants the minute it changes.
  useEffect(() => {
    const every = focus ? 5_000 : 30_000;
    const id = setPollingInterval(() => setNow(new Date()), every);
    return () => clearPollingInterval(id);
  }, [focus]);

  useEffect(() => {
    focusGet().then(setFocus);
    return onFocusChange(setFocus);
  }, []);

  useEffect(() => {
    const apply = (s: { on: boolean; canUndo: boolean }) => {
      setArranging(s.on);
      setCanUndo(s.canUndo);
    };
    getArrange().then(apply);
    const off1 = onArrange((s) => {
      if (!s.on) setAdding(false);
      apply(s);
    });
    const off2 = onArrangeTarget(setDropTarget);
    return () => {
      off1();
      off2();
    };
  }, []);

  useEffect(() => {
    return onHudDebugCycle(() => {
      setDebugRows((cur) => DEBUG_STEPS[(DEBUG_STEPS.indexOf(cur) + 1) % DEBUG_STEPS.length]);
    });
  }, []);

  useEffect(() => onVaultChange(() => setVaultTick((t) => t + 1)), []);

  // What is set up (Phase 9.5), for the bubbles' empty states: how many
  // calendars, and whether a chosen notes folder has gone missing. Re-asked
  // when a calendar is added or removed and on every notes change.
  const [setup, setSetup] = useState<SetupState>({ calendars: null, notesMissing: false, staleSince: null });
  useEffect(() => {
    let cancelled = false;
    const ask = () =>
      void Promise.all([calendarSources(), googleStatus(), notesStatus()]).then(([cals, google, notes]) => {
        if (cancelled) return;
        // An add-on's account (Google, in the owner's build) is a calendar too.
        const next = {
          calendars: cals.length + (google?.connected ? 1 : 0),
          notesMissing: Boolean(notes && notes.kind === 'folder' && !notes.ready),
          staleSince: staleSince(cals),
        };
        setSetup((cur) =>
          cur.calendars === next.calendars && cur.notesMissing === next.notesMissing && cur.staleSince === next.staleSince ? cur : next,
        );
      });
    ask();
    const off = onEventsChange(ask);
    const offGoogle = onGoogleChange(ask);
    // A failed fetch changes no events, so nothing is pushed: re-ask now and
    // then, for the offline line (Phase 9.6).
    const id = setPollingInterval(ask, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      off();
      offGoogle();
      clearPollingInterval(id);
    };
  }, [vaultTick]);

  useEffect(() => onHudHover(setHoverPt), []);
  // Re-hit-tested after every render, not only when the cursor moves: a
  // bubble can grow, shrink or drop out under a cursor that stays put. Never
  // in arrange mode, where every bubble is solid and takes clicks.
  const hoverFade = presentation.hud.hoverFade && !arranging;
  useLayoutEffect(() => {
    // Nothing to do with the cursor elsewhere and nothing faded — the common
    // case, which then costs nothing per render.
    if (!hoverPt && hovered == null) return;
    const el = ref.current;
    const id = hoverFade && el ? hoveredBubble(hoverPt, bubbleRects(el)) : null;
    setHovered((cur) => (cur === id ? cur : id));
  });

  const ctx = useMemo(
    () => ({ kinds: activeKinds(skeleton, now), titles: activeTitles(events, now), focus: focus != null, now }),
    [skeleton, events, now, focus],
  );
  const shown = useMemo(() => visibleBubbles(presentation, anchor, ctx), [presentation, anchor, ctx]);

  // Vault notes behind the bubbles this corner has *enabled* (not just shown,
  // so a bubble reappearing after a stream has its data ready). Re-read on any
  // vault change and when the date rolls over — `{today}` is a different note
  // after midnight.
  const today = localIsoDate(now);
  const request = useMemo(
    () => JSON.stringify({ ids: readersNeeded(presentation, anchor), custom: customRequests(presentation, anchor) }),
    [presentation, anchor],
  );
  useEffect(() => {
    let cancelled = false;
    const { ids, custom } = JSON.parse(request);
    readWidgets(ids, custom, today).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [request, today, vaultTick]);

  // Now playing: the main process's media reader, every few seconds while this
  // corner has the bubble. A track change shows within POLL; nothing else
  // here is that time-sensitive, so it gets its own small loop.
  const wantsNowPlaying = presentation.hud.bubbles.some(
    (b) => b.id === 'nowplaying' && b.enabled && b.anchor === anchor,
  );
  const [nowPlaying, setNowPlaying] = useState<WidgetData['nowplaying']>(null);
  // The paused state needs to know the track was playing, and when — the
  // feed only says "not playing now".
  const lastPlaying = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!wantsNowPlaying) {
      setNowPlaying(null);
      return;
    }
    let cancelled = false;
    const poll = () =>
      readNowPlaying().then((np) => {
        if (cancelled) return;
        if (np?.playing) lastPlaying.current = { key: trackKey(np), at: Date.now() };
        const seen = np && !np.playing && lastPlaying.current?.key === trackKey(np) ? lastPlaying.current.at : null;
        setNowPlaying(np ? { ...np, pausedAt: seen } : np);
      });
    void poll();
    const id = setPollingInterval(poll, NOW_PLAYING_POLL_MS);
    return () => {
      cancelled = true;
      clearPollingInterval(id);
    };
  }, [wantsNowPlaying]);

  // Private add-on bubbles (Phase 9.3): each one with a `poll` gets its data
  // from its add-on's main-process handler, on its own interval, while it is
  // on in this corner. It arrives as `data.addons[bubbleId]`.
  const addonPolls = presentation.hud.bubbles
    .filter((b) => b.enabled && b.anchor === anchor)
    .map((b) => ({ id: b.id, w: addonWidget(b.id) }))
    .filter((x): x is { id: string; w: NonNullable<ReturnType<typeof addonWidget>> } => Boolean(x.w && x.w.poll));
  const addonPollKey = addonPolls.map((x) => x.id).join('|');
  const [addonData, setAddonData] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!addonPolls.length) {
      setAddonData({});
      return;
    }
    let cancelled = false;
    const timers = addonPolls.map(({ id, w }) => {
      const poll = () =>
        callAddon(w.addon, w.poll!.name).then((value) => {
          if (!cancelled) setAddonData((cur) => (cur[id] === value ? cur : { ...cur, [id]: value }));
        });
      void poll();
      return setPollingInterval(poll, w.poll!.ms);
    });
    return () => {
      cancelled = true;
      timers.forEach((t) => clearPollingInterval(t));
    };
    // addonPollKey stands for addonPolls: re-run only when the set of bubbles changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addonPollKey]);

  // Extras — streak levels: the past twelve weeks out of the events slot
  // (the same local read, just a wider range), only while this
  // corner shows Streaks with the extra on. Re-read when the week turns, the
  // blocks change or a calendar push lands (a new `events` array).
  const wantsLevels =
    presentation.extras.streakLevels &&
    presentation.hud.bubbles.some((b) => b.id === 'streaks' && b.enabled && b.anchor === anchor);
  const [levels, setLevels] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!wantsLevels || skeleton.length === 0) {
      setLevels(null);
      return;
    }
    let cancelled = false;
    loadEvents(addWeeks(weekStart, -12), weekStart).then((past) => {
      if (!cancelled && Array.isArray(past)) setLevels(streakLevels(weekStart, past, skeleton));
    });
    return () => {
      cancelled = true;
    };
  }, [wantsLevels, weekStart, skeleton, events]);

  // Extras — objective complete. Each read of the weekly note (intentions)
  // and the daily note (goals) is diffed against the last one; a line that
  // flipped to done queues a plate over the bubble that shows it. The first
  // read of a week or a day is only ever the baseline.
  const objectivesOn = presentation.extras.objectiveComplete;
  const [plates, setPlates] = useState<Plate[]>([]);
  const plateId = useRef(0);
  const lastIntentions = useRef<{ week: string; list: VaultTask[] } | null>(null);
  const lastGoals = useRef<{ file: string; list: { text: string; done: boolean }[] } | null>(null);
  const hasHere = (id: string) =>
    presentation.hud.bubbles.some((b) => b.id === id && b.enabled && b.anchor === anchor);
  const intentionHere = objectivesOn && hasHere('intention');
  const dailyHere = objectivesOn && hasHere('daily');
  const queue = (bubbleId: string, titles: string[]) => {
    if (titles.length) setPlates((q) => enqueueObjectives(q, bubbleId, titles, ++plateId.current));
  };
  useEffect(() => {
    if (!intentionHere || !vault) {
      lastIntentions.current = null;
      return;
    }
    const prev = lastIntentions.current?.week === vault.weekId ? lastIntentions.current.list : null;
    lastIntentions.current = { week: vault.weekId, list: vault.intentions };
    queue('intention', newlyDone(prev, vault.intentions));
  }, [vault, intentionHere]);
  const daily = data.daily;
  useEffect(() => {
    if (!dailyHere || !daily?.exists) {
      lastGoals.current = null;
      return;
    }
    const prev = lastGoals.current?.file === daily.file ? lastGoals.current.list : null;
    lastGoals.current = { file: daily.file, list: daily.goals };
    queue('daily', newlyDone(prev, daily.goals));
  }, [daily, dailyHere]);
  useEffect(() => {
    if (!objectivesOn) setPlates([]);
  }, [objectivesOn]);
  // One plate at a time: the front of the queue shows for OBJECTIVE_MS.
  const plate = plates[0] ?? null;
  useEffect(() => {
    if (!plate) return;
    const t = window.setTimeout(() => setPlates((q) => (q[0] === plate ? q.slice(1) : q)), OBJECTIVE_MS);
    return () => window.clearTimeout(t);
  }, [plate]);

  const wantsBacklog = presentation.hud.bubbles.some(
    (b) => b.id === 'backlog' && b.enabled && b.anchor === anchor,
  );
  useEffect(() => {
    if (!wantsBacklog) return;
    let cancelled = false;
    readBacklog().then((b) => {
      if (!cancelled) setBacklog(b);
    });
    return () => {
      cancelled = true;
    };
  }, [wantsBacklog, vaultTick]);

  // Phase 6 §1 — tell the main process when a block enters its lead window, so
  // a hidden HUD can bring itself up (bug #22). Placed vault tasks escalate the
  // same way as skeleton blocks. Only the corner showing them reports.
  const ids = shown.map((b) => b.id);
  let imminentKey: string | null = null;
  if (ids.includes('upcoming') && debugRows == null) {
    const u = buildUpcoming(events, skeleton, now, presentation.hud.upcomingRows).find((x) => x.imminent);
    if (u) imminentKey = `${u.label}@${u.when.toISOString()}`;
  }
  if (!imminentKey && ids.includes('placed')) {
    const tasks = [...(vault?.tasks ?? []), ...(vault?.thisweek ?? [])];
    const p = buildPlaced(tasks, events, now).find((x) => x.imminent);
    if (p) imminentKey = `${p.label}@${p.when.toISOString()}`;
  }
  useEffect(() => {
    if (imminentKey) reportImminent(imminentKey);
  }, [imminentKey]);

  const propsFor = (bubble: Bubble): WidgetProps => ({
    bubble,
    now,
    weekStart,
    weekId,
    events,
    skeleton,
    streaks,
    vault,
    audit,
    data: { ...data, nowplaying: nowPlaying, addons: addonData },
    backlog,
    focus,
    presentation,
    error,
    debugRows,
    levels,
    setup,
  });

  // Shrink this corner's window to the rendered stack so it hugs the corner.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => resizeHud(el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Lean idle (option A): the equaliser and the cat's ripple play for a few
  // seconds after something changes, then hold still (lib/lively.ts).
  const hudShown = useHudShown();
  const lively = useLively(
    [nowPlaying ? trackKey(nowPlaying) : '', nowPlaying?.playing ? 'on' : 'off', hudShown ? 'shown' : 'hidden', imminentKey ?? ''].join('|'),
  );
  const cls = `hudstack hudstack--${anchor} hud--${presentation.hud.scale} hud--bd-${presentation.hud.backdrop}${lively ? '' : ' hud--still'}`;
  // Private add-ons' decorations (Phase 9.3): each draws itself in the corner
  // it belongs to, behind the top bubble, or alone on the empty line.
  const sectionOf = (id: string) => (presentation.addons ?? {})[id] as Record<string, unknown> | undefined;
  const decorations = rendererAddons().filter((a) => a.hudDecoration);
  const decorate = (alone: boolean) =>
    decorations.map((a) => {
      const Decoration = a.hudDecoration!.component;
      return (
        <Decoration
          key={a.id}
          anchor={anchor}
          alone={alone}
          section={sectionOf(a.id)}
          presentation={presentation}
          events={events}
          skeleton={skeleton}
          tasks={[...(vault?.tasks ?? []), ...(vault?.thisweek ?? [])]}
          now={now}
          imminentKey={imminentKey}
          nowPlaying={nowPlaying ?? null}
          nowPlayingHere={wantsNowPlaying}
          debugging={debugRows != null}
        />
      );
    });

  if (!arranging) {
    // Bubble content is computed first so a bubble with nothing to say drops
    // out entirely rather than leaving an empty card behind.
    const bubbles = shown
      .map((b) => ({ b, node: renderBubble(propsFor(b)) }))
      .filter((x) => x.node != null && x.node !== false);
    return (
      <div className={cls} ref={ref} style={hudAlphaStyle(presentation)}>
        {/* Every bubble here empty or ruled out: the cat stays, on the bare
            waterline where the first bubble would be. */}
        {decorate(bubbles.length === 0)}
        {bubbles.map(({ b, node }) => (
          <section
            key={b.id}
            data-bub={b.id}
            className={`hud bub bub--${b.type} bub--${b.id}${b.width === 'fit' ? ' bub--fit' : ''}${hovered === b.id ? ' is-hover-faded' : ''}`}
            style={{ ...bubbleAlphaStyle(b), ...bubbleDataStyle(b, { ...data, nowplaying: nowPlaying, addons: addonData }, now.getTime()) }}
          >
            {node}
            {plate?.bubbleId === b.id && <ObjectivePlate key={plate.id} plate={plate} />}
          </section>
        ))}
      </div>
    );
  }

  // ---- arrange mode ----------------------------------------------------------

  const mine = presentation.hud.bubbles.filter((b) => b.enabled && b.anchor === anchor);
  const off = presentation.hud.bubbles.filter((b) => !b.enabled);
  const isPrivate = presentation.hud.privateAnchors.includes(anchor as Anchor);

  const startDrag = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(id);
    let frame = 0;
    const move = (ev: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        arrangeDrag({ x: ev.screenX, y: ev.screenY });
      });
    };
    const end = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', cancel);
      setDragging(null);
      void arrangeAction({ type: 'drop', id, x: ev.screenX, y: ev.screenY });
    };
    const cancel = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', cancel);
      setDragging(null);
      arrangeDrag(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', cancel);
  };

  return (
    <div
      className={`${cls} is-arranging q-brackets${dropTarget === anchor ? ' is-drop-target' : ''}`}
      ref={ref}
      style={hudAlphaStyle(presentation)}
    >
      <p className="arr__corner">
        <span className={`cglyph cglyph--${anchor}`} aria-hidden="true" />
        {CORNER_NAME[anchor]}
        {isPrivate && (
          <span className="arr__private" title="Hidden from screen capture">
            <IconLock size={12} /> Private
          </span>
        )}
        {decorations.map((a) => (
          <Fragment key={a.id}>{a.hudDecoration!.arrangeLabel?.({ anchor, section: sectionOf(a.id) }) ?? null}</Fragment>
        ))}
      </p>
      {/* Where it will sit: behind the first bubble, or alone on the line. */}
      {decorate(mine.length === 0)}
      {mine.map((b, i) => {
        const why = bubbleState(b, { ...ctx, focus: false });
        const node = renderBubble(propsFor(b));
        return (
          <section
            key={b.id}
            className={`hud bub bub--${b.type} bub--${b.id}${b.width === 'fit' ? ' bub--fit' : ''} arr${why ? ' is-ruled' : ''}${dragging === b.id ? ' is-dragging' : ''}`}
          >
            <div className="arr__bar">
              <button
                className="btn btn--icon arr__grip"
                onPointerDown={startDrag(b.id)}
                title="Drag to another corner"
                aria-label="Drag to another corner"
              >
                <IconGrip />
              </button>
              <span className="arr__name">{bubbleTitle(b)}</span>
              {why && <span className="arr__why">{why}</span>}
              <span className="arr__tools">
                <button
                  className="btn btn--icon"
                  onClick={() => arrangeAction({ type: 'reorder', id: b.id, dir: -1 })}
                  disabled={i === 0}
                  title="Move up"
                  aria-label="Move up"
                >
                  <IconUp />
                </button>
                <button
                  className="btn btn--icon"
                  onClick={() => arrangeAction({ type: 'reorder', id: b.id, dir: 1 })}
                  disabled={i === mine.length - 1}
                  title="Move down"
                  aria-label="Move down"
                >
                  <IconDown />
                </button>
                <button
                  className="btn btn--icon"
                  onClick={() => arrangeAction({ type: 'edit', id: b.id })}
                  title="Edit"
                  aria-label="Edit"
                >
                  <IconEdit />
                </button>
                <button
                  className="btn btn--icon arr__off"
                  onClick={() => arrangeAction({ type: 'hide', id: b.id })}
                  title="Switch off"
                  aria-label="Switch off"
                >
                  <IconClose />
                </button>
              </span>
            </div>
            {node ?? <p className="arr__empty">Nothing to show right now</p>}
          </section>
        );
      })}
      {mine.length === 0 && <p className="arr__hint">Drop a bubble here, or add one.</p>}
      <div className="arr__foot">
        <button
          className={adding ? 'btn is-on' : 'btn'}
          aria-expanded={adding}
          onClick={() => setAdding((a) => !a)}
        >
          <IconPlus /> Add
        </button>
        <button
          className="btn"
          onClick={() => arrangeAction({ type: 'undo' })}
          disabled={!canUndo}
          title="Undo the last change"
        >
          <IconUndo /> Undo
        </button>
        <button className="btn btn--primary arr__done" onClick={() => setArrange(false)}>
          Done
        </button>
      </div>
      {adding && (
        <ul className="arr__add">
          {off.length > 0 && <li className="arr__addhead">Switched off — bring back here</li>}
          {off.map((b) => (
            <li key={b.id}>
              <button className="btn" onClick={() => arrangeAction({ type: 'show', id: b.id, anchor })}>
                {bubbleTitle(b)}
              </button>
            </li>
          ))}
          <li>
            <button className="btn arr__new" onClick={() => arrangeAction({ type: 'add', anchor })}>
              <IconPlus /> New bubble…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
