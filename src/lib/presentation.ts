// Display & HUD preferences, renderer side.
//
// `electron/presentation.cjs` owns the file, the validation and the migrations
// (v1 one panel → v2 widgets → v3 bubbles); this is the typed mirror the
// renderer draws from, plus the defaults it shows before the first read lands
// (and in a plain browser). test/presentation.test.ts asserts these defaults
// equal the main process's.

export const ANCHORS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;
export type Anchor = (typeof ANCHORS)[number];

export const WIDGET_IDS = [
  'clock',
  'upcoming',
  'placed',
  'weekstrip',
  'intention',
  'health',
  'streaks',
  'daily',
  'backlog',
  'nowplaying',
  'radar',
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** What a bubble draws. `builtin` is one of the app's widgets (its `id` says
 *  which); the others are bubbles the owner defines. */
export type BubbleType = 'builtin' | 'note' | 'tasks' | 'fields' | 'text';

export interface NoteSource {
  /** Vault-relative, `.md` optional, may use `{today}` `{week}` … tokens. */
  path: string;
  /** Section heading; empty = the whole note. */
  heading: string;
  /** `open` tasks · all `tasks` · text `lines`. */
  items: 'open' | 'tasks' | 'lines';
}
export interface TasksSource {
  /** Vault-relative folder (or one note); empty = the whole vault. */
  folder: string;
  tag: string;
  due: 'any' | 'overdue' | 'today' | 'week';
  priority: 'any' | 'medium' | 'high' | 'highest';
  includeDone: boolean;
}
export interface FieldsSource {
  path: string;
  keys: string[];
}
export interface TextSource {
  text: string;
}

export interface ShowRules {
  /** Skeleton block kinds (`stream`, `gym`…) during which this bubble hides. */
  hideDuring: string[];
  /** When non-empty, the bubble shows *only* during these kinds. */
  onlyDuring: string[];
  /** 0 = Monday … 6 = Sunday; empty = every day. */
  days: number[];
  /** Minutes since midnight; may wrap midnight. null = all day. */
  hours: { from: number; to: number } | null;
  /** Stay up during a focus session? null = the bubble type's default. */
  inFocus: boolean | null;
}

export interface Bubble {
  /** A built-in widget id, or `b-…` for an owner-defined bubble. */
  id: string;
  type: BubbleType;
  enabled: boolean;
  anchor: Anchor;
  /** Empty = the type's default title. */
  title: string;
  /** Row limit; null = the default (the HUD's "rows per list"). */
  rows: number | null;
  /** `full` = the corner's width; `fit` = only as wide as the content. */
  width: 'full' | 'fit';
  /** This bubble's background, 0–95 (%); null = the HUD's Background setting. */
  bgOpacity: number | null;
  show: ShowRules;
  source: Partial<NoteSource & TasksSource & FieldsSource & TextSource>;
}

/**
 * Extras: optional flourishes, each its own switch (Display & HUD → Screens →
 * Extras), all off by default. `electron/presentation.cjs` EXTRAS is the list
 * that validates them; a test keeps the two equal. The Today radar is a
 * built-in bubble instead, so its switch is its On-the-HUD toggle.
 */
export const EXTRA_IDS = [
  'streakLevels',
  'bossBar',
  'objectiveComplete',
  'dayNight',
  'debrief',
  'upNext',
] as const;
export type ExtraId = (typeof EXTRA_IDS)[number];
export type Extras = Record<ExtraId, boolean>;

/** Keys an extra had before it was renamed, as in electron/presentation.cjs
 *  EXTRA_RENAMED: `radioLog` became `upNext`. The new key wins once it is
 *  written. */
export const EXTRA_RENAMED: Partial<Record<ExtraId, string>> = {
  upNext: 'radioLog',
};

export const EXTRAS_OFF: Extras = Object.fromEntries(EXTRA_IDS.map((k) => [k, false])) as Extras;

/** Model name and desktop geometry of a chosen display (electron/presentation.cjs). */
export type DisplayHint = { label: string; x: number; y: number; width: number; height: number };

/** How dates and times are drawn (Phase 9.4, lib/fmt.ts). Rendering only:
 *  the data stays ISO and Monday-indexed. */
export interface LocalePrefs {
  weekStart: 'mon' | 'sun';
  /** `auto` follows the system locale. */
  clock: 'auto' | '12h' | '24h';
}

export const LOCALE_DEFAULTS: LocalePrefs = { weekStart: 'mon', clock: 'auto' };

/** A whole LocalePrefs from anything; returns the input when it already is one. */
export function asLocale(l: unknown): LocalePrefs {
  const x = (l && typeof l === 'object' ? l : {}) as Partial<Record<string, unknown>>;
  const weekStart = x.weekStart === 'sun' ? 'sun' : 'mon';
  const clock = x.clock === '12h' || x.clock === '24h' ? x.clock : 'auto';
  return x.weekStart === weekStart && x.clock === clock && Object.keys(x).length === 2 ? (l as LocalePrefs) : { weekStart, clock };
}

export interface PresentationPrefs {
  v: 3;
  ambient: { enabled: boolean; idleSeconds: number; display: string; displayHint?: DisplayHint };
  hud: {
    display: string;
    /** What `display` looked like when chosen, so a renumbered monitor is found again. */
    displayHint?: DisplayHint;
    scale: 'compact' | 'standard' | 'large';
    upcomingRows: 1 | 2 | 3 | 4 | 5 | 6;
    /** What sits behind a bubble's text (Phase 9.5): only the text's halo, a
     *  soft scrim, or the blade panel. */
    backdrop: Backdrop;
    /** Bubble background opacity, 0–95 (%): the scrim's or the panel's. */
    bgOpacity: number;
    /** Display order is array order; placement is each bubble's `anchor`. */
    bubbles: Bubble[];
    /** Corners excluded from screen capture (OBS, screen share). */
    privateAnchors: Anchor[];
    /** Fade the bubble under the cursor (outside arrange mode). */
    hoverFade: boolean;
    /** How much of a hovered bubble is left, 5–60 (% of its normal look). */
    hoverOpacity: number;
  };
  extras: Extras;
  locale: LocalePrefs;
  /** Private add-ons' own settings (Phase 9.3), by add-on id, kept as they are. */
  addons?: Record<string, unknown>;
}

export type PresentationDisplay = { id: string; label: string; primary: boolean };

/** What sits behind the HUD's text (Phase 9.5). `panel` is the blade plate the
 *  HUD has always drawn; `scrim` a soft-edged shade with no keyline; `none`
 *  only the per-glyph halo. electron/presentation.cjs BACKDROPS validates it. */
export const BACKDROPS = ['none', 'scrim', 'panel'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** The default Background, chosen by measurement (Phase 9.5, design-shots
 *  `contrast`): on the panel at 85% body text (6.9:1) and the cobalt times
 *  (4.8:1) keep 4.5:1 over a white window; 65% gave 3.4:1. Files that
 *  already store a value keep it. */
export const BG_OPACITY_DEFAULT = 85;

/** One bubble's own fill, when it overrides the HUD's. Set on the bubble, it
 *  wins over the stack's --hud-alpha by ordinary CSS inheritance. */
export function bubbleAlphaStyle(b: Bubble): Record<string, string> | undefined {
  return b.bgOpacity == null ? undefined : { '--hud-alpha': String(b.bgOpacity / 100) };
}

/** The CSS custom properties a stack of bubbles reads: its fill, and how much
 *  of a bubble is left while the cursor is over it (hover fade). */
export function hudAlphaStyle(prefs: PresentationPrefs): Record<string, string> {
  return {
    '--hud-alpha': String((prefs.hud.bgOpacity ?? BG_OPACITY_DEFAULT) / 100),
    '--hud-hover-opacity': String((prefs.hud.hoverOpacity ?? 20) / 100),
  };
}

const builtin = (
  id: WidgetId,
  enabled: boolean,
  anchor: Anchor,
  hideDuring: string[] = [],
  width: Bubble['width'] = 'full',
  bgOpacity: number | null = null,
): Bubble => ({
  id,
  type: 'builtin',
  enabled,
  anchor,
  title: '',
  rows: null,
  width,
  bgOpacity,
  show: { hideDuring, onlyDuring: [], days: [], hours: null, inFocus: null },
  source: {},
});

export const PRESENTATION_DEFAULTS: PresentationPrefs = {
  v: 3,
  ambient: { enabled: true, idleSeconds: 180, display: 'primary' },
  hud: {
    display: 'primary',
    scale: 'standard',
    upcomingRows: 4,
    backdrop: 'panel',
    bgOpacity: BG_OPACITY_DEFAULT,
    bubbles: [
      builtin('clock', true, 'top-right'),
      builtin('upcoming', true, 'top-right'),
      builtin('placed', true, 'top-right'),
      builtin('weekstrip', true, 'top-right'),
      builtin('intention', true, 'top-left'),
      builtin('health', true, 'top-left'),
      builtin('streaks', true, 'top-left'),
      builtin('daily', true, 'bottom-left'),
      builtin('backlog', false, 'top-left'),
      builtin('nowplaying', true, 'bottom-right', [], 'fit', 85),
      builtin('radar', false, 'top-right'),
    ],
    privateAnchors: ['bottom-left'],
    hoverFade: true,
    hoverOpacity: 20,
  },
  extras: EXTRAS_OFF,
  locale: LOCALE_DEFAULTS,
  addons: {},
};

/**
 * The renderer can see an older shape for a moment — the smoke test's
 * fixture, or a main process that hasn't been restarted since an upgrade.
 * Anything that isn't a v3 object draws with the defaults rather than
 * crashing on a missing `bubbles` array.
 */
export function asPresentation(p: unknown): PresentationPrefs {
  const x = p as PresentationPrefs | null;
  if (!(x && x.v === 3 && Array.isArray(x.hud?.bubbles))) return PRESENTATION_DEFAULTS;
  // A field added after the file was written (bgOpacity, extras) is filled in
  // here too, so the renderer never draws "undefined%" from an older main
  // process — and an extra it doesn't know stays off.
  let hud = typeof x.hud.bgOpacity === 'number' ? x.hud : { ...x.hud, bgOpacity: PRESENTATION_DEFAULTS.hud.bgOpacity };
  // A file from before the backdrop setting drew the panel, and still does.
  if (!(BACKDROPS as readonly string[]).includes(hud.backdrop)) hud = { ...hud, backdrop: 'panel' };
  if (typeof hud.hoverFade !== 'boolean') hud = { ...hud, hoverFade: PRESENTATION_DEFAULTS.hud.hoverFade };
  const hoverOpacity = Number(hud.hoverOpacity);
  if (!(hud.hoverOpacity != null && Number.isFinite(hoverOpacity) && hoverOpacity >= 5 && hoverOpacity <= 60)) {
    hud = { ...hud, hoverOpacity: PRESENTATION_DEFAULTS.hud.hoverOpacity };
  } else if (!Number.isInteger(hoverOpacity) || hoverOpacity !== hud.hoverOpacity) {
    hud = { ...hud, hoverOpacity: Math.round(hoverOpacity) };
  }
  const extras = asExtras(x.extras);
  const locale = asLocale(x.locale);
  return hud === x.hud && extras === x.extras && locale === x.locale ? x : { ...x, hud, extras, locale };
}

/** Every extra, each a real `true` or off. Returns the input when it's already whole. */
export function asExtras(e: unknown): Extras {
  const x = (e && typeof e === 'object' ? e : {}) as Partial<Record<string, unknown>>;
  if (EXTRA_IDS.every((k) => typeof x[k] === 'boolean') && Object.keys(x).length === EXTRA_IDS.length) return x as Extras;
  // Renamed keys (radioLog → upNext):
  // an older main process may still send the old one.
  return Object.fromEntries(
    EXTRA_IDS.map((k) => {
      const old = EXTRA_RENAMED[k];
      return [k, x[k] === true || (x[k] === undefined && old != null && x[old] === true)];
    }),
  ) as Extras;
}

/** A fresh id for an owner-defined bubble. */
export function newBubbleId(): string {
  return `b-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;
}

// ---- presets (Phase 9.5) -----------------------------------------------------
//
// Starting layouts for the set-up wizard, one per persona in the Phase 9 plan:
// Minimal for someone with a calendar and no notes (P1), Focus for someone who
// plans the week in notes (P2), Full for everything. A preset decides which
// built-in bubbles are on and where; the owner's own bubbles are left as they
// are, except the week's note section, which Focus and Full add (and Minimal
// switches off). A bubble with no data still hides itself on the HUD, so Full
// never puts an empty card on the desktop.

export const PRESETS = ['minimal', 'focus', 'full'] as const;
export type Preset = (typeof PRESETS)[number];

/** The stable id of the note section a preset adds: this week's note, open tasks. */
export const PRESET_NOTE_ID = 'b-weeknote';

const PRESET_LAYOUT: Record<Preset, [string, Anchor][]> = {
  minimal: [
    ['clock', 'top-right'],
    ['upcoming', 'top-right'],
    ['radar', 'top-right'],
  ],
  focus: [
    ['clock', 'top-right'],
    ['upcoming', 'top-right'],
    ['radar', 'top-right'],
    ['intention', 'top-left'],
    ['health', 'top-left'],
    [PRESET_NOTE_ID, 'top-left'],
  ],
  full: [
    ['clock', 'top-right'],
    ['upcoming', 'top-right'],
    ['radar', 'top-right'],
    ['placed', 'top-right'],
    ['weekstrip', 'top-right'],
    ['intention', 'top-left'],
    ['health', 'top-left'],
    [PRESET_NOTE_ID, 'top-left'],
    ['streaks', 'top-left'],
    ['backlog', 'top-left'],
    ['daily', 'bottom-left'],
    ['nowplaying', 'bottom-right'],
  ],
};

/** The bubble ids a preset turns on, in order, with their corners. */
export function presetLayout(preset: Preset): [string, Anchor][] {
  return (PRESET_LAYOUT[preset] ?? PRESET_LAYOUT.minimal).map(([id, a]) => [id, a]);
}

/** The note section Focus and Full add: open tasks under `## Tasks` in this week's note. */
function presetNoteBubble(anchor: Anchor, weeklyDir: string): Bubble {
  const dir = weeklyDir.split('\\').join('/').replace(/^\/+|\/+$/g, '');
  return {
    id: PRESET_NOTE_ID,
    type: 'note',
    enabled: true,
    anchor,
    title: 'This week',
    rows: null,
    width: 'full',
    bgOpacity: null,
    show: { hideDuring: [], onlyDuring: [], days: [], hours: null, inFocus: null },
    source: { path: dir ? `${dir}/{week}` : '{week}', heading: 'Tasks', items: 'open' },
  };
}

/**
 * `prefs` with a preset's layout. Pure: the input is left alone. The preset's
 * bubbles come first, in its order and corners; every other bubble keeps its
 * place after them. Built-ins outside the preset are switched off; the
 * owner's own bubbles are untouched. `weeklyDir` is where the week's notes
 * live, for the note section (`Weekly`, as in the built-in notes, by default).
 * Screen settings (backdrop, size, display) are not part of a preset.
 */
export function applyPreset(
  prefs: PresentationPrefs,
  preset: Preset,
  opts: { weeklyDir?: string } = {},
): PresentationPrefs {
  const layout = presetLayout(preset);
  const wanted = new Set(layout.map(([id]) => id));
  const byId = new Map(prefs.hud.bubbles.map((b) => [b.id, b]));
  const first: Bubble[] = [];
  for (const [id, anchor] of layout) {
    const have = byId.get(id);
    if (have) first.push({ ...have, enabled: true, anchor });
    else if (id === PRESET_NOTE_ID) first.push(presetNoteBubble(anchor, opts.weeklyDir ?? 'Weekly'));
  }
  const rest = prefs.hud.bubbles
    .filter((b) => !wanted.has(b.id))
    .map((b) => ((b.type === 'builtin' || b.id === PRESET_NOTE_ID) && b.enabled ? { ...b, enabled: false } : b));
  return { ...prefs, hud: { ...prefs.hud, bubbles: [...first, ...rest] } };
}

/** The preset a layout matches — its enabled built-ins and note section are
 *  exactly that preset's — or null for a layout of the owner's own. */
export function presetOf(prefs: PresentationPrefs): Preset | null {
  const key = (ids: string[]) => [...ids].sort().join(',');
  const on = key(prefs.hud.bubbles.filter((b) => b.enabled && (b.type === 'builtin' || b.id === PRESET_NOTE_ID)).map((b) => b.id));
  return PRESETS.find((p) => key(presetLayout(p).map(([id]) => id)) === on) ?? null;
}
