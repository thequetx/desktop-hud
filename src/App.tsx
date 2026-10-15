import { useEffect, useMemo, useState } from 'react';
import { Ambient } from './components/Ambient';
import { Hud } from './components/Hud';
import { Capture } from './components/Capture';
import { Settings } from './components/Settings';
import { keyOfWindows, loadSkeleton } from './lib/skeleton';
import { DEFAULT_DURATIONS } from './lib/duration';
import { SKELETON_URL, AMBIENT_REFRESH_MS } from './config';
import type {
  AvailabilityWindow,
  CalEvent,
  DurationMap,
  SkeletonBlock,
  Mode,
  VaultWeek,
} from './lib/types';
import { addWeeks, startOfISOWeek, isoWeekId } from './lib/week';
import { computeStreaks } from './lib/streaks';
import { auditWeek } from './lib/audit';
import { dayPhase } from './lib/extras';
import { setFmtPrefs } from './lib/fmt';
import {
  isElectron,
  readVaultWeek,
  loadEvents,
  onEventsChange,
  onGoogleChange,
  onSkeletonChange,
  onVaultChange,
  onCalendarChange,
  onPresentationChange,
  readPresentation,
  PRESENTATION_DEFAULTS,
} from './lib/shell';
import type { PresentationPrefs } from './lib/shell';
import { ANCHORS } from './lib/presentation';
import type { Anchor } from './lib/presentation';

/** Phase 8 — which corner a HUD window is (hud.html?anchor=…). */
function resolveAnchor(): Anchor {
  const a = new URLSearchParams(location.search).get('anchor');
  return (ANCHORS as readonly string[]).includes(a ?? '') ? (a as Anchor) : 'top-right';
}

/**
 * Which surface this window is. `index.html` is the Display & HUD settings
 * window since the planner was archived (2026-09-24, tag
 * `planner-archive-2026-09-24`); the other pages say so themselves.
 */
function resolveMode(): Mode {
  const q = new URLSearchParams(location.search).get('mode');
  if (q === 'ambient' || q === 'settings' || q === 'hud' || q === 'capture') return q;
  // Each page names itself in a <meta name="wd-mode">: an inline script would
  // need the CSP to allow inline scripts (Phase 9.0, S10). __WD_MODE__ is the
  // old inline-script form, still honoured.
  const m =
    document.querySelector('meta[name="wd-mode"]')?.getAttribute('content') ?? window.__WD_MODE__;
  return m === 'ambient' || m === 'hud' || m === 'capture' ? m : 'settings';
}

export function App() {
  const mode = useMemo(resolveMode, []);
  // Phase 5 §6 — quick capture is its own window and shares none of the
  // other surfaces' state: no calendar, no vault read, no skeleton. Returning
  // before any of that is set up is the point — the window has to be instant.
  if (mode === 'capture') return <Capture />;
  return <Surfaces mode={mode} />;
}

/**
 * The shared data layer for the HUD corners, the idle overlay and the
 * settings window's live preview: the week's calendar, the recurring blocks
 * and the vault's weekly note, each kept fresh by pushes from the main process.
 * Read-only — nothing here writes to the calendar or the vault.
 */
function Surfaces({ mode }: { mode: Exclude<Mode, 'capture'> }) {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [skeleton, setSkeleton] = useState<SkeletonBlock[]>([]);
  const [durations, setDurations] = useState<DurationMap>(DEFAULT_DURATIONS);
  const [windows, setWindows] = useState<AvailabilityWindow[]>([]);
  const [vault, setVault] = useState<VaultWeek | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [calTick, setCalTick] = useState(0);
  const [vaultTick, setVaultTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<PresentationPrefs>(PRESENTATION_DEFAULTS);
  // How dates and times are drawn (lib/fmt.ts), set before anything renders
  // with it, and again whenever the setting changes.
  useMemo(() => setFmtPrefs(presentation.locale), [presentation.locale]);

  useEffect(() => {
    readPresentation().then(setPresentation);
    return onPresentationChange(setPresentation);
  }, []);

  // Extras — day/night shift: the HUD and the idle screen carry the time of
  // day as `data-phase` on the root, and tokens.css cools and dims them after
  // dark. Off (the default), the attribute is never set. The settings window
  // keeps its own colours whatever the hour.
  const dayNight = presentation.extras.dayNight && mode !== 'settings';
  useEffect(() => {
    const root = document.documentElement;
    if (!dayNight) return;
    const apply = () => {
      root.dataset.phase = dayPhase(new Date());
    };
    apply();
    const id = window.setInterval(apply, 60_000);
    return () => {
      window.clearInterval(id);
      delete root.dataset.phase;
    };
  }, [dayNight]);

  // Always this week: nothing navigates weeks any more. Re-checked every
  // minute, because the HUD runs for days and must turn the page on Monday.
  const [weekStart, setWeekStart] = useState(() => startOfISOWeek(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => {
      const w = startOfISOWeek(new Date());
      setWeekStart((cur) => (cur.getTime() === w.getTime() ? cur : w));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  const weekId = isoWeekId(weekStart);

  // An add-on calendar connecting or signing out changes what the events
  // slot merges in, so re-read.
  useEffect(() => onGoogleChange(() => setRefreshTick((t) => t + 1)), []);

  // A `.md` in the vault changed, pushed from the main process's file watcher:
  // one watcher, every window, and an Obsidian edit on the HUD in about a second.
  useEffect(() => onVaultChange(() => setVaultTick((t) => t + 1)), []);

  // A calendar source changed (electron/calsources.cjs: new text, a source
  // added or removed, the week turned): re-read.
  useEffect(() => onEventsChange(() => setCalTick((t) => t + 1)), []);

  // Calendar deltas, pushed from the main process after every sync pass.
  useEffect(
    () =>
      onCalendarChange((s) => {
        // Only once a pass has actually landed — "syncing…" changes nothing here.
        if (!s.syncing) setCalTick((t) => t + 1);
      }),
    [],
  );

  // The week's tasks as every surface counts them: the weekly note's ## Tasks
  // plus the #thisweek sweep. One list, so the idle screen and the Week bubble
  // can't disagree about "x/y tasks".
  const tasks = useMemo(() => [...(vault?.tasks ?? []), ...(vault?.thisweek ?? [])], [vault]);

  const streaks = useMemo(
    () => computeStreaks(weekStart, events, skeleton),
    [weekStart, events, skeleton],
  );

  /**
   * Phase 6 §3 — the planned-vs-kept half of the week-health line, for the
   * idle overlay and the HUD's Week bubble. The settings window's preview
   * draws the same bubbles, so it needs it too.
   */
  const audit = useMemo(
    () =>
      auditWeek(
        weekStart,
        { skeleton, windows, events, tasks },
        { now: new Date() },
      ),
    [weekStart, skeleton, windows, events, tasks],
  );

  // Calendar events around this week, from the events slot: every calendar,
  // merged and parsed in the main process (Phase 9.4). A local read, re-run on
  // every pushed change rather than on a timer.
  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const rangeStart = addWeeks(weekStart, -1);
      const rangeEnd = addWeeks(weekStart, 2);
      try {
        const ev = (await loadEvents(rangeStart, rangeEnd)) ?? [];
        if (!cancelled) {
          setEvents(ev);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    pull();
    return () => {
      cancelled = true;
    };
  }, [weekStart, calTick, refreshTick]);

  // Vault week — pushed, not polled (Phase 3 §2b). The main process watches the
  // vault and tells every window; the read on that side is mtime-cached, so
  // re-reading after a one-line edit costs one file read, not the whole vault.
  useEffect(() => {
    let cancelled = false;
    readVaultWeek(weekId)
      .then((vw) => {
        if (!cancelled) setVault(vw);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [weekId, vaultTick, refreshTick]);

  // Recurring blocks: edited in Display & HUD (pushed here when saved) or by
  // hand in the yaml, which the unattended views also re-read slowly.
  const [skelTick, setSkelTick] = useState(0);
  useEffect(() => onSkeletonChange(() => setSkelTick((t) => t + 1)), []);
  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      try {
        const doc = await loadSkeleton(SKELETON_URL);
        if (!cancelled) {
          setSkeleton(doc.blocks);
          setDurations(doc.durations);
          // Keep the old array when the time map hasn't actually changed:
          // `parseSkeletonDoc` allocates fresh arrays on every read.
          setWindows((cur) =>
            keyOfWindows(cur) === keyOfWindows(doc.windows) ? cur : doc.windows,
          );
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    pull();
    const id = window.setInterval(pull, AMBIENT_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTick, skelTick]);

  if (mode === 'ambient') {
    return (
      <Ambient
        weekStart={weekStart}
        events={events}
        skeleton={skeleton}
        intentions={vault?.intentions ?? []}
        tasks={tasks}
        streaks={streaks}
        audit={audit}
        weekId={weekId}
        error={error}
        extras={presentation.extras}
        addons={presentation.addons}
      />
    );
  }
  if (mode === 'hud') {
    return (
      <Hud
        anchor={resolveAnchor()}
        weekStart={weekStart}
        weekId={weekId}
        events={events}
        skeleton={skeleton}
        streaks={streaks}
        vault={vault}
        audit={audit}
        error={error}
        presentation={presentation}
      />
    );
  }
  return (
    <Settings
      weekStart={weekStart}
      events={events}
      skeleton={skeleton}
      durations={durations}
      vault={vault}
    />
  );
}
