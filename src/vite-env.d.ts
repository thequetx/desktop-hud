/// <reference types="vite/client" />

interface WdBridge {
  isElectron: boolean;
  activityState?: () => Promise<import('./lib/polling').ActivityState>;
  onActivity?: (cb: (state: import('./lib/polling').ActivityState) => void) => () => void;
  /** The Display & HUD window closes itself (main reverts any unsaved preview). */
  hideSettings: () => void;
  resizeHud: (height: number) => void;
  /** The HUD was shown (true) or hidden (false); returns an unsubscribe fn. */
  onHudShown?: (cb: (shown: boolean) => void) => () => void;
  /** The last hud:shown value the preload saw; null before the first. */
  hudShown?: () => boolean | null;
  /** debug: fires on Ctrl+Alt+Shift+H; returns an unsubscribe fn */
  onHudDebugCycle: (cb: () => void) => () => void;
  presentationRead: () => Promise<import('./lib/presentation').PresentationPrefs>;
  presentationDisplays: () => Promise<Array<{ id: string; label: string; primary: boolean }>>;
  presentationWrite: (prefs: import('./lib/presentation').PresentationPrefs) => Promise<{ ok: boolean; prefs?: import('./lib/presentation').PresentationPrefs; error?: string }>;
  presentationReset: () => Promise<{ ok: boolean; prefs?: import('./lib/presentation').PresentationPrefs; error?: string }>;
  previewAmbient: () => Promise<{ ok: boolean }>;
  endAmbientPreview: () => Promise<{ ok: boolean }>;
  onDisplaysChange?: (cb: () => void) => () => void;
  onPresentationChange: (cb: (prefs: import('./lib/presentation').PresentationPrefs) => void) => () => void;
  onPresentationOpen: (cb: (target: { bubbleId?: string; newAt?: string } | null) => void) => () => void;
  widgetsRead: (req: {
    ids: string[];
    custom: { id: string; type: string; source: object }[];
    today: string;
  }) => Promise<import('./lib/widgets').WidgetData>;
  widgetsNotes: () => Promise<string[]>;
  nowPlaying: () => Promise<import('./lib/widgets').NowPlaying | null>;
  addonCall?: (id: string, name: string, arg?: unknown) => Promise<unknown>;
  widgetsDescribe: (req: { path: string; today: string }) => Promise<import('./lib/shell').NoteDescription>;
  presentationPreview: (prefs: import('./lib/presentation').PresentationPrefs) => Promise<{ ok: boolean; prefs?: import('./lib/presentation').PresentationPrefs }>;
  presentationRevert: () => Promise<{ ok: boolean; prefs?: import('./lib/presentation').PresentationPrefs }>;
  arrangeSet: (on: boolean) => Promise<boolean>;
  arrangeGet: () => Promise<import('./lib/shell').ArrangeState>;
  arrangeAction: (action: import('./lib/shell').ArrangeAction) => Promise<{ ok: boolean; anchor?: string; error?: string }>;
  arrangeDrag: (point: { x: number; y: number } | null) => void;
  onArrange: (cb: (state: import('./lib/shell').ArrangeState) => void) => () => void;
  onArrangeTarget: (cb: (anchor: string | null) => void) => () => void;
  /** Hover fade: the cursor's point inside this HUD window, or null. */
  onHudHover?: (cb: (point: { x: number; y: number } | null) => void) => () => void;
  readWeek: (weekId: string) => Promise<unknown>;
  /** Phase 5 §6 — the backlog holding pen. */
  readBacklog: () => Promise<{
    ok: boolean;
    file?: string;
    items?: Array<{ text: string; done: boolean; file: string; line: number }>;
    error?: string;
  }>;
  appendBacklog: (text: string) => Promise<{ ok: boolean; error?: string }>;
  hideCapture: () => Promise<boolean>;
  /** Phase 6 §2 — focus mode. */
  focusGet: () => Promise<{
    uid: string;
    title: string;
    start: string;
    end: string;
  } | null>;
  onFocusChange: (
    cb: (session: { uid: string; title: string; start: string; end: string } | null) => void,
  ) => () => void;
  hudImminent: (key: string) => Promise<{ ok: boolean; shown?: boolean }>;
  onVaultChange: (cb: () => void) => () => void;
  skeletonRead: () => Promise<{ ok: true; yaml: string } | { ok: false; error?: string }>;
  skeletonWrite: (yaml: string) => Promise<{ ok: boolean; error?: string }>;
  onSkeletonChange: (cb: () => void) => () => void;
  googleStatus: () => Promise<{ configured: boolean; connected: boolean; email: string | null }>;
  connectGoogle: () => Promise<{ ok: boolean; error?: string; connected?: boolean; email?: string | null }>;
  disconnectGoogle: () => Promise<{ ok: boolean }>;
  calStatus: () => Promise<Record<string, unknown> | null>;
  notesStatus: () => Promise<import('./lib/shell').NotesStatus>;
  saveDiagnostics: () => Promise<{ ok: boolean; canceled?: boolean }>;
  exportSettings: () => Promise<{ ok: boolean; canceled?: boolean }>;
  removeAllData: () => Promise<{ ok: boolean; canceled?: boolean }>;
  onboardingStatus: () => Promise<import('./lib/shell').OnboardingStatus>;
  onboardingFinish: () => Promise<{ ok: boolean; error?: string }>;
  notesChooseFolder: () => Promise<import('./lib/shell').FolderPick>;
  notesSettings: () => Promise<import('./lib/shell').NotesSettings>;
  notesApply: (a: import('./lib/shell').NotesApply) => Promise<{ ok: boolean; error?: string; restart?: boolean }>;
  nowPlayingSettings: () => Promise<{ player: string }>;
  nowPlayingSetPlayer: (p: string) => Promise<{ ok: boolean; error?: string; restart?: boolean }>;
  restartApp: () => Promise<{ ok: boolean }>;
  notesSetWrite: (on: boolean) => Promise<{ ok: boolean; error?: string }>;
  eventsList: (range: { timeMin: string; timeMax: string }) => Promise<
    { ok: true; events: Array<Record<string, unknown>> } | { ok: false; error?: string }
  >;
  eventsSources: () => Promise<import('./lib/shell').CalendarSource[]>;
  eventsAddLink: (a: { name: string; url: string }) => Promise<{ ok: boolean; error?: string }>;
  eventsAddFile: (a: { name: string }) => Promise<{ ok: boolean; error?: string; canceled?: boolean }>;
  eventsRemove: (id: string) => Promise<{ ok: boolean }>;
  eventsRename: (id: string, name: string) => Promise<{ ok: boolean }>;
  eventsRefresh: (id?: string) => Promise<{ ok: boolean }>;
  onEventsChange: (cb: () => void) => () => void;
  onGoogleChange: (cb: () => void) => () => void;
  onCalendarChange: (cb: (sync: Record<string, unknown>) => void) => () => void;
}

interface Window {
  // kept in sync with Mode in src/lib/types.ts
  __WD_MODE__?: 'settings' | 'ambient' | 'hud' | 'capture';
  wd?: WdBridge;
}

