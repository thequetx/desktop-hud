import { useEffect, useState } from 'react';
import { PresentationEditor } from './PresentationEditor';
import { Onboarding } from './Onboarding';
import { hideSettings, onPresentationOpen } from '../lib/shell';
import type { EditorTarget } from '../lib/shell';
import type { CalEvent, DurationMap, SkeletonBlock, VaultWeek } from '../lib/types';

interface Props {
  weekStart: Date;
  events: CalEvent[];
  skeleton: SkeletonBlock[];
  durations: DurationMap;
  vault: VaultWeek | null;
}

/**
 * The Display & HUD window — the editor that used to open over the planner,
 * now a window of its own (the planner was archived 2026-09-24).
 *
 * The main process sends `presentation:open` every time it shows this window,
 * optionally aimed at a bubble or a new one for a corner (arrange mode's ✎ and
 * +). Each open mounts a fresh editor, so a reopen never resumes a stale
 * draft; closing unmounts it, which reverts any unsaved preview, and the main
 * process reverts again on hide in case the window went away some other way.
 */
export function Settings(props: Props) {
  const [session, setSession] = useState<{ n: number; target: EditorTarget } | null>({ n: 0, target: null });

  useEffect(
    () => onPresentationOpen((target) => setSession((s) => ({ n: (s?.n ?? 0) + 1, target: target ?? null }))),
    [],
  );

  const close = () => {
    setSession(null);
    hideSettings();
  };

  // Esc is Cancel, as it was for the dialog.
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  if (!session) return null;
  // First run (Phase 9.5): main asks for the set-up wizard until it is finished.
  if (session.target?.onboarding) return <Onboarding key={session.n} onClose={close} />;
  return <PresentationEditor key={session.n} standalone target={session.target} onClose={close} {...props} />;
}
