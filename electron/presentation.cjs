'use strict';

// Local, machine-specific settings for the two transparent Electron surfaces.
// Kept deliberately separate from week-skeleton.yaml: that file is portable
// routine data, whereas a monitor id is only meaningful on this installation.
//
// Phase 8 turns the single HUD panel into **bubbles placed at anchors**. Each
// anchor (a corner of the work area) with at least one enabled bubble gets its
// own click-through window, so a corner can be marked private (excluded from
// screen capture) without hiding the rest of the HUD from the stream.
//
// A bubble is either one of the built-in widgets or one the user defines
// — a note section, a tasks query, a note's fields, or plain text — each with
// its own title, rows and show rules. The editor (PresentationEditor.tsx) and
// arrange mode (Hud.tsx) are the two ways in; this file is the one place a
// stored bubble is validated, whichever way it arrived.
//
// `src/lib/presentation.ts` mirrors the types and defaults for the renderer;
// test/presentation.test.ts asserts the two agree.
const fsp = require('node:fs/promises');
const path = require('node:path');

const ANCHORS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
const SCALES = ['compact', 'standard', 'large'];
const ROWS = [1, 2, 3, 4, 5, 6];

/**
 * The built-in widgets, in default order, with their default placement.
 * **Adding a built-in starts here**: an id appended to this list reaches
 * existing installs through `normalise()`, which fills in any built-in a stored
 * file doesn't mention — so ship new ones `enabled: false` unless they should
 * appear for everyone on upgrade. The renderer's registry (`src/lib/widgets.ts`)
 * holds the matching label and component.
 */
const WIDGET_DEFAULTS = [
  { id: 'clock', enabled: true, anchor: 'top-right', hideDuring: [] },
  { id: 'upcoming', enabled: true, anchor: 'top-right', hideDuring: [] },
  { id: 'placed', enabled: true, anchor: 'top-right', hideDuring: [] },
  { id: 'weekstrip', enabled: true, anchor: 'top-right', hideDuring: [] },
  { id: 'intention', enabled: true, anchor: 'top-left', hideDuring: [] },
  { id: 'health', enabled: true, anchor: 'top-left', hideDuring: [] },
  { id: 'streaks', enabled: true, anchor: 'top-left', hideDuring: [] },
  { id: 'daily', enabled: true, anchor: 'bottom-left', hideDuring: [] },
  { id: 'backlog', enabled: false, anchor: 'top-left', hideDuring: [] },
  // What Windows' media controls say is playing (electron/nowplaying.cjs).
  // More solid than the rest by default: a short, glanceable line over busy
  // windows, where the app behind showed through the artist name (2026-09-24).
  { id: 'nowplaying', enabled: true, anchor: 'bottom-right', hideDuring: [], width: 'fit', bgOpacity: 85 },
  // Extras (2026-09-24): a thin timeline of today. Off by default, like Backlog.
  { id: 'radar', enabled: false, anchor: 'top-right', hideDuring: [] },
];
const WIDGET_IDS = WIDGET_DEFAULTS.map((w) => w.id);

/**
 * Phase 9.3 — a private add-on's bubbles (electron/addon-host.cjs) join the
 * built-ins here, at start-up, before anything is read. Same shape as
 * WIDGET_DEFAULTS; an id that's already known is ignored.
 */
function registerWidgetDefaults(defs) {
  for (const d of Array.isArray(defs) ? defs : []) {
    if (!d || !BUILTIN_ID_RE.test(String(d.id)) || WIDGET_IDS.includes(d.id)) continue;
    WIDGET_DEFAULTS.push({ hideDuring: [], ...d, id: String(d.id) });
    WIDGET_IDS.push(String(d.id));
  }
}

/**
 * A built-in id: lowercase letters, digits and dashes. A stored built-in whose
 * id isn't known in this build (an add-on's bubble, in a build without that
 * add-on) is kept as it is rather than dropped, so a build without the
 * owner's add-ons never deletes their bubbles from presentation.json. It is
 * not drawn (there is no component for it) and gets no default.
 */
const BUILTIN_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** The kinds of bubble a user can create, beside the built-ins. */
const BUBBLE_TYPES = ['builtin', 'note', 'tasks', 'fields', 'text'];
const NOTE_ITEMS = ['open', 'tasks', 'lines'];
const TASK_DUE = ['any', 'overdue', 'today', 'week'];
const TASK_PRIORITY = ['any', 'medium', 'high', 'highest'];
const CUSTOM_ID_RE = /^b-[a-z0-9]{1,16}$/;
const MAX_BUBBLES = 40;
/** `full`: the corner's width, lined up with its neighbours. `fit`: only as wide
 *  as the content needs, hugging the corner's side (a short track, a clock). */
const WIDTHS = ['full', 'fit'];
/** Short of fully opaque: a HUD you can't see through is a window, not a HUD. */
const MAX_BG_OPACITY = 95;
/** What sits behind a bubble's text (Phase 9.5): `panel`, the blade plate the
 *  HUD always drew (the default, and what a file from before the setting
 *  keeps); `scrim`, a soft-edged shade with no keyline; `none`, only the
 *  per-glyph halo. The Background setting is the scrim's or the panel's
 *  strength. */
const BACKDROPS = ['none', 'scrim', 'panel'];
/** The default Background. Measured, not eyeballed (design-shots `contrast`,
 *  2026-10-15): at 85% the panel keeps body text (6.9:1) and the cobalt times
 *  (4.8:1) above 4.5:1 over a white window; the old 65% gave 3.4:1 for body
 *  text there. A stored value is kept. */
const BG_OPACITY_DEFAULT = 85;
/** Hover fade: how much of a bubble is left while the cursor is over it, in
 *  percent of its normal look. 0 would hide a bubble outright (and lose the
 *  cue that the cursor is on one); past 60 there is little to see through. */
const MIN_HOVER_OPACITY = 5;
const MAX_HOVER_OPACITY = 60;

/**
 * Extras: small, optional flourishes, each its own switch in Display & HUD
 * (Screens → Extras), **all off by default**. A file written before they
 * existed has no `extras` key and loads with every one off; an unknown key is
 * dropped; anything but a real `true` is off. The Today radar isn't here: it's
 * a built-in bubble, so its switch is its On-the-HUD toggle.
 */
const EXTRAS = [
  'streakLevels',
  'bossBar',
  'objectiveComplete',
  'dayNight',
  'debrief',
  'upNext',
];

/** Keys an extra had before it was renamed. `radioLog` (the history list)
 *  became `upNext` (the queue) on 2026-09-24. An owner keeps what they had
 *  until the new key is written, and from then on the new key wins. (Three
 *  extras left for private add-ons' own sections in Phase 9.3.) */
const EXTRA_RENAMED = { upNext: 'radioLog' };

// ---- locale (Phase 9.4) ------------------------------------------------------
//
// How dates and times are drawn (src/lib/fmt.ts): the week's first day and
// 12/24-hour time. Rendering only; the data stays ISO and Monday-indexed.
// `auto` follows the system locale.

function normaliseLocale(raw) {
  const l = raw && typeof raw === 'object' ? raw : {};
  return {
    weekStart: l.weekStart === 'sun' ? 'sun' : 'mon',
    clock: l.clock === '12h' || l.clock === '24h' ? l.clock : 'auto',
  };
}

// ---- add-on sections (Phase 9.3) ----------------------------------------------
//
// A private add-on keeps its own display settings under `addons.<id>` and
// registers how to normalise them (registerPresentationExtension). A section
// whose add-on isn't in this build is kept as it is, within a size cap, so a
// build without the owner's add-ons never loses their settings.

const ADDON_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_ADDON_SECTION = 4096;
const EXTENSIONS = [];

/** { id, normalise(section, rawPrefs) -> section, activeAnchors?(section, prefs) -> anchors } */
function registerPresentationExtension(ext) {
  if (!ext || !ADDON_ID_RE.test(String(ext.id)) || typeof ext.normalise !== 'function') return;
  if (EXTENSIONS.some((e) => e.id === ext.id)) return;
  EXTENSIONS.push(ext);
}

function normaliseAddons(raw) {
  const input = raw && typeof raw.addons === 'object' && raw.addons && !Array.isArray(raw.addons) ? raw.addons : {};
  const out = {};
  for (const [id, section] of Object.entries(input)) {
    if (!ADDON_ID_RE.test(id) || !section || typeof section !== 'object' || Array.isArray(section)) continue;
    try {
      if (JSON.stringify(section).length <= MAX_ADDON_SECTION) out[id] = section;
    } catch {
      // not plain data: dropped
    }
  }
  for (const ext of EXTENSIONS) {
    try {
      out[ext.id] = ext.normalise(input[ext.id], raw || {});
    } catch {
      out[ext.id] = ext.normalise(undefined, {});
    }
  }
  return out;
}

function normaliseExtras(input) {
  const x = input && typeof input === 'object' ? input : {};
  return Object.fromEntries(
    EXTRAS.map((k) => {
      const old = EXTRA_RENAMED[k];
      return [k, x[k] === true || (x[k] === undefined && old != null && x[old] === true)];
    }),
  );
}

/** Skeleton block kinds are free-form yaml (`gym`, `stream`, `meal-prep`…), so
 *  a show rule accepts any kind-shaped token rather than a fixed list. */
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

let userFile = null;

/** A string, trimmed and capped; anything else becomes `fallback`. */
function str(v, max, fallback = '') {
  return typeof v === 'string' ? v.trim().slice(0, max) : fallback;
}

/**
 * A vault-relative note or folder path as typed in the editor. Tokens like
 * `{today}` are kept — widgets.cjs resolves them at read time. Absolute paths
 * and `..` segments are refused here, and again when read.
 */
function vaultPath(v) {
  const p = str(v, 260).replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-z]:/i.test(p) || p.split('/').includes('..')) return '';
  return p;
}

function pick(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function display(v) {
  return typeof v === 'string' && (v === 'primary' || /^[^\s]{1,128}$/.test(v)) ? v : 'primary';
}

/** What a display looked like when it was chosen, kept beside its id. Windows
 *  display ids are not stable: they come from the graphics adapter's runtime
 *  id, so a reconnect, a driver reset or a reboot can renumber every monitor
 *  (found 2026-10-01: the saved HUD id matched none of three plugged-in
 *  monitors). The hint lets the choice be found again by model and geometry. */
function displayHint(v) {
  if (!v || typeof v !== 'object') return undefined;
  const label = typeof v.label === 'string' ? v.label.slice(0, 128) : '';
  const nums = ['x', 'y', 'width', 'height'].map((k) => Number(v[k]));
  if (!nums.every(Number.isFinite)) return undefined;
  const [x, y, width, height] = nums.map(Math.round);
  return { label, x, y, width, height };
}

function hintOf(d) {
  const b = d.bounds || d.workArea;
  return { label: d.label || '', x: b.x, y: b.y, width: b.width, height: b.height };
}

function kinds(list) {
  return Array.isArray(list)
    ? [...new Set(list.filter((k) => typeof k === 'string' && KIND_RE.test(k)))].slice(0, 8)
    : [];
}

function minuteOfDay(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(1440, n)) : null;
}

function builtinBubble(w) {
  return {
    id: w.id,
    type: 'builtin',
    enabled: w.enabled,
    anchor: w.anchor,
    title: '',
    rows: null,
    width: w.width || 'full',
    bgOpacity: w.bgOpacity ?? null,
    show: { hideDuring: [...w.hideDuring], onlyDuring: [], days: [], hours: null, inFocus: null },
    source: {},
  };
}

function defaults() {
  return {
    v: 3,
    ambient: { enabled: true, idleSeconds: 180, display: 'primary' },
    hud: {
      display: 'primary',
      scale: 'standard',
      upcomingRows: 4,
      backdrop: 'panel',
      // How solid the bubbles' background is, in percent; lower lets more of
      // the wallpaper through, 0 is text straight on the desktop.
      bgOpacity: BG_OPACITY_DEFAULT,
      bubbles: WIDGET_DEFAULTS.map(builtinBubble),
      // The personal corner. Excluded from OBS / screen share by the OS, on top
      // of the stream-time show rules on the widgets that default there.
      privateAnchors: ['bottom-left'],
      // Hover fade (2026-10-02): the bubble under the cursor drops to this
      // much of itself, so what's behind it can be read. On by default.
      hoverFade: true,
      hoverOpacity: 20,
    },
    extras: normaliseExtras(null),
    locale: normaliseLocale(null),
    addons: normaliseAddons(null),
  };
}

/**
 * Show rules. Every field narrows; an empty rule set means "always".
 * `days` are 0 = Monday … 6 = Sunday, like the skeleton's. `hours` may wrap
 * midnight (22:00–02:00). `inFocus` null means the bubble type's default.
 */
function normaliseShow(input, fallbackHide = []) {
  const s = input && typeof input === 'object' ? input : {};
  const h = s.hours && typeof s.hours === 'object' ? s.hours : null;
  const from = h ? minuteOfDay(h.from) : null;
  const to = h ? minuteOfDay(h.to) : null;
  return {
    hideDuring: Array.isArray(s.hideDuring) ? kinds(s.hideDuring) : [...fallbackHide],
    onlyDuring: kinds(s.onlyDuring),
    days: Array.isArray(s.days)
      ? [...new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [],
    hours: from != null && to != null && from !== to ? { from, to } : null,
    inFocus: typeof s.inFocus === 'boolean' ? s.inFocus : null,
  };
}

function normaliseSource(type, src) {
  const s = src && typeof src === 'object' ? src : {};
  switch (type) {
    case 'note':
      return { path: vaultPath(s.path), heading: str(s.heading, 120), items: pick(s.items, NOTE_ITEMS, 'open') };
    case 'tasks':
      return {
        folder: vaultPath(s.folder),
        tag: str(s.tag, 64),
        due: pick(s.due, TASK_DUE, 'any'),
        priority: pick(s.priority, TASK_PRIORITY, 'any'),
        includeDone: s.includeDone === true,
      };
    case 'fields':
      return {
        path: vaultPath(s.path),
        keys: Array.isArray(s.keys)
          ? [...new Set(s.keys.map((k) => str(k, 64)).filter(Boolean))].slice(0, 12)
          : [],
      };
    case 'text':
      return { text: str(s.text, 2000) };
    default:
      return {};
  }
}

/** One stored bubble, or null when it can't be drawn. */
function normaliseBubble(input) {
  if (!input || typeof input !== 'object') return null;
  const builtin =
    WIDGET_IDS.includes(input.id) || (input.type === 'builtin' && BUILTIN_ID_RE.test(String(input.id)));
  let type;
  if (builtin) type = 'builtin';
  else if (CUSTOM_ID_RE.test(String(input.id)) && BUBBLE_TYPES.includes(input.type) && input.type !== 'builtin') {
    type = input.type;
  } else return null;
  const d = builtin ? WIDGET_DEFAULTS.find((w) => w.id === input.id) : null;
  const rows = Math.round(Number(input.rows));
  return {
    id: String(input.id),
    type,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d ? d.enabled : true,
    anchor: pick(input.anchor, ANCHORS, d ? d.anchor : 'top-right'),
    title: str(input.title, 60),
    rows: input.rows != null && Number.isFinite(rows) && rows >= 1 ? Math.min(12, rows) : null,
    width: pick(input.width, WIDTHS, (d && d.width) || 'full'),
    // Per-bubble background override; null = the HUD's own Background setting.
    // A key absent from the file takes the built-in's default; an explicit
    // null is the owner choosing the HUD default, and is kept.
    bgOpacity:
      input.bgOpacity === null
        ? null
        : input.bgOpacity !== undefined && input.bgOpacity !== '' && Number.isFinite(Number(input.bgOpacity))
          ? Math.max(0, Math.min(MAX_BG_OPACITY, Math.round(Number(input.bgOpacity))))
          : d && d.bgOpacity != null
            ? d.bgOpacity
            : null,
    show: normaliseShow(input.show, d ? d.hideDuring : []),
    source: normaliseSource(type, input.source),
  };
}

/**
 * Stored order is the display order, so it is kept; unknown and duplicate ids
 * are dropped; and any built-in the file doesn't mention is appended at its
 * default — which is how a built-in added in a later release reaches an
 * existing install without a migration of its own.
 */
function normaliseBubbles(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const b = normaliseBubble(raw);
    if (!b || seen.has(b.id) || out.length >= MAX_BUBBLES) continue;
    seen.add(b.id);
    out.push(b);
  }
  for (const d of WIDGET_DEFAULTS) {
    if (!seen.has(d.id)) out.push(builtinBubble(d));
  }
  return out;
}

/**
 * A v1 file described one panel: a corner plus two show/hide switches. Its
 * owner chose where the HUD lives, so the widgets that *were* that panel stay
 * in that corner; the vault widgets v1 never had arrive at their defaults.
 */
function fromV1(input) {
  const h = input.hud && typeof input.hud === 'object' ? input.hud : {};
  const corner = pick(h.corner, ANCHORS, 'top-right');
  const widgets = WIDGET_DEFAULTS.map((w) => {
    if (w.id === 'clock' || w.id === 'upcoming') return { ...w, anchor: corner };
    if (w.id === 'streaks') {
      return { ...w, anchor: corner, enabled: typeof h.showStreaks === 'boolean' ? h.showStreaks : true };
    }
    if (w.id === 'weekstrip') {
      return { ...w, anchor: corner, enabled: typeof h.showWeekStrip === 'boolean' ? h.showWeekStrip : true };
    }
    return w;
  });
  return { ...input, v: 2, hud: { ...h, widgets } };
}

/** v2 (never installed) had `widgets[]` with a flat `hideDuring`. */
function fromV2(input) {
  const h = input.hud && typeof input.hud === 'object' ? input.hud : {};
  const bubbles = (Array.isArray(h.widgets) ? h.widgets : []).map((w) => ({
    ...w,
    type: 'builtin',
    show: { hideDuring: w && w.hideDuring },
  }));
  return { ...input, v: 3, hud: { ...h, bubbles } };
}

/** `displayHint` only for a specific display, and only when valid — absent
 *  otherwise, so a default file stays exactly the defaults. */
function withHint(section) {
  if (display(section.display) === 'primary') return {};
  const hint = displayHint(section.displayHint);
  return hint ? { displayHint: hint } : {};
}

function normalise(input) {
  const d = defaults();
  if (!input || typeof input !== 'object') return d;
  if (input.v === 1) input = fromV1(input);
  if (input.v === 2) input = fromV2(input);
  if (input.v !== 3) return d;
  const a = input.ambient && typeof input.ambient === 'object' ? input.ambient : {};
  const h = input.hud && typeof input.hud === 'object' ? input.hud : {};
  const idle = Number(a.idleSeconds);
  const opacity = Number(h.bgOpacity);
  const hoverOpacity = Number(h.hoverOpacity);
  const priv = Array.isArray(h.privateAnchors) ? h.privateAnchors : d.hud.privateAnchors;
  return {
    v: 3,
    ambient: {
      enabled: typeof a.enabled === 'boolean' ? a.enabled : d.ambient.enabled,
      idleSeconds: Number.isFinite(idle)
        ? Math.max(60, Math.min(900, Math.round(idle)))
        : d.ambient.idleSeconds,
      display: display(a.display),
      ...withHint(a),
    },
    hud: {
      display: display(h.display),
      ...withHint(h),
      scale: pick(h.scale, SCALES, d.hud.scale),
      upcomingRows: pick(h.upcomingRows, ROWS, d.hud.upcomingRows),
      backdrop: pick(h.backdrop, BACKDROPS, d.hud.backdrop),
      bgOpacity:
        h.bgOpacity != null && h.bgOpacity !== '' && Number.isFinite(opacity)
          ? Math.max(0, Math.min(MAX_BG_OPACITY, Math.round(opacity)))
          : d.hud.bgOpacity,
      bubbles: normaliseBubbles(h.bubbles),
      privateAnchors: ANCHORS.filter((x) => priv.includes(x)),
      hoverFade: typeof h.hoverFade === 'boolean' ? h.hoverFade : d.hud.hoverFade,
      hoverOpacity:
        h.hoverOpacity != null && h.hoverOpacity !== '' && Number.isFinite(hoverOpacity)
          ? Math.max(MIN_HOVER_OPACITY, Math.min(MAX_HOVER_OPACITY, Math.round(hoverOpacity)))
          : d.hud.hoverOpacity,
    },
    extras: normaliseExtras(input.extras),
    locale: normaliseLocale(input.locale),
    addons: normaliseAddons(input),
  };
}

/** Anchors that need a window: at least one enabled bubble placed there, or a
 *  corner an add-on keeps open (say, a decoration that sits there even with
 *  no bubble). */
function activeAnchors(prefs) {
  const used = new Set(prefs.hud.bubbles.filter((b) => b.enabled).map((b) => b.anchor));
  for (const ext of EXTENSIONS) {
    if (typeof ext.activeAnchors !== 'function') continue;
    try {
      for (const a of ext.activeAnchors((prefs.addons || {})[ext.id], prefs) || []) used.add(a);
    } catch {
      // a broken add-on keeps no corner open
    }
  }
  return ANCHORS.filter((a) => used.has(a));
}

function isPrivate(prefs, anchor) {
  return prefs.hud.privateAnchors.includes(anchor);
}

// ---- arrange mode ------------------------------------------------------------
//
// Direct manipulation on the HUD itself. Each action is a pure function of
// (prefs, action) → prefs, so the main process applies it in one place however
// many corner windows are open, and the tests can drive it without Electron.

/**
 * @param {object} prefs normalised preferences
 * @param {{type:string,id?:string,anchor?:string,dir?:number,index?:number}} action
 */
function applyArrange(prefs, action) {
  const list = prefs.hud.bubbles.map((b) => ({ ...b }));
  const i = list.findIndex((b) => b.id === action.id);
  const next = (bubbles) => normalise({ ...prefs, hud: { ...prefs.hud, bubbles } });
  switch (action.type) {
    case 'move': {
      // To another corner: last in that corner's stack, unless an index within
      // that corner's stack is given.
      if (i < 0 || !ANCHORS.includes(action.anchor)) return prefs;
      const [b] = list.splice(i, 1);
      b.anchor = action.anchor;
      const peers = list.map((x, j) => [x, j]).filter(([x]) => x.anchor === action.anchor && x.enabled);
      const at = Number.isInteger(action.index) && action.index < peers.length ? peers[Math.max(0, action.index)][1] : null;
      if (at == null) list.push(b);
      else list.splice(at, 0, b);
      return next(list);
    }
    case 'reorder': {
      // Up or down past the neighbouring *visible* bubble in the same corner,
      // so a disabled bubble between them isn't a step that appears to do nothing.
      if (i < 0) return prefs;
      const dir = action.dir < 0 ? -1 : 1;
      let j = i + dir;
      while (j >= 0 && j < list.length && !(list[j].anchor === list[i].anchor && list[j].enabled)) j += dir;
      if (j < 0 || j >= list.length) return prefs;
      [list[i], list[j]] = [list[j], list[i]];
      return next(list);
    }
    case 'hide':
      if (i < 0) return prefs;
      list[i].enabled = false;
      return next(list);
    case 'show':
      if (i < 0) return prefs;
      list[i].enabled = true;
      if (ANCHORS.includes(action.anchor)) list[i].anchor = action.anchor;
      return next(list);
    default:
      return prefs;
  }
}

function init() {
  const { app } = require('electron');
  userFile = path.join(app.getPath('userData'), 'presentation.json');
}

async function read() {
  if (!userFile) throw new Error('presentation store not initialised');
  try {
    return normalise(JSON.parse(await fsp.readFile(userFile, 'utf8')));
  } catch {
    return defaults();
  }
}

async function write(next) {
  if (!userFile) throw new Error('presentation store not initialised');
  const value = normalise(next);
  try {
    await fsp.mkdir(path.dirname(userFile), { recursive: true });
    const tmp = `${userFile}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, userFile);
    return value;
  } catch (err) {
    console.error('[wd] presentation: write failed', err);
    throw err;
  }
}

async function reset() {
  return write(defaults());
}

/** The display a hint describes, when its id has gone: the same model name
 *  (and, among identical models, the same place and size), else a monitor of
 *  the same place and size. Null when nothing plausibly is the same screen. */
function matchHint(hint, displays) {
  if (!hint) return null;
  const b = (d) => d.bounds || d.workArea || {};
  const sameGeometry = (d) =>
    b(d).x === hint.x && b(d).y === hint.y && b(d).width === hint.width && b(d).height === hint.height;
  const sameSize = (d) => b(d).width === hint.width && b(d).height === hint.height;
  if (hint.label) {
    const named = displays.filter((d) => d.label === hint.label);
    if (named.length === 1) return named[0];
    if (named.length > 1) return named.find(sameGeometry) || named.find(sameSize) || named[0];
  }
  return displays.find(sameGeometry) || null;
}

function resolveDisplay(pref, displays, hint) {
  return (
    displays.find((d) => String(d.id) === pref) ||
    (pref !== 'primary' && matchHint(hint, displays)) ||
    displays.find((d) => d.primary) ||
    displays[0] ||
    null
  );
}

/**
 * Keep each chosen display findable: refresh the hint of a display that is
 * present, and re-point a vanished id at the display its hint now matches.
 * Returns `prefs` itself when nothing changed, so callers can skip a write.
 */
function syncDisplayHints(prefs, displays) {
  let next = prefs;
  for (const key of ['ambient', 'hud']) {
    const section = next[key];
    if (section.display === 'primary') continue;
    const found =
      displays.find((d) => String(d.id) === section.display) || matchHint(section.displayHint, displays);
    if (!found) continue;
    const id = String(found.id);
    const hint = hintOf(found);
    if (id === section.display && JSON.stringify(hint) === JSON.stringify(section.displayHint)) continue;
    next = { ...next, [key]: { ...section, display: id, displayHint: hint } };
  }
  return next;
}

const SCALE = {
  compact: { width: 300, height: 250 },
  standard: { width: 384, height: 340 },
  large: { width: 480, height: 430 },
};
const MARGIN = 22;

/** Bounds for one anchor's window: its corner of the chosen display's work
 *  area (never over the taskbar), at the scale's width and the rendered height. */
function hudBounds(prefs, renderedHeight, displays, anchor = 'top-right') {
  const d = resolveDisplay(prefs.hud.display, displays, prefs.hud.displayHint);
  if (!d) return { x: 0, y: 0, width: 300, height: 120 };
  const wa = d.workArea;
  const size = SCALE[prefs.hud.scale] || SCALE.standard;
  const width = Math.max(180, Math.min(size.width, wa.width - MARGIN * 2));
  const height = Math.max(
    40,
    Math.min(Math.round(renderedHeight || size.height), Math.max(120, wa.height - MARGIN * 2)),
  );
  const right = anchor.endsWith('right');
  const bottom = anchor.startsWith('bottom');
  return {
    x: Math.round(right ? wa.x + wa.width - width - MARGIN : wa.x + MARGIN),
    y: Math.round(bottom ? wa.y + wa.height - height - MARGIN : wa.y + MARGIN),
    width,
    height,
  };
}

/** Which corner of the HUD's display a screen point is nearest — the drop
 *  target while a bubble is dragged in arrange mode. */
function nearestAnchor(prefs, point, displays) {
  const d = resolveDisplay(prefs.hud.display, displays, prefs.hud.displayHint);
  if (!d) return null;
  const wa = d.workArea;
  const right = point.x >= wa.x + wa.width / 2;
  const bottom = point.y >= wa.y + wa.height / 2;
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`;
}

module.exports = {
  init,
  defaults,
  normalise,
  read,
  write,
  reset,
  resolveDisplay,
  syncDisplayHints,
  hudBounds,
  nearestAnchor,
  activeAnchors,
  isPrivate,
  applyArrange,
  ANCHORS,
  SCALE,
  WIDGET_DEFAULTS,
  registerWidgetDefaults,
  registerPresentationExtension,
  MAX_BUBBLES,
  EXTRAS,
  BACKDROPS,
};
