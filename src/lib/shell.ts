// Thin wrapper over the Electron preload bridge (`window.wd`). Every call is a
// no-op in a plain browser tab, so components can call these unconditionally.

import type { AuditSummary } from './audit';
import type {
  CalEvent,
  CalSyncStatus,
  FocusSession,
  GoogleStatus,
  VaultTask,
  VaultWeek,
} from './types';

const wd = typeof window !== 'undefined' ? window.wd : undefined;

import { asPresentation, PRESENTATION_DEFAULTS } from './presentation';
import type { PresentationDisplay, PresentationPrefs } from './presentation';
import type { NowPlaying, WidgetData } from './widgets';
export { PRESENTATION_DEFAULTS };
export type { PresentationDisplay, PresentationPrefs };

export const isElectron = Boolean(wd?.isElectron);

/** Close the Display & HUD window. The main process reverts an unsaved preview. */
export function hideSettings(): void {
  wd?.hideSettings?.();
}

export function resizeHud(height: number): void {
  wd?.resizeHud(height);
}

/** Whether this HUD window started on screen: the main process loads it with
 *  `shown=0` when it is created while the HUD is hidden. Absent (a plain
 *  browser, the screenshot harness) means shown. */
export function hudInitiallyShown(): boolean {
  const told = wd?.hudShown?.();
  if (typeof told === 'boolean') return told;
  if (typeof location === 'undefined') return true;
  return new URLSearchParams(location.search).get('shown') !== '0';
}

/** The HUD was shown or hidden. Returns an unsubscribe fn (a no-op outside
 *  Electron). */
export function onHudShown(cb: (shown: boolean) => void): () => void {
  return wd?.onHudShown?.(cb) ?? (() => {});
}

/** Debug: subscribe to the Ctrl+Alt+Shift+H "cycle HUD row count" event.
 *  Returns an unsubscribe fn (a no-op outside Electron). */
export function onHudDebugCycle(cb: () => void): () => void {
  return wd?.onHudDebugCycle?.(cb) ?? (() => {});
}

export async function readPresentation(): Promise<PresentationPrefs> {
  try {
    return asPresentation(await wd?.presentationRead?.());
  } catch {
    return PRESENTATION_DEFAULTS;
  }
}
/** Monitors plugged in or out (or rearranged); re-read presentationDisplays(). */
export function onDisplaysChange(cb: () => void): () => void {
  return wd?.onDisplaysChange?.(cb) ?? (() => {});
}
export async function presentationDisplays(): Promise<PresentationDisplay[]> {
  try {
    return (await wd?.presentationDisplays?.()) ?? [];
  } catch {
    return [];
  }
}

/** Save to disk (and apply). */
export async function writePresentation(prefs: PresentationPrefs): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await wd?.presentationWrite?.(prefs)) ?? { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Apply to the live HUD *without* saving — the editor's preview. */
export async function previewPresentation(prefs: PresentationPrefs): Promise<void> {
  try {
    await wd?.presentationPreview?.(prefs);
  } catch {
    /* preview is best-effort */
  }
}

/** Drop any unsaved preview and go back to what's on disk. */
export async function revertPresentation(): Promise<PresentationPrefs | null> {
  try {
    const r = await wd?.presentationRevert?.();
    return r?.prefs ? asPresentation(r.prefs) : null;
  } catch {
    return null;
  }
}

export async function resetPresentation(): Promise<{ ok: boolean; prefs?: PresentationPrefs; error?: string }> {
  try {
    return (await wd?.presentationReset?.()) ?? { ok: false };
  } catch {
    return { ok: false };
  }
}

export function previewAmbient(): void {
  void wd?.previewAmbient?.();
}
export function endAmbientPreview(): void {
  void wd?.endAmbientPreview?.();
}
export function onPresentationChange(cb: (prefs: PresentationPrefs) => void): () => void {
  return wd?.onPresentationChange?.((p) => cb(asPresentation(p))) ?? (() => {});
}

/** Where Display & HUD should open: at a bubble, at a new one for a corner,
 *  at the set-up wizard (`onboarding`, from main on a first run), or at a tab
 *  (`tab`, the renderer's own: the harness uses it). */
export type EditorTarget = {
  bubbleId?: string;
  newAt?: string;
  onboarding?: boolean;
  tab?: 'bubbles' | 'screen' | 'integrations';
} | null;
export function onPresentationOpen(cb: (target: EditorTarget) => void): () => void {
  return wd?.onPresentationOpen?.(cb) ?? (() => {});
}

/** Phase 8 — the vault notes behind the HUD bubbles: built-in readers by id,
 *  owner-defined bubbles by definition. Empty in a plain browser or with no
 *  vault; each bubble copes with a gap. */
export async function readWidgets(
  ids: string[],
  custom: { id: string; type: string; source: object }[],
  today: string,
): Promise<WidgetData> {
  if (!ids.length && !custom.length) return {};
  try {
    return (await wd?.widgetsRead?.({ ids, custom, today })) ?? {};
  } catch {
    return {};
  }
}

/** One call to a private add-on's main-process handler (Phase 9.3), or null. */
export async function callAddon(id: string, name: string, arg?: unknown): Promise<unknown> {
  try {
    return (await wd?.addonCall?.(id, name, arg)) ?? null;
  } catch {
    return null;
  }
}

/** What is playing, or null (nothing playing, no player session). */
export async function readNowPlaying(): Promise<NowPlaying | null> {
  try {
    return (await wd?.nowPlaying?.()) ?? null;
  } catch {
    return null;
  }
}

/** Every note in the vault, for the editor's path picker. */
export async function listVaultNotes(): Promise<string[]> {
  try {
    return (await wd?.widgetsNotes?.()) ?? [];
  } catch {
    return [];
  }
}

export interface NoteDescription {
  exists: boolean;
  file: string;
  headings: string[];
  keys: string[];
}
/** One note's headings and frontmatter keys (tokens resolved for `today`). */
export async function describeNote(path: string, today: string): Promise<NoteDescription> {
  try {
    return (await wd?.widgetsDescribe?.({ path, today })) ?? { exists: false, file: '', headings: [], keys: [] };
  } catch {
    return { exists: false, file: '', headings: [], keys: [] };
  }
}

// ---- arrange mode ----------------------------------------------------------

export type ArrangeAction =
  | { type: 'move'; id: string; anchor: string }
  | { type: 'reorder'; id: string; dir: -1 | 1 }
  | { type: 'hide'; id: string }
  | { type: 'show'; id: string; anchor?: string }
  | { type: 'edit'; id: string }
  | { type: 'add'; anchor: string }
  | { type: 'drop'; id: string; x: number; y: number }
  | { type: 'undo' };

export type ArrangeState = { on: boolean; canUndo: boolean };
const ARRANGE_OFF: ArrangeState = { on: false, canUndo: false };

export function setArrange(on: boolean): void {
  void wd?.arrangeSet?.(on);
}
export async function getArrange(): Promise<ArrangeState> {
  try {
    return (await wd?.arrangeGet?.()) ?? ARRANGE_OFF;
  } catch {
    return ARRANGE_OFF;
  }
}
export async function arrangeAction(action: ArrangeAction): Promise<void> {
  try {
    await wd?.arrangeAction?.(action);
  } catch {
    /* the next presentation:changed push is the truth either way */
  }
}
export function arrangeDrag(point: { x: number; y: number } | null): void {
  wd?.arrangeDrag?.(point);
}
export function onArrange(cb: (state: ArrangeState) => void): () => void {
  return wd?.onArrange?.(cb) ?? (() => {});
}
export function onArrangeTarget(cb: (anchor: string | null) => void): () => void {
  return wd?.onArrangeTarget?.(cb) ?? (() => {});
}
/** Hover fade: the cursor's point inside this HUD corner window, or null. */
export function onHudHover(cb: (point: { x: number; y: number } | null) => void): () => void {
  return wd?.onHudHover?.(cb) ?? (() => {});
}

/** Read the weekly note + `#thisweek` sweep for an ISO week id (e.g. "2026-W36").
 *  Returns null in a plain browser or when the vault isn't reachable. */
export async function readVaultWeek(weekId: string): Promise<VaultWeek | null> {
  if (!wd?.readWeek) return null;
  try {
    return (await wd.readWeek(weekId)) as VaultWeek | null;
  } catch {
    return null;
  }
}

/**
 * Phase 5 §6 — the open items in `Backlog.md`'s holding pen. Empty outside
 * Electron, which is also what a vault with no backlog file looks like: the tab
 * renders its own "nothing here yet" rather than an error.
 */
export async function readBacklog(): Promise<VaultTask[]> {
  if (!wd?.readBacklog) return [];
  try {
    const r = await wd.readBacklog();
    return r.ok && Array.isArray(r.items) ? r.items : [];
  } catch {
    return [];
  }
}

/** Quick capture: append one line to the holding pen. */
/** Capture a line into the backlog. `readOnly`: writing to the notes folder is off. */
export async function appendBacklog(text: string): Promise<{ ok: boolean; readOnly?: boolean }> {
  if (!wd?.appendBacklog) return { ok: false };
  try {
    const r = (await wd.appendBacklog(text)) as { ok?: boolean; readOnly?: boolean } | undefined;
    return { ok: Boolean(r?.ok), readOnly: Boolean(r?.readOnly) };
  } catch {
    return { ok: false };
  }
}

// ---- your data (Phase 9.6) ---------------------------------------------------

export async function saveDiagnostics(): Promise<void> {
  await wd?.saveDiagnostics?.().catch(() => undefined);
}
export async function exportSettings(): Promise<void> {
  await wd?.exportSettings?.().catch(() => undefined);
}
/** Asks first (main's dialog); on yes the app deletes its data and quits. */
export async function removeAllData(): Promise<void> {
  await wd?.removeAllData?.().catch(() => undefined);
}

// ---- set-up (Phase 9.5) ------------------------------------------------------

export interface OnboardingStatus {
  done: boolean;
  notes: 'builtin' | 'folder';
  calendars: number;
}

/** What the folder dialog found (electron/notesdetect.cjs); folders are vault-relative. */
export interface FolderPick {
  ok: boolean;
  canceled?: boolean;
  name?: string;
  detected?: {
    obsidian: boolean;
    weeklyDir: string | null;
    dailyDir: string | null;
    backlogPath: string | null;
    weeks: number;
    days: number;
  } | null;
}

export interface NotesSettings {
  kind: 'builtin' | 'folder';
  name: string;
  weeklyDir: string;
  dailyDir: string;
  backlogPath: string;
  taskTag: string;
  taskFolders: string;
  write: boolean;
}

export interface NotesApply {
  use: 'builtin' | 'picked' | 'current';
  weeklyDir?: string;
  dailyDir?: string;
  backlogPath?: string;
  taskTag?: string;
  taskFolders?: string;
  write?: boolean;
}

type Res = { ok: boolean; error?: string; restart?: boolean };
const failed = (e: unknown): Res => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function onboardingStatus(): Promise<OnboardingStatus | null> {
  try {
    return (await wd?.onboardingStatus?.()) ?? null;
  } catch {
    return null;
  }
}
export async function finishOnboarding(): Promise<Res> {
  try {
    return (await wd?.onboardingFinish?.()) ?? { ok: false };
  } catch (e) {
    return failed(e);
  }
}
export async function chooseNotesFolder(): Promise<FolderPick> {
  try {
    return (await wd?.notesChooseFolder?.()) ?? { ok: false };
  } catch {
    return { ok: false };
  }
}
export async function notesSettings(): Promise<NotesSettings | null> {
  try {
    return (await wd?.notesSettings?.()) ?? null;
  } catch {
    return null;
  }
}
export async function applyNotes(a: NotesApply): Promise<Res> {
  try {
    return (await wd?.notesApply?.(a)) ?? { ok: false };
  } catch (e) {
    return failed(e);
  }
}
export async function nowPlayingSettings(): Promise<{ player: string } | null> {
  try {
    return (await wd?.nowPlayingSettings?.()) ?? null;
  } catch {
    return null;
  }
}
export async function setNowPlayingPlayer(p: string): Promise<Res> {
  try {
    return (await wd?.nowPlayingSetPlayer?.(p)) ?? { ok: false };
  } catch (e) {
    return failed(e);
  }
}
/** Restart Desktop HUD to apply settings read at start-up (notes, player). */
export async function restartApp(): Promise<void> {
  await wd?.restartApp?.().catch(() => undefined);
}

/** Where notes come from (Phase 9.4), for Display & HUD → Notes. */
export interface NotesStatus {
  kind: 'builtin' | 'folder';
  name: string;
  ready: boolean;
  canWrite: boolean;
  backlog: string;
  weekly: string;
}

export async function notesStatus(): Promise<NotesStatus | null> {
  try {
    return (await wd?.notesStatus?.()) ?? null;
  } catch {
    return null;
  }
}

export async function setNotesWrite(on: boolean): Promise<boolean> {
  try {
    return Boolean((await wd?.notesSetWrite?.(on))?.ok);
  } catch {
    return false;
  }
}

/** Dismiss the quick-capture window. */
export function hideCapture(): void {
  void wd?.hideCapture?.();
}

// ---- focus mode (Phase 6 §2) ----------------------------------------------

/** The block currently being counted down, or null. */
export async function focusGet(): Promise<FocusSession | null> {
  if (!wd?.focusGet) return null;
  try {
    return (await wd.focusGet()) as FocusSession | null;
  } catch {
    return null;
  }
}

/** Every window follows the same session — the main process starts and ends
 *  it (tray, Ctrl+Alt+F, the block's end), the HUD shows it. */
export function onFocusChange(cb: (s: FocusSession | null) => void): () => void {
  return wd?.onFocusChange?.(cb) ?? (() => {});
}

/** Tell the main process a block just entered its lead window, so it can bring
 *  the HUD up if it's hidden. Fire-and-forget. */
export function reportImminent(key: string): void {
  void wd?.hudImminent?.(key);
}

/** Subscribe to the main process's vault file-watcher (electron/vault.cjs).
 *  Fires in every window, so an edit made in Obsidian reaches the HUD, the
 *  ambient overlay and the settings preview at the same time — this is what replaced the
 *  per-renderer vault poll. No-op in a plain browser. */
export function onVaultChange(cb: () => void): () => void {
  return wd?.onVaultChange?.(cb) ?? (() => {});
}

// ---- week skeleton (recurring blocks) -----------------------------------

export async function writeSkeletonYaml(yaml: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await wd?.skeletonWrite?.(yaml)) ?? { ok: false, error: 'Not available here' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The recurring-blocks file changed (the editor saved it). */
export function onSkeletonChange(cb: () => void): () => void {
  return wd?.onSkeletonChange?.(cb) ?? (() => {});
}

export async function readSkeletonYaml(): Promise<string | null> {
  if (!wd?.skeletonRead) return null;
  try {
    const r = await wd.skeletonRead();
    return r.ok ? r.yaml : null;
  } catch {
    return null;
  }
}

// ---- Google Calendar ------------------------------------------------------

export async function googleStatus(): Promise<GoogleStatus> {
  if (!wd?.googleStatus) return { configured: false, connected: false, email: null };
  try {
    return await wd.googleStatus();
  } catch {
    return { configured: false, connected: false, email: null };
  }
}

export async function connectGoogle(): Promise<{ ok: boolean; error?: string }> {
  if (!wd?.connectGoogle) return { ok: false, error: 'desktop app only' };
  try {
    return await wd.connectGoogle();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disconnectGoogle(): Promise<void> {
  try {
    await wd?.disconnectGoogle?.();
  } catch {
    /* ignore */
  }
}

export function onGoogleChange(cb: () => void): () => void {
  return wd?.onGoogleChange?.(cb) ?? (() => {});
}

/** One wire event (electron/google.cjs `toWireEvent`) → a `CalEvent`. Shared by
 *  the insert reply and the range read so the §3 session fields can't be
 *  carried by one path and dropped by the other. */
function toCalEvent(e: Record<string, unknown>): CalEvent {
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  return {
    uid: String(e.uid),
    title: String(e.title),
    description: e.description ? String(e.description) : undefined,
    start: new Date(String(e.start)),
    end: new Date(String(e.end)),
    allDay: Boolean(e.allDay),
    taskId: e.taskId ? String(e.taskId) : undefined,
    session: num(e.session),
    sessions: num(e.sessions),
    // Bug #28: these two were missing, so `ev.source` was always undefined in the
    // renderer — which meant the ◈ open-note and ☐ tick-source controls (Phase 5
    // §5) never rendered at all, on any block, ever. google.cjs put both on the
    // wire correctly; the mapping dropped them at the boundary.
    source: e.source ? String(e.source) : undefined,
    sourceId: e.sourceId ? String(e.sourceId) : undefined,
  };
}

function toSyncStatus(raw: Record<string, unknown>): CalSyncStatus {
  return {
    lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : null,
    lastError: raw.lastError ? String(raw.lastError) : null,
    tokenGone: Boolean(raw.tokenGone),
    syncing: Boolean(raw.syncing),
    count: Number(raw.count) || 0,
    synced: Boolean(raw.synced),
  };
}

/** State of the main-process sync loop (the Calendar card). Null in a plain
 *  browser, or when Google isn't configured — there's no store either way. */
export async function calendarSyncStatus(): Promise<CalSyncStatus | null> {
  if (!wd?.calStatus) return null;
  try {
    const raw = await wd.calStatus();
    return raw ? toSyncStatus(raw) : null;
  } catch {
    return null;
  }
}

/** Subscribe to the main process's per-sync push. Fires for every window, so
 *  the HUD / ambient / settings preview all see the same deltas at once. */
export function onCalendarChange(cb: (sync: CalSyncStatus) => void): () => void {
  return wd?.onCalendarChange?.((raw) => cb(toSyncStatus(raw))) ?? (() => {});
}

/** Events for a range from the events slot (Phase 9.4): every calendar the
 *  user has added, plus an add-on's, merged and parsed in the main process.
 *  A local read, so it is instant and works offline. Null with no bridge (a
 *  plain browser tab), where there is no calendar. */
export async function loadEvents(timeMin: Date, timeMax: Date): Promise<CalEvent[] | null> {
  if (!wd?.eventsList) return null;
  try {
    const r = await wd.eventsList({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() });
    return r.ok ? r.events.map(toCalEvent) : null;
  } catch {
    return null;
  }
}

/** A calendar source as Display & HUD shows it. Never carries the link. */
export interface CalendarSource {
  id: string;
  kind: 'ics-url' | 'ics-file';
  name: string;
  configured: boolean;
  fetchedAt: number | null;
  lastError: string | null;
  warning: string | null;
  count: number;
  file?: string;
}

export async function calendarSources(): Promise<CalendarSource[]> {
  try {
    return (await wd?.eventsSources?.()) ?? [];
  } catch {
    return [];
  }
}

type AddResult = { ok: boolean; error?: string; canceled?: boolean };
const fail = (e: unknown): AddResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function addCalendarLink(name: string, url: string): Promise<AddResult> {
  try {
    return (await wd?.eventsAddLink?.({ name, url })) ?? { ok: false, error: 'Not available here' };
  } catch (e) {
    return fail(e);
  }
}

export async function addCalendarFile(name: string): Promise<AddResult> {
  try {
    return (await wd?.eventsAddFile?.({ name })) ?? { ok: false, error: 'Not available here' };
  } catch (e) {
    return fail(e);
  }
}

export async function removeCalendar(id: string): Promise<void> {
  await wd?.eventsRemove?.(id).catch(() => undefined);
}

export async function renameCalendar(id: string, name: string): Promise<void> {
  await wd?.eventsRename?.(id, name).catch(() => undefined);
}

export async function refreshCalendars(id?: string): Promise<void> {
  await wd?.eventsRefresh?.(id).catch(() => undefined);
}

/** A calendar source changed: new text, added, removed, or the week turned. */
export function onEventsChange(cb: () => void): () => void {
  return wd?.onEventsChange?.(cb) ?? (() => {});
}
