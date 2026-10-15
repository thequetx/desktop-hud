// Design screenshot harness. Run under Electron after a build:
//   npm run build && npx electron scripts/design-shots.mjs [before|after]
//
// Why this exists: the HUD editor and the bubbles are visual work, and a
// passing typecheck says nothing about whether a form reads calmly or a bubble
// survives a busy wallpaper. This renders the built pages the way smoke.mjs
// does (loadFile + the real preload, stubbed IPC, hidden windows, and — like
// smoke — no single-instance lock, so it runs beside the installed app) and
// saves PNGs to design-shots/<label>/ for looking at.
//
// The clock is frozen: every shot is taken at Monday 10:00 (local) of the
// current week, in the harness *and* in the pages (a Date shim injected over
// CDP before any app script runs — see shimFor). Without it a run in
// a stream slot hid the stream-hidden bubbles, and rows shifted between runs.
// The app itself has no hook for this; only this harness moves its clock.
// Fixture data is built from that "now", so "Next up" always has an imminent
// row (the crimson escalation) and placed tasks are in the future.
//
// Labels:
//   before         the defaults (every extra off). With --dist=<folder> it
//                  renders an older build, e.g. a copy of dist/ from master.
//   after          every extra on, the Today radar in the top-right corner,
//                  and the special-time shots below
//   after-default  the new build with every extra off: must match `before`
//
// Special-time shots each freeze their own clock (open(..., { at })): Sunday
// 19:00 for the debrief, 00:40 for night and the cat, a stream day at 18:20
// (and 20:28, 20:50) for the countdown. `--only=settings,hud,surfaces,special`
// runs a subset (also np, cat, hover — the hover fade, see hoverShots — and
// watcher: the HUD cat at 1:1 in every corner,
// scale and state, its ripple frozen at set phases).
//
// Phase 9.5 adds three groups:
//   setup     the first-run wizard step by step, and Display & HUD →
//             Integrations (healthy, needing a fix, a new profile)
//   empty     a new profile's HUD under each preset, with nothing connected
//   contrast  the bubbles at each backdrop over four wallpapers (white, black,
//             mid-grey, a procedurally drawn photo), and the idle overlay over
//             the same four: every line of text measured against the pixels
//             behind it. Writes contrast.md and contrast.json beside the PNGs.
//             Shoot an older build with --dist for its numbers.

import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Errors print and exit; the harness must never open a dialog on the desktop.
process.on('uncaughtException', (e) => {
  console.error('design-shots crashed:', e);
  process.exit(1);
});
dialog.showErrorBox = (title, body) => console.error(`${title}: ${body}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ARG = (process.argv.find((x) => x.startsWith('--dist=')) ?? '').split('=')[1];
const DIST = DIST_ARG ? path.resolve(ROOT, DIST_ARG) : path.join(ROOT, 'dist');
const ONLY = ((process.argv.find((x) => x.startsWith('--only=')) ?? '').split('=')[1] ?? '').split(',').filter(Boolean);
const runs = (group) => ONLY.length === 0 || ONLY.includes(group);
const PRELOAD = path.join(ROOT, 'electron', 'preload.cjs');
// `--opacity=N` renders with the HUD background setting at N% (0–95) into
// `after-opacity-N/`, to check legibility at the ends of the slider.
const OPACITY = (process.argv.find((x) => x.startsWith('--opacity=')) ?? '').split('=')[1];
const MODE = process.argv.find((a) => a === 'before' || a === 'after' || a === 'after-default') ?? 'after';
/** `after`: every extra on. `before` / `after-default`: the shipped defaults. */
// `--extras` turns every extra on for a before / after-default run too (into
// `<label>-extras/`), e.g. to shoot an older build with its extras on.
const EXTRAS_FLAG = process.argv.includes('--extras');
const EXTRAS_ON = MODE === 'after' || EXTRAS_FLAG;
const LABEL = MODE + (EXTRAS_FLAG && MODE !== 'after' ? '-extras' : '') + (OPACITY ? `-opacity-${OPACITY}` : '');
const OUT = path.join(ROOT, 'design-shots', LABEL);
mkdirSync(OUT, { recursive: true });
// The pages load over app://hud/, as the app loads them (Phase 9.4). A blank
// page on the same origin keeps the frozen clock script across the load.
const appProtocol = createRequire(import.meta.url)('../electron/appprotocol.cjs');
appProtocol.registerScheme(protocol);
const BLANK = '/__design-shots-blank.html';

// Keep Chromium's profile away from the real app's %APPDATA% folder.
app.setPath('userData', path.join(os.tmpdir(), 'wd-design-shots'));

// ---- fixtures -------------------------------------------------------------------

const now = (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  d.setHours(10, 0, 0, 0);
  return d;
})();
/** Runs in each page before its scripts: Date starts at the frozen time and
 *  ticks on from there. new Date(x), Date.parse and Date.UTC are untouched.
 *  `__wdShiftClock(ms)` moves the page's clock on (the cat shot). */
const shimFor = (at = now) => `(() => {
  const R = Date;
  let off = ${at.getTime()} - R.now();
  globalThis.__wdShiftClock = (ms) => { off += ms; };
  function D(...a) {
    if (!new.target) return new R(R.now() + off).toString();
    return a.length ? new R(...a) : new R(R.now() + off);
  }
  D.prototype = R.prototype;
  D.now = () => R.now() + off;
  D.parse = R.parse;
  D.UTC = R.UTC;
  globalThis.Date = D;
})();`;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plus = (min) => new Date(now.getTime() + min * 60_000);
/** A time on day `day` (0 = Monday) of the frozen week. */
const weekAt = (day, h, m = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + day);
  d.setHours(h, m, 0, 0);
  return d;
};
const roundTo = (d, m) => new Date(Math.ceil(d.getTime() / (m * 60_000)) * m * 60_000);
const today = iso(now);
const tomorrow = iso(plus(24 * 60));

const builtin = (id, anchor, enabled = true, hideDuring = []) => ({
  id,
  type: 'builtin',
  enabled,
  anchor,
  title: '',
  rows: null,
  show: { hideDuring, onlyDuring: [], days: [], hours: null, inFocus: null },
  source: {},
});
const show = (patch = {}) => ({ hideDuring: [], onlyDuring: [], days: [], hours: null, inFocus: null, ...patch });

const PRESENTATION = {
  v: 3,
  ambient: { enabled: true, idleSeconds: 180, display: 'primary' },
  hud: {
    display: 'primary',
    scale: 'standard',
    upcomingRows: 4,
    privateAnchors: ['bottom-left'],
    bubbles: [
      builtin('clock', 'top-right'),
      ...(EXTRAS_ON ? [builtin('radar', 'top-right')] : []),
      builtin('upcoming', 'top-right'),
      builtin('placed', 'top-right'),
      builtin('weekstrip', 'top-right'),
      builtin('intention', 'top-left'),
      builtin('health', 'top-left'),
      builtin('streaks', 'top-left'),
      builtin('daily', 'bottom-left', true, ['stream']),
      builtin('art', 'bottom-left', true, ['stream']),
      builtin('meal', 'bottom-left', true, ['stream']),
      builtin('backlog', 'top-left', false),
      {
        id: 'b-hq',
        type: 'note',
        enabled: true,
        anchor: 'bottom-right',
        title: 'Side Project',
        rows: 4,
        show: show({ hideDuring: ['stream'], days: [0, 1, 2, 3, 4] }),
        source: { path: 'Projects/Dashboard', heading: 'Now', items: 'open' },
      },
      {
        id: 'b-due',
        type: 'tasks',
        enabled: true,
        anchor: 'bottom-right',
        title: 'Due soon',
        rows: null,
        show: show(),
        source: { folder: '', tag: '', due: 'week', priority: 'any', includeDone: false },
      },
      {
        id: 'b-wk',
        type: 'fields',
        enabled: true,
        anchor: 'bottom-right',
        title: 'This week',
        rows: null,
        show: show(),
        source: { path: 'Weekly/{week}', keys: ['status', 'focus'] },
      },
      {
        id: 'b-txt',
        type: 'text',
        enabled: true,
        anchor: 'bottom-right',
        title: '',
        rows: null,
        // A rule that is false right now, so arrange mode shows a dimmed bubble.
        show: show({ onlyDuring: ['gym'] }),
        source: { text: 'Ship small. Close the loop before opening a new one.' },
      },
      // The shipped default (fit width, its own 85% background), minus its
      // hide-during-stream rule: the fixture's stream runs Mon/Tue/Thu/Fri
      // evenings, and a shot must not depend on the hour it was taken.
      { ...builtin('nowplaying', 'bottom-right'), width: 'fit', bgOpacity: 85 },
    ],
  },
};
if (OPACITY) PRESENTATION.hud.bgOpacity = Number(OPACITY);
// The default runs leave `extras` out altogether: a file from before they
// existed, which must draw exactly as it did.
if (EXTRAS_ON) {
  PRESENTATION.extras = {
    streakLevels: true,
    bossBar: true,
    objectiveComplete: true,
    dayNight: true,
    debrief: true,
    // Split into catHud + catIdle (2026-09-25); the old key too, so an older
    // build (--dist) reads its one switch.
    lonelyCat: true,
    catHud: true,
    catIdle: true,
    // Renamed upNext (2026-09-24); both, so an older build reads its switch.
    radioLog: true,
    upNext: true,
  };
}

// Past the 90-minute window in which a calendar event would cover the
// imminent skeleton block below.
const soon = roundTo(plus(100), 15);
const later = roundTo(plus(210), 30);
const EVENTS = [
  { uid: 'e1', title: 'Call with Sam — thumbnail review', start: soon, end: new Date(soon.getTime() + 45 * 60_000) },
  { uid: 'e2', title: 'Edit VOD highlights', start: later, end: new Date(later.getTime() + 90 * 60_000) },
  { uid: 'e3', title: 'Dentist', start: new Date(`${tomorrow}T10:30:00`), end: new Date(`${tomorrow}T11:15:00`) },
].map((e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString(), allDay: false }));

const calEvent = (uid, title, start, mins) => ({
  uid,
  title,
  start: start.toISOString(),
  end: new Date(start.getTime() + mins * 60_000).toISOString(),
  allDay: false,
});
/** The skeleton's gym (Mon–Fri 06:00) and stream (Mon/Tue/Thu/Fri 18:30),
 *  kept on the given days of week `w` (0 = this week, -1 = last week…). */
const gymWeek = (w, days = [0, 1, 2, 3, 4]) =>
  days.map((d) => calEvent(`gym${w}${d}`, 'Gym', weekAt(w * 7 + d, 6), 60));
const streamWeek = (w, days = [0, 1, 3, 4]) =>
  days.map((d) => calEvent(`str${w}${d}`, 'Twitch Stream', weekAt(w * 7 + d, 18, 30), 180));
// Extras run: gym kept Tue–Fri this week (4/5, so a Monday session can land
// later and hit the target), and history for the levels — gym on target the
// last three weeks (LV 3), the stream last week only (LV 1).
const THIS_WEEK_EXTRA = EXTRAS_ON ? gymWeek(0, [1, 2, 3, 4]) : [];
const HISTORY = EXTRAS_ON
  ? [...gymWeek(-1), ...gymWeek(-2), ...gymWeek(-3), ...gymWeek(-4, [0, 1, 2]), ...streamWeek(-1), ...streamWeek(-2, [0, 1])]
  : [];

const placedAt = roundTo(plus(150), 30);
const placedEnd = new Date(placedAt.getTime() + 60 * 60_000);
const WEEK_BASE = {
  weekId: 'fixture',
  notePath: 'Weekly/2026-W39.md',
  weeklyDir: 'Weekly',
  vaultName: 'quetx',
  intentions: [
    { text: 'Ship the HUD editor redesign ⏫', done: false, file: 'w.md', line: 3 },
    { text: 'Three streams, on time', done: true, file: 'w.md', line: 4 },
    { text: 'Art: one still life a day', done: false, file: 'w.md', line: 5 },
  ],
  tasks: [
    { text: `${hm(placedAt)} - ${hm(placedEnd)} Draft the Side Project level brief ⏫ ⏳ ${iso(placedAt)}`, done: false, file: 'w.md', line: 9 },
    { text: `21:00 - 22:00 Queue next week's thumbnails ⏳ ${tomorrow}`, done: false, file: 'w.md', line: 10 },
    { text: 'Tidy the vault inbox', done: false, file: 'w.md', line: 11 },
  ],
  thisweek: [],
};

const WIDGETS = {
  daily: {
    file: `Daily/${today}.md`,
    exists: true,
    goals: [
      { text: 'Build the narrow day view ~4h ⏫', done: false },
      { text: 'Decide the narrow breakpoint 🔺', done: true },
      { text: 'Stretch before stream', done: false },
    ],
    energy: 6,
    motivation: 7,
  },
  art: {
    label: 'Week 02 — Build objects from simple shapes',
    file: 'Art/Week 02/Weekly Plan.md',
    goal: 'See objects as boxes, cylinders, and spheres.',
    minimum: 'One 30-minute still life built from simple forms.',
  },
  custom: {
    'b-hq': {
      exists: true,
      file: 'Projects/Dashboard.md',
      found: true,
      items: [
        { kind: 'task', text: 'Block out the cave level greybox 🔼', done: false },
        { kind: 'task', text: 'Playtest the dash cooldown', done: false },
        { kind: 'task', text: 'Write the lantern pickup description', done: false },
        { kind: 'task', text: 'Export build for Sam', done: false },
        { kind: 'task', text: 'Fix the ledge-grab jitter', done: false },
      ],
    },
    'b-due': {
      total: 3,
      items: [
        { text: 'Renew domain ⏫', done: false, file: 'a.md', line: 1, due: today },
        { text: 'Send invoice to Mia', done: false, file: 'b.md', line: 2, due: tomorrow },
        { text: 'Back up the stream PC 🔼', done: false, file: 'c.md', line: 3, due: '2026-01-01' },
      ],
    },
    'b-wk': {
      exists: true,
      file: 'Weekly/2026-W39.md',
      fields: [
        { key: 'status', value: 'on track' },
        { key: 'focus', value: 'HUD polish, level brief' },
      ],
    },
  },
};

// Private add-ons (Phase 9.3) exist only in the owner's build, where
// electron/addons-private and src/addons-private link to the private repo.
// Without them the art and meal bubbles don't exist, and the meal shots are skipped.
const HAS_ADDONS = existsSync(path.join(ROOT, 'electron', 'addons-private', 'index.cjs'));
// The Meal bubble's data: Codex's real W42 design sample, through the add-on's own
// parser. Absent from WIDGETS unless a meal shot sets it, so the other shots are unchanged.
// The Lonely Cat is a private add-on too. The shots below still set its options
// through the old core fields; withCat() turns those into the add-on's
// presentation section with the add-on's own migration (main/cat.cjs).
const CAT_ADDON = HAS_ADDONS ? createRequire(import.meta.url)(path.join(ROOT, 'electron', 'addons-private', 'cat.cjs')) : null;
const withCat = (p) => (CAT_ADDON ? { ...p, addons: { ...(p.addons || {}), cat: CAT_ADDON.normalise(undefined, p) } } : p);
let MEAL_SAMPLE = null;
let MEAL_W41 = null;
let MEAL_W42 = null;
if (HAS_ADDONS) {
  const { parseMealFeed } = createRequire(import.meta.url)(path.join(ROOT, 'electron', 'addons-private', 'meal.cjs'));
  const fixture = (name) => readFileSync(path.join(ROOT, 'src', 'addons-private', 'fixtures', name), 'utf8');
  MEAL_SAMPLE = parseMealFeed(fixture('meal-feed-w42.design-sample.json'), { preview: true });
  MEAL_W41 = parseMealFeed(fixture('meal-feed-w41.bridge.json'));
  MEAL_W42 = parseMealFeed(fixture('meal-feed-w42.production.json'));
}

const NOTES = [
  'Projects/Dashboard.md',
  'Projects/Level Ideas.md',
  'Weekly/2026-W39.md',
  `Daily/${today}.md`,
  'Art/Week 02/Weekly Plan.md',
  'Backlog.md',
];

// The full example skeleton (test fixture), plus one block starting in a few minutes so Next up
// shows its crimson escalation row.
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const blockAt = roundTo(plus(8), 1);
const SKELETON_YAML = readFileSync(path.join(ROOT, 'test', 'fixtures', 'week-skeleton.full.yaml'), 'utf8').replace(
  /blocks:\r?\n/,
  `blocks:\n  - name: Stretch + warm-up\n    kind: stretch\n    days: [${DAY_KEYS[(now.getDay() + 6) % 7]}]\n` +
    `    start: "${hm(blockAt)}"\n    end: "${hm(roundTo(plus(30), 1))}"\n\n`,
);

// A small album-art stand-in: a data URI, so nothing is fetched.
const COVER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#e0533d"/><stop offset="1" stop-color="#5a1420"/></linearGradient></defs>' +
      '<rect width="64" height="64" fill="url(#g)"/><circle cx="40" cy="24" r="10" fill="#f6c667"/></svg>',
  );
/** A flat stand-in cover in one of two colours. */
const coverOf = (a, b) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${a}"/><path d="M0 64L64 0v64z" fill="${b}"/></svg>`,
  );
/** Songify's queue, as parseQueue hands it on: the two songs after this one. */
const QUEUE = [
  { title: 'Nights', artist: 'Frank Ocean', cover: coverOf('#2c4a6e', '#d9a441'), length: '5:07', requester: null },
  { title: 'Redbone', artist: 'Childish Gambino', cover: coverOf('#7a2e1f', '#e6c07b'), length: '5:26', requester: null },
];
const NOW_PLAYING = {
  playing: true,
  title: 'Mural',
  artist: 'Lupe Fiasco',
  cover: COVER,
  progressMs: 96_000,
  totalMs: 240_000,
  accent: '#d0452f',
  queue: QUEUE,
};

// Mutable: the surface shots switch focus, Now playing, the week and the
// calendar as they go.
const state = {
  arrange: { on: false, canUndo: false },
  focus: null,
  nowPlaying: null,
  week: WEEK_BASE,
  events: [...EVENTS, ...THIS_WEEK_EXTRA],
  /** A per-shot presentation; null = the fixture above. */
  presentation: null,
  // Phase 9.5 — set-up state for the wizard, Integrations and empty-state shots;
  // null = the fixtures in STUBS below.
  sources: null,
  notesStatus: null,
  notesSettings: null,
  folderPick: null,
  skeletonYaml: null,
  widgets: null,
  /** The add-on Google account; the public build has none (set per shot). */
  google: null,
};

const STUBS = {
  'vault:read-week': () => state.week,
  'vault:read-backlog': () => ({ ok: true, items: [] }),
  'vault:append-backlog': () => ({ ok: false }),
  'capture:hide': () => true,
  'focus:get': () => state.focus,
  'hud:imminent': () => ({ ok: true, shown: false }),
  'skeleton:read': () => ({ ok: true, yaml: state.skeletonYaml ?? SKELETON_YAML }),
  'presentation:read': () => withCat(structuredClone(state.presentation ?? PRESENTATION)),
  'widgets:notes': () => NOTES,
  'widgets:describe': (_e, req) => ({
    exists: true,
    file: String(req?.path ?? '')
      .replace('{today}', today)
      .replace('{week}', '2026-W39')
      .replace(/(\.md)?$/, '.md'),
    headings: ['Now', 'Next', 'Later', 'Notes'],
    keys: ['status', 'focus', 'energy', 'tags'],
  }),
  'presentation:preview': () => ({ ok: true }),
  'presentation:revert': () => ({ ok: true }),
  'hud:arrange-set': () => false,
  'hud:arrange-get': () => state.arrange,
  'hud:arrange-action': () => ({ ok: true }),
  'widgets:read': () => state.widgets ?? WIDGETS,
  'presentation:displays': () => [
    { id: 'primary-id', label: 'Display 1 — 2560×1440 (primary)', primary: true },
    { id: 'side', label: 'Display 2 — 1920×1080', primary: false },
  ],
  'presentation:write': () => ({ ok: true }),
  'presentation:reset': () => ({ ok: true }),
  'presentation:preview-ambient': () => ({ ok: true }),
  'presentation:end-preview': () => ({ ok: true }),
  'google:status': () => state.google ?? { configured: true, connected: true, email: 'fixture@example.com' },
  'google:connect': () => ({ ok: false }),
  'google:disconnect': () => undefined,
  // Served by range, like the real events slot: the HUD's week window, or
  // the wider past range the streak levels read.
  'events:list': (_e, range) => {
    const from = range?.timeMin ? Date.parse(range.timeMin) : -Infinity;
    const to = range?.timeMax ? Date.parse(range.timeMax) : Infinity;
    const events = [...state.events, ...HISTORY].filter((e) => {
      const t = Date.parse(e.start);
      return Date.parse(e.end) > from && t < to;
    });
    return { ok: true, events };
  },
  'cal:status': () => ({ lastSyncAt: now.getTime() - 60_000, lastError: null, tokenGone: false, syncing: false, count: 3, synced: true }),
  'nowplaying:get': () => state.nowPlaying,
  // No Side Project bot feed: the bubble's empty state (the real reader returns null).
  // Private add-on data (Phase 9.3): the art and meal bubbles read through their add-ons.
  'addon:call': (_e, id, name) =>
    (id === 'art' && name === 'current' ? WIDGETS.art : id === 'meal' && name === 'feeds' ? WIDGETS.meal : null) ?? null,
  'notes:set-write': () => ({ ok: false }),
  'data:diagnostics': () => ({ ok: false, canceled: true }),
  'data:export': () => ({ ok: false, canceled: true }),
  'data:remove-all': () => ({ ok: false, canceled: true }),
  'onboarding:status': () => ({ done: true, notes: 'folder', calendars: 1 }),
  'onboarding:finish': () => ({ ok: true }),
  'notes:choose-folder': () => state.folderPick ?? { ok: false, canceled: true },
  'notes:settings': () =>
    state.notesSettings ?? { kind: 'folder', name: 'Notes', weeklyDir: 'Weekly', dailyDir: 'Daily', backlogPath: 'Backlog.md', taskTag: '#thisweek', taskFolders: '', write: true },
  'notes:apply': () => ({ ok: true, restart: true }),
  'nowplaying:settings': () => ({ player: '' }),
  'nowplaying:set-player': () => ({ ok: false }),
  'app:restart': () => ({ ok: true }),
  'events:add-link': () => ({ ok: false }),
  'events:add-file': () => ({ ok: false, canceled: true }),
  'events:remove': () => ({ ok: true }),
  'events:rename': () => ({ ok: true }),
  'events:refresh': () => ({ ok: true }),
  'skeleton:write': () => ({ ok: true }),
  'notes:status': () => state.notesStatus ?? { kind: 'folder', name: 'Notes', ready: true, canWrite: true, backlog: 'Backlog.md', weekly: 'Weekly' },
  'events:sources': () =>
    state.sources ?? [
      { id: 'cal1', kind: 'ics-url', name: 'Calendar', configured: true, fetchedAt: now.getTime() - 120_000, lastError: null, warning: null, count: 3 },
    ],
};

/** A console message as { severe, text }, from either Electron's old
 *  positional arguments (level 0-3) or the event object (Electron 35+, where
 *  `level` is 'info' | 'warning' | 'error' | 'debug'). */
function consoleMessage(e, level, message) {
  const lvl = e && typeof e.level === 'string' ? e.level : level;
  const text = String((e && typeof e.message === 'string' ? e.message : message) ?? '');
  const severe = lvl === 'warning' || lvl === 'error' || (typeof lvl === 'number' && lvl >= 2);
  return { severe, text };
}

function stubBridge() {
  const src = readFileSync(PRELOAD, 'utf8');
  for (const m of src.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) {
    const ch = m[1];
    if (!STUBS[ch]) throw new Error(`design-shots: no stub for ${ch}`);
    try {
      ipcMain.handle(ch, STUBS[ch]);
    } catch {
      /* registered twice in preload — fine */
    }
  }
  // The HUD reports its rendered height; size the window to it like main does.
  ipcMain.on('hud:resize', (e, h) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) win.setContentSize(win.getContentSize()[0], Math.max(40, Math.ceil(h)));
  });
}

// ---- helpers ---------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(page, { width, height, query, transparent = false, at }) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#080c18',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.on('console-message', (e, level, msg) => {
    const { severe, text } = consoleMessage(e, level, msg);
    if (severe && !text.includes('Electron Security Warning')) console.log(`  [${page}] ${text.slice(0, 200)}`);
  });
  // Freeze the page's clock before its scripts run. CDP needs a renderer, and
  // a fresh window has none until it navigates, so blank it first — with a
  // page on the app's own origin, so the real page loads in the same renderer
  // and keeps the registered script (about:blank → app:// swaps processes).
  await win.loadURL(`${appProtocol.ORIGIN}${BLANK}`);
  win.webContents.debugger.attach();
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: shimFor(at) });
  await win.loadURL(appProtocol.pageUrl(page, query));
  for (let i = 0; i < 100; i++) {
    const len = await win.webContents.executeJavaScript("document.getElementById('root')?.innerHTML.length ?? 0");
    if (len > 300) break;
    await sleep(100);
  }
  await sleep(900);
  return win;
}

async function shot(win, name, rect) {
  const img = await win.webContents.capturePage(rect, { stayHidden: true });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, img.toPNG());
  console.log(`  saved ${path.relative(ROOT, file)}  ${img.getSize().width}×${img.getSize().height}`);
  return img;
}

const js = (win, code) => win.webContents.executeJavaScript(code);
const clickText = (win, sel, text) =>
  js(win, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().includes(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);

// ---- the Display & HUD window ---------------------------------------------------------
//
// index.html is the settings window since the planner was archived; the main
// process aims it with `presentation:open`, as it does here.

async function settingsShots() {
  const targets = [
    ['editor-builtin', { bubbleId: 'upcoming' }],
    ['editor-note', { bubbleId: 'b-hq' }],
    ['editor-tasks', { bubbleId: 'b-due' }],
    ['editor-templates', { newAt: 'top-right' }],
    ['editor-screens', { bubbleId: 'clock' }],
  ];
  for (const [name, target] of targets) {
    const win = await open('index.html', { width: 1240, height: 820 });
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      win.webContents.send('presentation:open', target);
      await sleep(300);
      opened = await js(win, "!!document.querySelector('.modal--window')");
    }
    if (!opened) console.log('  !! editor did not open for', name);
    await sleep(900);
    if (name === 'editor-screens') {
      await clickText(win, '.pres__tabs button, [role=tab]', 'Screens');
      await sleep(400);
    }
    await shot(win, name);
    if (name === 'editor-screens') {
      await js(win, "document.querySelector('.pres__body')?.scrollTo(0, 99999)");
      await sleep(300);
      await shot(win, 'editor-screens-scrolled');
    }
    if (name === 'editor-builtin') {
      // Keyboard focus must be visible: tab into the form a few stops.
      // Offscreen pages never have OS focus, so :focus-visible never matches;
      // CDP's focus emulation makes the page behave as if its window had it.
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await js(win, "document.querySelector('.bub-ed__form input')?.focus()");
      for (let i = 0; i < 3; i++) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await sleep(80);
      }
      await sleep(300);
      console.log('  focus on:', await js(win, "(() => { const a = document.activeElement; return a ? a.outerHTML.slice(0, 90) + ' fv=' + a.matches(':focus-visible') + ' hasFocus=' + document.hasFocus() : 'none'; })()"));
      await shot(win, 'editor-focus');
    }
    if (name === 'editor-builtin' || name === 'editor-note' || name === 'editor-tasks') {
      // Scroll the form so the rules and footer controls are seen too.
      await js(win, "document.querySelector('.bub-ed__form')?.scrollTo(0, 99999)");
      await sleep(300);
      await shot(win, `${name}-scrolled`);
    }
    win.destroy();
  }
}

// ---- HUD over a busy desktop ----------------------------------------------------------

const DESK_W = 1920;
const DESK_H = 1080;
const MARGIN = 22;
const HUD_W = 384;

async function hudCorners(arranging, at) {
  state.arrange = { on: arranging, canUndo: arranging };
  const out = {};
  for (const anchor of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor }, transparent: true, at });
    if (arranging && anchor === 'bottom-right') {
      // Show the drop-target state and the + Add list in one corner.
      win.webContents.send('hud:arrange-target', 'bottom-right');
      await clickText(win, '.arr__foot button', 'Add');
    }
    await sleep(700);
    const img = await win.webContents.capturePage(undefined, { stayHidden: true });
    out[anchor] = { png: img.toPNG().toString('base64'), ...img.getSize() };
    win.destroy();
  }
  return out;
}

/** A dark, busy, harness-only desktop: a night wallpaper with a warm window
 *  glow, stars, and two app windows (one light-ish, the worst case for a
 *  translucent card) under the corners. */
function deskHtml(corners) {
  const place = (a, c) => {
    const [v, h] = a.split('-');
    return `<img src="data:image/png;base64,${c.png}" style="position:absolute;${v}:${MARGIN}px;${h}:${MARGIN}px;width:${c.width}px;height:${c.height}px">`;
  };
  const code = Array.from({ length: 34 }, (_, i) => {
    const w = 20 + ((i * 37) % 60);
    const col = ['#7aa2f7', '#c3e88d', '#f78c6c', '#89ddff', '#c792ea', '#a6accd'][i % 6];
    return `<div style="height:9px;margin:7px 0 0 ${(i % 5) * 18}px;width:${w}%;background:${col};opacity:.55;border-radius:2px"></div>`;
  }).join('');
  const stars = Array.from({ length: 90 }, (_, i) => {
    const x = (i * 173) % DESK_W;
    const y = (i * 97) % (DESK_H * 0.6);
    return `<i style="position:absolute;left:${x}px;top:${y}px;width:2px;height:2px;border-radius:50%;background:#fff;opacity:${0.25 + (i % 4) * 0.18}"></i>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;width:${DESK_W}px;height:${DESK_H}px;position:relative;overflow:hidden;
    background: radial-gradient(40% 35% at 78% 62%, rgba(255,170,90,.55), transparent 70%),
      radial-gradient(60% 50% at 20% 90%, #3a2a5e, transparent 70%),
      linear-gradient(180deg,#0b1633 0%,#1d2a55 45%,#3b3561 75%,#1b1830 100%)">
    ${stars}
    <div style="position:absolute;left:260px;top:150px;width:900px;height:640px;background:#1e1f29;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6);padding:40px 30px">${code}</div>
    <div style="position:absolute;left:${DESK_W - 520}px;top:60px;width:560px;height:420px;background:#d9dde6;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6);padding:20px">
      <div style="height:28px;background:#b9c1d0;border-radius:4px"></div>
      <div style="margin-top:18px;height:120px;background:linear-gradient(90deg,#e86a5a,#f2b84b)"></div>
      <div style="margin-top:16px;height:10px;width:80%;background:#666"></div><div style="margin-top:8px;height:10px;width:60%;background:#888"></div>
      <div style="margin-top:8px;height:10px;width:70%;background:#888"></div>
    </div>
    <div style="position:absolute;left:-40px;top:${DESK_H - 420}px;width:420px;height:400px;background:#252a36;border-radius:8px;padding:24px">${code}</div>
    <div style="position:absolute;left:${DESK_W - 400}px;top:${DESK_H - 520}px;width:480px;height:420px;background:#12151c;border-radius:8px;padding:24px">${code}</div>
    ${Object.entries(corners).map(([a, c]) => place(a, c)).join('')}
  </body></html>`;
}

async function hudShots(runs = [[false, 'hud'], [true, 'hud-arrange']], at) {
  for (const [arranging, name] of runs) {
    const corners = await hudCorners(arranging, at);
    const file = path.join(os.tmpdir(), `wd-desk-${name}.html`);
    writeFileSync(file, deskHtml(corners));
    const win = new BrowserWindow({ width: DESK_W, height: DESK_H, show: false, frame: false, webPreferences: { offscreen: true } });
    await win.loadFile(file);
    await sleep(500);
    await shot(win, `${name}-desktop`);
    // 1:1 crops of each corner so the type can actually be read.
    const cw = HUD_W + MARGIN * 2;
    const ch = DESK_H / 2;
    await shot(win, `${name}-top-left`, { x: 0, y: 0, width: cw, height: ch });
    await shot(win, `${name}-top-right`, { x: DESK_W - cw, y: 0, width: cw, height: ch });
    await shot(win, `${name}-bottom-left`, { x: 0, y: DESK_H - ch, width: cw, height: ch });
    await shot(win, `${name}-bottom-right`, { x: DESK_W - cw, y: DESK_H - ch, width: cw, height: ch });
    win.destroy();
  }
}

// ---- the Meal bubble, at the times Codex's sample README suggests ----------------------

const MEAL_TIMES = [
  ['mon-0800-oats', '2026-10-12T08:00:00+11:00'],
  ['mon-1600-dinner-batch', '2026-10-12T16:00:00+11:00'],
  ['tue-1200-leftover-lunch', '2026-10-13T12:00:00+11:00'],
  ['thu-0900-thaw-due-today', '2026-10-15T09:00:00+11:00'],
  ['thu-1800-dinner-thaw-past', '2026-10-15T18:00:00+11:00'],
  ['thu-2130-rolled-tomorrow', '2026-10-15T21:30:00+11:00'],
  ['fri-1600-fish-dinner', '2026-10-16T16:00:00+11:00'],
  ['sun-1400-marinade-due', '2026-10-18T14:00:00+11:00'],
  ['sun-1600-marinade-past', '2026-10-18T16:00:00+11:00'],
  ['sun-2115-unpublished', '2026-10-18T21:15:00+11:00'],
];

// The approved W41 bridge plus the production W42 feed, as the installed app would read them
// in normal use (no preview tag): [name, moment].
const MEAL_W41_TIMES = [
  ['w41-thu-2130-rolled-to-friday', '2026-10-08T21:30:00+11:00'],
  ['w41-fri-1200-lunch-not-recorded', '2026-10-09T12:00:00+11:00'],
  ['w41-fri-1600-dinner', '2026-10-09T16:00:00+11:00'],
  ['w41-sun-2115-into-w42', '2026-10-11T21:15:00+11:00'],
];

async function mealShots() {
  state.arrange = { on: false, canUndo: false };
  for (const [name, at] of MEAL_TIMES) {
    WIDGETS.meal = { feeds: [MEAL_SAMPLE], preview: { now: at } };
    const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor: 'bottom-left' }, transparent: true });
    await sleep(700);
    await onWallpaper(`meal-${name}`, await win.webContents.capturePage(undefined, { stayHidden: true }));
    win.destroy();
  }
  for (const [name, at] of MEAL_W41_TIMES) {
    WIDGETS.meal = { feeds: [MEAL_W41, MEAL_W42], preview: null };
    // Normal use has no stand-in clock, so the page's own clock is moved to the moment.
    const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor: 'bottom-left' }, transparent: true, at: new Date(at) });
    await sleep(700);
    await onWallpaper(`meal-${name}`, await win.webContents.capturePage(undefined, { stayHidden: true }));
    win.destroy();
  }
  delete WIDGETS.meal;
}

// ---- the other surfaces, over the wallpaper -------------------------------------------

/** The harness desktop's wallpaper alone, no app windows — what the ambient
 *  overlay and a lone corner really sit on. */
function wallpaperCss() {
  return `background: radial-gradient(40% 35% at 78% 62%, rgba(255,170,90,.55), transparent 70%),
      radial-gradient(60% 50% at 20% 90%, #3a2a5e, transparent 70%),
      linear-gradient(180deg,#0b1633 0%,#1d2a55 45%,#3b3561 75%,#1b1830 100%)`;
}

/** Composite one transparent capture onto the wallpaper and save it. */
async function onWallpaper(name, img, pad = MARGIN) {
  const { width, height } = img.getSize();
  const w = width + pad * 2;
  const h = height + pad * 2;
  const file = path.join(os.tmpdir(), `wd-wall-${name}.html`);
  writeFileSync(
    file,
    `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;${wallpaperCss()}">` +
      `<img src="data:image/png;base64,${img.toPNG().toString('base64')}" style="position:absolute;left:${pad}px;top:${pad}px;width:${width}px;height:${height}px"></body></html>`,
  );
  const win = new BrowserWindow({ width: w, height: h, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await sleep(300);
  await shot(win, name);
  win.destroy();
}

async function capture(win) {
  return win.webContents.capturePage(undefined, { stayHidden: true });
}

async function surfaceShots() {
  state.arrange = { on: false, canUndo: false };

  // Ambient: full-screen, transparent, over the wallpaper.
  let win = await open('ambient.html', { width: DESK_W, height: DESK_H, transparent: true });
  await onWallpaper('ambient', await capture(win), 0);
  win.destroy();

  // Quick capture.
  win = await open('capture.html', { width: 520, height: 128, transparent: true });
  await onWallpaper('capture', await capture(win));
  win.destroy();

  // Focus mode: Next up turns into the countdown.
  const st = new Date(now.getTime() - 20 * 60_000);
  const en = new Date(now.getTime() + 40 * 60_000);
  state.focus = { uid: 'e1', title: 'Draft the Side Project level brief', start: st.toISOString(), end: en.toISOString() };
  win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor: 'top-right' }, transparent: true });
  await sleep(700);
  await onWallpaper('hud-focus', await capture(win));
  win.destroy();
  state.focus = null;

  // Now playing: playing, then paused (the same track, seen playing first —
  // the HUD only dims a track it saw play this session).
  const earlier = [];
  state.nowPlaying = earlier.length
    ? { ...NOW_PLAYING, title: earlier[0][0], artist: earlier[0][1] }
    : { ...NOW_PLAYING };
  win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor: 'bottom-right' }, transparent: true });
  for (const [title, artist] of earlier.slice(1)) {
    await sleep(4600); // one poll each (NOW_PLAYING_POLL_MS)
    state.nowPlaying = { ...NOW_PLAYING, title, artist };
  }
  if (earlier.length) {
    await sleep(4600);
    state.nowPlaying = { ...NOW_PLAYING };
    await sleep(4600);
  }
  await sleep(1500);
  await onWallpaper('hud-nowplaying', await capture(win));
  state.nowPlaying = { ...NOW_PLAYING, playing: false };
  await sleep(5200); // one poll (NOW_PLAYING_POLL_MS) and the dim transition
  await onWallpaper('hud-nowplaying-paused', await capture(win));
  win.destroy();
  state.nowPlaying = null;
}

// ---- Now playing and Up next --------------------------------------------------------------
//
// The card alone in a corner, over the busy desktop's code window (bottom
// right) and over the light window (top right), at the HUD background under
// test (65% default, 0% clear), Full and Fit, with 0 / 1 / 2 songs queued, a
// song request, and paused.

const NP_VARIANTS = [
  ['fit-q2', 'fit', QUEUE, false],
  ['fit-q1', 'fit', QUEUE.slice(0, 1), false],
  ['fit-q0', 'fit', [], false],
  ['fit-req', 'fit', [QUEUE[0], { ...QUEUE[1], requester: 'night_owl_42' }], false],
  ['fit-paused', 'fit', QUEUE, true],
  ['full-q2', 'full', QUEUE, false],
  ['full-paused', 'full', QUEUE, true],
];

async function npCorner(anchor, width, op, queue, paused) {
  state.presentation = {
    ...PRESENTATION,
    hud: {
      ...PRESENTATION.hud,
      bgOpacity: op,
      bubbles: [{ ...builtin('nowplaying', anchor), width, bgOpacity: op }],
    },
  };
  state.nowPlaying = { ...NOW_PLAYING, queue };
  const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor }, transparent: true });
  await sleep(900);
  if (paused) {
    state.nowPlaying = { ...NOW_PLAYING, queue, playing: false };
    await sleep(5200);
  }
  const img = await capture(win);
  win.destroy();
  return { png: img.toPNG().toString('base64'), ...img.getSize() };
}

async function npShots() {
  state.arrange = { on: false, canUndo: false };
  for (const op of [65, 0]) {
    for (const [name, width, queue, paused] of NP_VARIANTS) {
      const corners = {
        'top-right': await npCorner('top-right', width, op, queue, paused),
        'bottom-right': await npCorner('bottom-right', width, op, queue, paused),
      };
      const file = path.join(os.tmpdir(), `wd-desk-np.html`);
      writeFileSync(file, deskHtml(corners));
      const win = new BrowserWindow({ width: DESK_W, height: DESK_H, show: false, frame: false, webPreferences: { offscreen: true } });
      await win.loadFile(file);
      await sleep(400);
      const cw = HUD_W + MARGIN * 2;
      await shot(win, `np-${name}-${op}-light`, { x: DESK_W - cw, y: 0, width: cw, height: 260 });
      await shot(win, `np-${name}-${op}-desk`, { x: DESK_W - cw, y: DESK_H - 260, width: cw, height: 260 });
      win.destroy();
    }
  }
  state.presentation = null;
  state.nowPlaying = null;
}

// ---- the Lonely Cat -------------------------------------------------------------------------

async function catShots() {
  state.nowPlaying = { ...NOW_PLAYING };
  for (const a of ['top-right', 'top-left', 'bottom-left', 'bottom-right']) {
    state.presentation = { ...PRESENTATION, hud: { ...PRESENTATION.hud, catAnchor: a } };
    await hudShots([[false, `hud-cat-${a}`]]);
  }
  state.presentation = { ...PRESENTATION, hud: { ...PRESENTATION.hud, catAnchor: 'top-right' } };
  await hudShots([[true, 'hud-cat-arrange']]);
  state.presentation = null;
  state.nowPlaying = null;
  // The idle screen at a daytime hour: the cat settles a few seconds in.
  const win = await open('ambient.html', { width: DESK_W, height: DESK_H, transparent: true, at: weekAt(0, 14, 0) });
  await sleep(6_000);
  await onWallpaper('ambient-cat-day', await capture(win), 0);
  win.destroy();
}

// ---- The Watcher (the HUD cat, 2026-09-25) -------------------------------------------
//
// `--only=watcher`. One corner window at a time, at actual HUD scale (1:1),
// composited over the dark wallpaper and over a light app window, with the
// waterline ripple frozen at a known phase (every CSS animation paused
// through the Web Animations API: the rings at `phase` ms, anything else
// finished). Files are `watcher-*`, so an older build shot with --dist and
// --extras pairs up with them in compare.mjs.

const HUD_WIDTHS = { compact: 300, standard: 384, large: 480 };
const LIGHT_WINDOW = 'background: linear-gradient(180deg, #e3e6ee 0%, #d9dde6 60%, #cdd3de 100%)';

/** The fixture with the cat on the HUD in `anchor`, and a patch. */
function catPrefs(anchor, { scale = 'standard', extras = {}, bubbles, hud = {} } = {}) {
  return {
    ...PRESENTATION,
    hud: { ...PRESENTATION.hud, scale, catAnchor: anchor, ...(bubbles ? { bubbles } : {}), ...hud },
    extras: { ...PRESENTATION.extras, ...extras },
  };
}

/** Pause every animation: the ripple rings at `phase` ms, the rest finished. */
const freeze = (phase) => `(() => {
  let rings = 0;
  for (const a of document.getAnimations()) {
    if (a.animationName === 'hudcat-ripple') { a.pause(); a.currentTime = ${phase}; rings++; }
    else if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    else a.pause();
  }
  return rings;
})()`;

async function catCorner(anchor, { scale = 'standard', arranging = false, reduced = false, phase = 2500, ack = false, prefs } = {}) {
  state.presentation = prefs ?? catPrefs(anchor, { scale });
  state.arrange = { on: arranging, canUndo: arranging };
  const win = await open('hud.html', { width: HUD_WIDTHS[scale], height: 900, query: { anchor }, transparent: true });
  if (reduced) {
    // Switched after load: the page must follow a runtime change.
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await sleep(300);
  }
  if (ack) {
    // The acknowledgement's pose, a third of the way in.
    await js(win, "document.querySelector('.hudcat')?.classList.add('is-ack')");
    await sleep(100);
    await js(win, `(() => { for (const a of document.getAnimations()) if (a.animationName === 'hudcat-ack') { a.pause(); a.currentTime = 700; } })()`);
  }
  await sleep(700);
  const rings = await js(win, freeze(phase));
  const info = await js(win, "JSON.stringify({ cat: document.querySelector('.hudcat')?.className ?? null })");
  console.log(`  ${anchor} ${scale}${arranging ? ' arrange' : ''}${reduced ? ' reduced' : ''}: rings ${rings}, ${info}`);
  const img = await capture(win);
  win.destroy();
  state.presentation = null;
  state.arrange = { on: false, canUndo: false };
  return img;
}

/** One corner capture over `bg`, `pad` px of it around, optionally only the
 *  top `strip` px (the cat and the top of its bubble). */
async function onBackdrop(name, img, bg, { strip } = {}) {
  const { width, height } = img.getSize();
  const pad = MARGIN;
  const w = width + pad * 2;
  const h = strip ? Math.min(strip, height + pad * 2) : height + pad * 2;
  const file = path.join(os.tmpdir(), `wd-cat-${name}.html`);
  writeFileSync(
    file,
    `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;position:relative;${bg === 'bright' ? LIGHT_WINDOW : wallpaperCss()}">` +
      `<img src="data:image/png;base64,${img.toPNG().toString('base64')}" style="position:absolute;left:${pad}px;top:${pad}px;width:${width}px;height:${height}px"></body></html>`,
  );
  const win = new BrowserWindow({ width: w, height: h, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await sleep(250);
  await shot(win, name);
  win.destroy();
}

async function watcherShots() {
  state.nowPlaying = { ...NOW_PLAYING };
  const corners = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

  // The customisation family: four silhouettes, six fixed eye colours, then
  // the cover accent in the one supported first-release topology (cat and an
  // enabled Now Playing bubble in the same corner).
  for (const catVariant of ['watcher', 'sentinel', 'peeker', 'ledge']) {
    const prefs = catPrefs('top-right', { hud: { catVariant } });
    await onBackdrop(`watcher-variant-${catVariant}`, await catCorner('top-right', { prefs }), 'dark', { strip: 120 });
  }
  for (const catEye of ['gold', 'amber', 'ice', 'cobalt', 'mint', 'violet']) {
    const prefs = catPrefs('top-right', { hud: { catEye } });
    await onBackdrop(`watcher-eye-${catEye}`, await catCorner('top-right', { prefs }), 'dark', { strip: 120 });
  }
  const music = catPrefs('bottom-right', { hud: { catFollowNowPlaying: true, catEye: 'gold' } });
  await onBackdrop('watcher-music-live-outline-ripple', await catCorner('bottom-right', { prefs: music }), 'dark', { strip: 170 });
  state.nowPlaying = { ...NOW_PLAYING, playing: false, accent: null };
  await onBackdrop('watcher-music-fallback', await catCorner('bottom-right', { prefs: music }), 'dark', { strip: 170 });
  state.nowPlaying = { ...NOW_PLAYING };
  const offCorner = catPrefs('top-right', { hud: { catFollowNowPlaying: true, catEye: 'mint' } });
  await onBackdrop('watcher-music-other-corner', await catCorner('top-right', { prefs: offCorner }), 'dark', { strip: 120 });
  for (const catOpacity of [25, 60, 100]) {
    const prefs = catPrefs('top-right', { hud: { catOpacity } });
    await onBackdrop(`watcher-opacity-${catOpacity}`, await catCorner('top-right', { prefs }), 'dark', { strip: 120 });
  }

  // All four corners, standard, over dark and bright: the whole corner, and
  // the strip the cat lives in.
  for (const a of corners) {
    const img = await catCorner(a);
    for (const bg of ['dark', 'bright']) {
      await onBackdrop(`watcher-${a}-${bg}`, img, bg);
      await onBackdrop(`watcher-${a}-${bg}-strip`, img, bg, { strip: 120 });
    }
  }

  // Compact, standard, large: a right and a left corner (the mirror).
  for (const scale of ['compact', 'standard', 'large']) {
    for (const a of ['top-right', 'top-left']) {
      const img = await catCorner(a, { scale });
      await onBackdrop(`watcher-scale-${scale}-${a}`, img, 'dark', { strip: 130 });
    }
  }

  // The ripple through one 5 s beat (two rings 5 s apart, so t and t + 5 s
  // look the same), top right, over dark and bright.
  for (const phase of [0, 1250, 2500, 3750]) {
    const img = await catCorner('top-right', { phase });
    for (const bg of ['dark', 'bright']) await onBackdrop(`watcher-ripple-${phase}-${bg}`, img, bg, { strip: 110 });
  }

  // Imminent: the block in Next up (the fixture's crimson row), and the cat's
  // one acknowledgement mid-dip.
  await onBackdrop('watcher-imminent', await catCorner('top-right'), 'dark', { strip: 200 });
  await onBackdrop('watcher-imminent-ack', await catCorner('top-right', { ack: true }), 'dark', { strip: 200 });

  // Reduced motion: completely still, one static ring.
  for (const a of ['top-right', 'bottom-left']) {
    const img = await catCorner(a, { reduced: true });
    for (const bg of ['dark', 'bright']) await onBackdrop(`watcher-reduced-${a}-${bg}`, img, bg, { strip: 120 });
  }

  // Arrange mode: the cat's corner (labelled) and a corner without it.
  await onBackdrop('watcher-arrange-top-right', await catCorner('top-right', { arranging: true }), 'dark');
  await onBackdrop(
    'watcher-arrange-top-left-nocat',
    await catCorner('top-left', { arranging: true, prefs: catPrefs('top-right') }),
    'dark',
  );

  // A cat-only corner: nothing enabled bottom left, the cat there alone —
  // normal and in arrange mode. And a corner whose bubbles are all ruled out
  // right now (only during gym), where the cat stays on the bare waterline.
  const noBottomLeft = PRESENTATION.hud.bubbles.map((b) => (b.anchor === 'bottom-left' ? { ...b, enabled: false } : b));
  const alone = catPrefs('bottom-left', { bubbles: noBottomLeft });
  for (const bg of ['dark', 'bright']) {
    await onBackdrop(`watcher-alone-bottom-left-${bg}`, await catCorner('bottom-left', { prefs: alone }), bg);
  }
  await onBackdrop('watcher-alone-bottom-left-arrange', await catCorner('bottom-left', { prefs: alone, arranging: true }), 'dark');
  const ruled = catPrefs('bottom-left', {
    bubbles: PRESENTATION.hud.bubbles.map((b) =>
      b.anchor === 'bottom-left' ? { ...b, show: { ...b.show, onlyDuring: ['gym'] } } : b,
    ),
  });
  await onBackdrop('watcher-ruled-bottom-left', await catCorner('bottom-left', { prefs: ruled }), 'dark');

  // The two switches: HUD cat off (idle cat on) leaves the corner bare, and
  // the idle screen with its cat on and off.
  await onBackdrop(
    'watcher-hud-off-top-right',
    await catCorner('top-right', { prefs: catPrefs('top-right', { extras: { lonelyCat: false, catHud: false, catIdle: true } }) }),
    'dark',
    { strip: 120 },
  );
  for (const [name, catIdle] of [
    ['watcher-idle-on', true],
    ['watcher-idle-off', false],
  ]) {
    state.presentation = catPrefs('top-right', { extras: { lonelyCat: catIdle, catHud: true, catIdle } });
    const win = await open('ambient.html', { width: DESK_W, height: DESK_H, transparent: true, at: weekAt(0, 14, 0) });
    await sleep(6_000);
    const img = await capture(win);
    win.destroy();
    await onWallpaper(name, img, 0);
  }
  state.presentation = null;
  state.nowPlaying = null;
}

// ---- special times ---------------------------------------------------------------------
//
// Each freezes its own clock. They run in every label, so an older build shot
// with --dist gives a like-for-like `before` (the plain clock, the one-line
// review prompt) for each.

/** One corner's HUD at `at`, composited on the wallpaper. */
async function cornerAt(name, anchor, at, before) {
  const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor }, transparent: true, at });
  if (before) await before(win);
  await onWallpaper(name, await capture(win));
  win.destroy();
}

async function specialShots() {
  state.arrange = { on: false, canUndo: false };
  const baseEvents = state.events;

  // Stream day (Wednesday, which has no stream block in the skeleton): a
  // "Twitch Stream" calendar event at 20:34, as a weekly stream might be.
  state.events = [...baseEvents, calEvent('twitch', 'Twitch Stream', weekAt(2, 20, 34), 180)];
  await cornerAt('hud-stream-1820', 'top-right', weekAt(2, 18, 20));
  await cornerAt('hud-stream-2028', 'top-right', weekAt(2, 20, 28));
  await cornerAt('hud-stream-live', 'top-right', weekAt(2, 20, 50));
  state.events = baseEvents;

  // Night: the whole desk at 00:40 (day/night shift), then the idle screen,
  // and the idle screen 21 minutes on (the cat).
  await hudShots([[false, 'hud-night']], weekAt(1, 0, 40));
  let win = await open('ambient.html', { width: DESK_W, height: DESK_H, transparent: true, at: weekAt(1, 0, 40) });
  await onWallpaper('ambient-night', await capture(win), 0);
  console.log('  visibility:', await js(win, 'document.visibilityState'));
  await js(win, '__wdShiftClock(21 * 60 * 1000)');
  await sleep(31_000); // the overlay re-reads the clock every 30s
  await sleep(6_500); // the cat settles
  await onWallpaper('ambient-night-cat', await capture(win), 0);
  win.destroy();

  // Sunday 19:00: the review. The idle screen (debrief), and the Week bubble.
  const sunday = weekAt(6, 19, 0);
  state.week = {
    ...WEEK_BASE,
    intentions: WEEK_BASE.intentions.map((t) => ({ ...t, done: true })),
    tasks: WEEK_BASE.tasks.map((t, i) => ({ ...t, done: i > 0 })),
  };
  win = await open('ambient.html', { width: DESK_W, height: DESK_H, transparent: true, at: sunday });
  await sleep(900); // the sheet wipes in after the overlay
  await onWallpaper('ambient-sunday', await capture(win), 0);
  win.destroy();
  await cornerAt('hud-sunday-top-left', 'top-left', sunday);

  // Every task done: WEEK CLEARED.
  state.week = { ...WEEK_BASE, tasks: WEEK_BASE.tasks.map((t) => ({ ...t, done: true })) };
  await cornerAt('hud-cleared-top-left', 'top-left', now);
  state.week = WEEK_BASE;

  // Objective complete: tick an intention in the vault after the first read.
  await cornerAt('hud-objective', 'top-left', now, async (w) => {
    state.week = {
      ...WEEK_BASE,
      intentions: WEEK_BASE.intentions.map((t, i) => (i === 0 ? { ...t, text: `${t.text} ✅ ${today}`, done: true } : t)),
    };
    w.webContents.send('vault:changed');
    await sleep(900);
  });
  state.week = WEEK_BASE;

  // A streak target hit while the HUD is up: Monday's gym lands (5/5). The
  // wipe waits out the first ten seconds (data still arriving).
  await cornerAt('hud-streak-hit', 'top-left', now, async (w) => {
    await sleep(10_500);
    state.events = [...baseEvents, ...gymWeek(0, [0])];
    w.webContents.send('cal:changed', { syncing: false });
    await sleep(330); // mid-wipe
    console.log('  wipe playing:', await js(w, "!!document.querySelector('.streaks__wipe')"), await js(w, "document.querySelector('.streak__count')?.textContent"));
  });
  state.events = baseEvents;
}

// ---- hover fade (2026-10-02) ---------------------------------------------------------
//
// In the app the main process polls the cursor and sends each corner window
// `hud:hover` with the point inside it (electron/hudhover.cjs). The poll is
// main-process only, so here the same message is sent by hand, at the centre of
// one bubble; the renderer's hit test and the CSS fade are the real ones. Each
// corner is shot over the busy desk, so what shows through can be seen. A build
// without the feature (`before --dist=…`) ignores the message: that is the
// baseline. `hover-arrange` sends the same point in arrange mode, which must
// stay solid.

async function hoverCorner(anchor, target, arranging) {
  state.arrange = { on: arranging, canUndo: false };
  const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor }, transparent: true });
  await sleep(700);
  if (target) {
    const pt = await js(
      win,
      `(() => { const r = document.querySelector('.bub--${target}')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`,
    );
    win.webContents.send('hud:hover', pt);
    await sleep(450); // the 150 ms fade, settled
  }
  const info = await js(
    win,
    `JSON.stringify([...document.querySelectorAll('.hudstack > .hud')].map((el) => [el.className.split(' ')[3], getComputedStyle(el).opacity]))`,
  );
  console.log(`  ${anchor}${arranging ? ' arrange' : ''} hover=${target ?? '-'}: ${info}`);
  const img = await win.webContents.capturePage(undefined, { stayHidden: true });
  win.destroy();
  state.arrange = { on: false, canUndo: false };
  return { png: img.toPNG().toString('base64'), ...img.getSize() };
}

async function hoverShots() {
  const cases = [
    ['hover-none', 'top-right', null, false],
    ['hover-upcoming', 'top-right', 'upcoming', false],
    ['hover-clock', 'top-right', 'clock', false],
    ['hover-nowplaying', 'bottom-right', 'nowplaying', false],
    ['hover-arrange', 'top-right', 'upcoming', true],
  ];
  state.nowPlaying = { ...NOW_PLAYING };
  for (const [name, anchor, target, arranging] of cases) {
    const corner = await hoverCorner(anchor, target, arranging);
    const file = path.join(os.tmpdir(), `wd-desk-${name}.html`);
    writeFileSync(file, deskHtml({ [anchor]: corner }));
    const win = new BrowserWindow({ width: DESK_W, height: DESK_H, show: false, frame: false, webPreferences: { offscreen: true } });
    await win.loadFile(file);
    await sleep(400);
    const cw = HUD_W + MARGIN * 2;
    const ch = DESK_H / 2;
    await shot(win, name, { x: DESK_W - cw, y: anchor.startsWith('top') ? 0 : DESK_H - ch, width: cw, height: ch });
    win.destroy();
  }
  state.nowPlaying = null;
}

// ---- Phase 9.5: the set-up wizard, Integrations, empty states -----------------------
//
// `--only=setup` shoots the first-run wizard step by step and the Integrations
// tab (healthy, needing a fix, built-in notes); `--only=empty` the HUD of a new
// profile under each preset, with nothing connected. The public build has no
// Google account, so these shots set none.

const NO_GOOGLE = { configured: false, connected: false, email: null };
const HOLIDAYS = {
  id: 'cal-h',
  kind: 'ics-url',
  name: 'Public holidays',
  configured: true,
  fetchedAt: now.getTime() - 40_000,
  lastError: null,
  warning: null,
  count: 41,
};
const PICK = {
  ok: true,
  name: 'Notes',
  detected: { obsidian: true, weeklyDir: 'Journal/Weekly', dailyDir: 'Journal/Daily', backlogPath: 'Inbox.md', weeks: 14, days: 61 },
};

async function openSettings(target) {
  const win = await open('index.html', { width: 1180, height: 840 });
  for (let i = 0; i < 20; i++) {
    win.webContents.send('presentation:open', target);
    await sleep(300);
    if (await js(win, "!!document.querySelector('.modal--window')")) break;
  }
  await sleep(700);
  return win;
}

async function setupShots() {
  state.google = NO_GOOGLE;
  state.sources = [];
  state.folderPick = PICK;
  state.notesSettings = { kind: 'builtin', name: 'Built-in notes', weeklyDir: 'Weekly', dailyDir: 'Daily', backlogPath: 'Backlog.md', taskTag: '#thisweek', taskFolders: '', write: true };
  state.notesStatus = { kind: 'builtin', name: 'Built-in notes', ready: true, canWrite: true, backlog: 'Backlog.md', weekly: 'Weekly' };

  // The wizard, the P1 way: Start fresh, a link, Minimal.
  let win = await openSettings({ onboarding: true });
  await shot(win, 'onb-1-notes');
  await clickText(win, '.onb-choice__card', 'Use my notes folder');
  await sleep(300);
  await shot(win, 'onb-1-folder-choose');
  await clickText(win, '.onb-folder button', 'Choose folder');
  await sleep(500);
  await shot(win, 'onb-1-folder-picked');
  await js(win, "document.querySelector('.onb__body')?.scrollTo(0, 99999)");
  await sleep(300);
  await shot(win, 'onb-1-folder-picked-scrolled');
  await clickText(win, '.onb-choice__card', 'Start fresh');
  await sleep(200);
  await clickText(win, '.onb__foot button', 'Next');
  await sleep(500);
  await shot(win, 'onb-2-calendar');
  // A calendar added: the list shows it, read and counted.
  state.sources = [HOLIDAYS];
  win.webContents.send('events:changed');
  await sleep(500);
  await shot(win, 'onb-2-calendar-added');
  await clickText(win, '.onb__foot button', 'Next');
  await sleep(700);
  await shot(win, 'onb-3-corners');
  await clickText(win, '.onb-preset', 'Focus');
  await sleep(300);
  await shot(win, 'onb-3-focus');
  await clickText(win, '.onb-backdrop .seg button', 'Scrim');
  await sleep(300);
  await shot(win, 'onb-3-scrim');
  win.destroy();

  // The P2 way ends with the restart.
  win = await openSettings({ onboarding: true });
  await clickText(win, '.onb-choice__card', 'Use my notes folder');
  await sleep(200);
  await clickText(win, '.onb-folder button', 'Choose folder');
  await sleep(400);
  await clickText(win, '.onb__foot button', 'Next');
  await sleep(400);
  await clickText(win, '.onb__foot button', 'Next');
  await sleep(500);
  await clickText(win, '.onb__foot button', 'Finish');
  await sleep(700);
  await shot(win, 'onb-4-restart');
  win.destroy();

  // Integrations: a healthy folder, the HUD's one calendar, any player.
  state.sources = [HOLIDAYS, { ...HOLIDAYS, id: 'cal-f', kind: 'ics-file', name: 'Timetable', file: 'timetable.ics', count: 12, fetchedAt: now.getTime() - 3 * 3600_000 }];
  state.notesSettings = { kind: 'folder', name: 'Notes', weeklyDir: 'Weekly', dailyDir: 'Daily', backlogPath: 'Backlog.md', taskTag: '#thisweek', taskFolders: '', write: false };
  state.notesStatus = { kind: 'folder', name: 'Notes', ready: true, canWrite: false, backlog: 'Backlog.md', weekly: 'Weekly' };
  state.nowPlaying = { ...NOW_PLAYING };
  win = await openSettings({ tab: 'integrations' });
  await shot(win, 'integrations');
  await js(win, "document.querySelector('.pres__body')?.scrollTo(0, 99999)");
  await sleep(300);
  await shot(win, 'integrations-scrolled');
  await js(win, "document.querySelector('.icshelp')?.setAttribute('open', '')");
  await sleep(300);
  await shot(win, 'integrations-help');
  win.destroy();
  state.nowPlaying = null;

  // Needs fixing: a link that stopped working, a folder that moved.
  state.sources = [{ ...HOLIDAYS, lastError: 'calendar fetch failed: HTTP 404', fetchedAt: now.getTime() - 26 * 3600_000 }];
  state.notesStatus = { kind: 'folder', name: 'Notes', ready: false, canWrite: false, backlog: 'Backlog.md', weekly: 'Weekly' };
  win = await openSettings({ tab: 'integrations' });
  await shot(win, 'integrations-fix');
  await clickText(win, '.integ__card button', 'Fix');
  await sleep(300);
  await shot(win, 'integrations-fix-link');
  win.destroy();

  // A new profile: built-in notes, nothing connected.
  state.sources = [];
  state.notesSettings = { kind: 'builtin', name: 'Built-in notes', weeklyDir: 'Weekly', dailyDir: 'Daily', backlogPath: 'Backlog.md', taskTag: '#thisweek', taskFolders: '', write: true };
  state.notesStatus = { kind: 'builtin', name: 'Built-in notes', ready: true, canWrite: true, backlog: 'Backlog.md', weekly: 'Weekly' };
  win = await openSettings({ tab: 'integrations' });
  await shot(win, 'integrations-new');
  win.destroy();

  // The Screens tab's HUD card: the Backdrop switch.
  win = await openSettings({ tab: 'screen' });
  await js(win, "(() => { const h = [...document.querySelectorAll('.card__head h3')].find(x => x.textContent.trim() === 'HUD'); h?.closest('.card')?.scrollIntoView(); })()");
  await sleep(300);
  await shot(win, 'screens-hud-backdrop');
  win.destroy();

  Object.assign(state, { sources: null, notesStatus: null, notesSettings: null, folderPick: null, google: null });
}

/** Built-in bubbles in preset order (src/lib/presentation.ts PRESET_LAYOUT), for the harness. */
const PRESET_BUBBLES = {
  minimal: [['clock', 'top-right'], ['upcoming', 'top-right'], ['radar', 'top-right']],
  focus: [['clock', 'top-right'], ['upcoming', 'top-right'], ['radar', 'top-right'], ['intention', 'top-left'], ['health', 'top-left']],
  full: [
    ['clock', 'top-right'], ['upcoming', 'top-right'], ['radar', 'top-right'], ['placed', 'top-right'], ['weekstrip', 'top-right'],
    ['intention', 'top-left'], ['health', 'top-left'], ['streaks', 'top-left'], ['backlog', 'top-left'], ['daily', 'bottom-left'], ['nowplaying', 'bottom-right'],
  ],
};
const weekNote = (anchor) => ({
  id: 'b-weeknote',
  type: 'note',
  enabled: true,
  anchor,
  title: 'This week',
  rows: null,
  show: show(),
  source: { path: 'Weekly/{week}', heading: 'Tasks', items: 'open' },
});
function presetPrefs(preset, hud = {}) {
  const bubbles = PRESET_BUBBLES[preset].map(([id, a]) => builtin(id, a));
  if (preset !== 'minimal') bubbles.push(weekNote('top-left'));
  return { ...PRESENTATION, extras: undefined, hud: { ...PRESENTATION.hud, backdrop: 'panel', bgOpacity: 85, ...hud, bubbles } };
}

/** A new profile: no calendar, no blocks, an empty week, nothing playing. */
const EMPTY_WEEK = { weekId: 'fixture', notePath: null, weeklyDir: 'Weekly', intentions: [], tasks: [], thisweek: [] };

async function emptyShots() {
  state.google = NO_GOOGLE;
  state.sources = [];
  state.events = [];
  state.week = EMPTY_WEEK;
  state.skeletonYaml = 'blocks: []\n';
  state.widgets = { daily: { file: '', exists: false, goals: [], energy: null, motivation: null }, custom: {} };
  state.notesStatus = { kind: 'builtin', name: 'Built-in notes', ready: true, canWrite: true, backlog: 'Backlog.md', weekly: 'Weekly' };
  for (const preset of ['minimal', 'focus', 'full']) {
    state.presentation = presetPrefs(preset);
    await hudShots([[false, `empty-${preset}`]]);
  }
  // With a calendar connected but nothing on it: Next up says so plainly.
  state.sources = [HOLIDAYS];
  state.presentation = presetPrefs('minimal');
  await hudShots([[false, 'empty-minimal-calendar']]);
  // A notes folder that has gone missing: Intentions says where to fix it.
  state.notesStatus = { kind: 'folder', name: 'Notes', ready: false, canWrite: false, backlog: 'Backlog.md', weekly: 'Weekly' };
  state.presentation = presetPrefs('focus');
  await hudShots([[false, 'empty-focus-folder-missing']]);
  Object.assign(state, { sources: null, events: [...EVENTS, ...THIS_WEEK_EXTRA], week: WEEK_BASE, skeletonYaml: null, widgets: null, notesStatus: null, presentation: null, google: null });
}

// ---- Phase 9.5: contrast over four wallpapers ----------------------------------------
//
// `--only=contrast`. Measured, not eyeballed: each corner is rendered with a
// backdrop setting, composited over a wallpaper, and every line of text is
// checked against the pixels behind it.
//
//   fill-only  the text's colour against the *lightest-for-it* pixel of the
//              backdrop behind its box, rendered with the text (and its halo)
//              hidden: the backdrop alone has to carry the text. The gate.
//   with halo  the text's colour against the ring of pixels two away from its
//              glyphs in the real render (the median), i.e. against the ink
//              halo each glyph carries. For context; `none` relies on it.
//
// Roles: body is every line of words. Reported apart: accent (the cobalt
// times in Next up), urgent (the crimson countdown), secondary (.muted, estimates,
// sub-lines) and captions (.q-label, the clock's day). Done items are dimmed
// on purpose and skipped. The four
// wallpapers: solid white (a white window), solid black, mid-grey (#808080)
// and a busy photo-like image drawn here, procedurally, with no download.

const WALLPAPERS = ['white', 'black', 'grey', 'photo'];
const WALL_CSS = { white: '#ffffff', black: '#000000', grey: '#808080' };
let PHOTO_URL = null;

/** A busy, photo-like 1920×1080 wallpaper: a hazy sky with bright cumulus and
 *  a low sun, dark hills, and high-frequency foliage — deterministic (seeded). */
async function makePhoto() {
  const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<canvas id=c width=1920 height=1080></canvas>');
  PHOTO_URL = await w.webContents.executeJavaScript(`(() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const c = document.getElementById('c');
    const g = c.getContext('2d');
    const W = 1920, H = 1080;
    const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
    sky.addColorStop(0, '#3f7fc4'); sky.addColorStop(0.55, '#8fc0e8'); sky.addColorStop(1, '#f1e6cf');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    // A low sun with a wide glare, top right: the worst place for a corner.
    const sun = g.createRadialGradient(1640, 150, 10, 1640, 150, 420);
    sun.addColorStop(0, 'rgba(255,255,250,1)'); sun.addColorStop(0.12, 'rgba(255,250,225,0.95)'); sun.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, H);
    // Cumulus: clusters of soft white puffs with grey undersides.
    for (let k = 0; k < 26; k++) {
      const cx = rnd() * W, cy = 40 + rnd() * H * 0.42, s = 40 + rnd() * 110;
      for (let i = 0; i < 14; i++) {
        const x = cx + (rnd() - 0.5) * s * 3, y = cy + (rnd() - 0.5) * s * 0.9, r = s * (0.4 + rnd() * 0.7);
        const p = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
        p.addColorStop(0, 'rgba(255,255,255,0.95)'); p.addColorStop(0.7, 'rgba(236,240,246,0.75)'); p.addColorStop(1, 'rgba(180,190,205,0)');
        g.fillStyle = p; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    }
    // Hills, far to near, darker and greener.
    const hill = (base, amp, col, step) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
      let y = base;
      for (let x = 0; x <= W; x += step) { y += (rnd() - 0.5) * amp; y = Math.max(base - amp * 4, Math.min(base + amp * 4, y)); g.lineTo(x, y); }
      g.lineTo(W, H); g.fill();
    };
    hill(H * 0.6, 22, '#6d8296', 24); hill(H * 0.68, 26, '#3f5a46', 18); hill(H * 0.78, 30, '#22331f', 12);
    // Foliage and bright flowers: high-frequency detail in the lower half.
    for (let i = 0; i < 22000; i++) {
      const x = rnd() * W, y = H * 0.7 + rnd() * H * 0.3, r = 1 + rnd() * 4;
      const t = rnd();
      g.fillStyle = t < 0.08 ? '#f4f1e8' : t < 0.14 ? '#e7c241' : t < 0.18 ? '#c8463c' : 'rgba(' + (20 + rnd() * 60 | 0) + ',' + (50 + rnd() * 90 | 0) + ',' + (20 + rnd() * 40 | 0) + ',0.9)';
      g.fillRect(x, y, r, r);
    }
    // Birch trunks on the left: tall bright verticals with dark marks.
    for (let i = 0; i < 9; i++) {
      const x = 30 + rnd() * 520, w = 10 + rnd() * 18;
      g.fillStyle = '#ece9e0'; g.fillRect(x, 0, w, H);
      for (let j = 0; j < 40; j++) { g.fillStyle = '#2a2a26'; g.fillRect(x, rnd() * H, w * (0.3 + rnd() * 0.7), 2 + rnd() * 5); }
    }
    return c.toDataURL('image/png');
  })()`);
  w.destroy();
}

const wallBg = (wp, anchor) => {
  if (wp !== 'photo') return `background:${WALL_CSS[wp]}`;
  const right = anchor.endsWith('right');
  const bottom = anchor.startsWith('bottom');
  return `background:url(${PHOTO_URL}) ${right ? 'right' : 'left'} ${bottom ? 'bottom' : 'top'} / ${DESK_W}px ${DESK_H}px no-repeat`;
};

const HIDE_TEXT = `(() => { const s = document.createElement('style'); s.id = '__hide-text';
  s.textContent = '*, *::before, *::after { transition: none !important; } .hudstack *, .ambient * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; } img { visibility: hidden !important; }';
  document.head.appendChild(s); return true; })()`;

/** Every line of text in the page: its box, colour and role (body / secondary / caption). */
const TEXT_BOXES = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1;
    for (let a = el; a; a = a.parentElement) op *= Number(getComputedStyle(a).opacity);
    if (op < 0.98) continue; // done or dimmed on purpose
    const role = el.closest('.q-label, .hud__day, .bub__title, .ambient__day, .weekstrip')
      ? 'caption'
      : el.closest('.u--imminent .u__time')
        ? 'urgent'
        : el.closest('.u__time, .focus__left')
        ? 'accent'
        : el.closest('.muted, .u__est, .bub__sub, .is-done, .ambient__stub, .radar__scale')
          ? 'secondary'
          : 'body';
    const r = document.createRange();
    r.selectNodeContents(n);
    for (const b of r.getClientRects()) {
      if (b.width < 3 || b.height < 6) continue;
      out.push({ x: b.left, y: b.top, w: b.width, h: b.height, color: cs.color, size: parseFloat(cs.fontSize), role, text: n.textContent.trim().slice(0, 40) });
    }
  }
  return out;
})()`;

function parseColor(c) {
  let m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
  return null;
}
const lin = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Composite one transparent capture over a wallpaper and return its pixels. */
async function compositeOn(img, wp, anchor, pad = MARGIN) {
  const { width, height } = img.getSize();
  const w = width + pad * 2;
  const h = height + pad * 2;
  const file = path.join(os.tmpdir(), `wd-contrast.html`);
  writeFileSync(
    file,
    `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;position:relative;${wallBg(wp, anchor)}">` +
      `<img src="data:image/png;base64,${img.toPNG().toString('base64')}" style="position:absolute;left:${pad}px;top:${pad}px;width:${width}px;height:${height}px"></body></html>`,
  );
  const win = new BrowserWindow({ width: w, height: h, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await sleep(250);
  const out = await win.webContents.capturePage(undefined, { stayHidden: true });
  win.destroy();
  return out;
}

/** BGRA bitmap → a pixel reader. */
function pixels(img) {
  const { width, height } = img.getSize();
  const buf = img.toBitmap();
  return { width, height, at: (x, y) => { const i = (y * width + x) * 4; return [buf[i + 2], buf[i + 1], buf[i]]; } };
}

/** Fill-only and with-halo contrast for each text box. */
function measure(boxes, fill, real, pad) {
  const res = [];
  for (const b of boxes) {
    const tc = parseColor(b.color);
    if (!tc) continue;
    const Lt = lum(tc);
    const x0 = Math.max(0, Math.floor(b.x + pad)), y0 = Math.max(0, Math.floor(b.y + pad));
    const x1 = Math.min(fill.width - 1, Math.ceil(b.x + b.w + pad)), y1 = Math.min(fill.height - 1, Math.ceil(b.y + b.h + pad));
    let worst = Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) worst = Math.min(worst, ratio(Lt, lum(fill.at(x, y))));
    // The halo: the ring of pixels two away from a glyph in the real render —
    // past the glyph's own anti-aliased edge, inside the ink outline.
    const near = (p) => Math.hypot(p[0] - tc[0], p[1] - tc[1], p[2] - tc[2]) < 48;
    const glyph = new Set();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (near(real.at(x, y))) glyph.add(y * real.width + x);
    const within = (x, y, d) => {
      for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) if (glyph.has((y + dy) * real.width + (x + dx))) return true;
      return false;
    };
    const ring = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (!within(x, y, 1) && within(x, y, 2)) ring.push(ratio(Lt, lum(real.at(x, y))));
    }
    ring.sort((a, c) => a - c);
    const halo = ring.length ? ring[Math.floor(ring.length * 0.5)] : null;
    res.push({ ...b, fill: worst, halo });
  }
  return res;
}

const CONTRAST_CORNERS = ['top-right', 'top-left'];
/** The settings measured: the new default (panel 85%), the old one (65%), the scrim at each, and none. */
const CONTRAST_CONFIGS = [
  ['panel-85', 'panel', 85],
  ['panel-65', 'panel', 65],
  ['scrim-85', 'scrim', 85],
  ['scrim-65', 'scrim', 65],
  ['none', 'none', 0],
];

async function measureCorner(prefs, anchor, wp, name) {
  state.presentation = prefs;
  const win = await open('hud.html', { width: HUD_W, height: 900, query: { anchor }, transparent: true });
  await sleep(500);
  const boxes = await js(win, TEXT_BOXES);
  const realCap = await capture(win);
  await js(win, HIDE_TEXT);
  await sleep(250);
  const fillCap = await capture(win);
  win.destroy();
  const real = await compositeOn(realCap, wp, anchor);
  const fill = await compositeOn(fillCap, wp, anchor);
  if (name) writeFileSync(path.join(OUT, `${name}.png`), real.toPNG());
  return measure(boxes, pixels(fill), pixels(real), MARGIN);
}

const minOf = (rows, role, key) => {
  const v = rows.filter((r) => (role ? r.role === role : true) && r[key] != null).map((r) => r[key]);
  return v.length ? Math.min(...v) : null;
};
const f2 = (v) => (v == null ? '–' : v.toFixed(2));

async function contrastShots() {
  state.arrange = { on: false, canUndo: false };
  state.google = NO_GOOGLE;
  state.nowPlaying = null;
  await makePhoto();
  const base = { ...PRESENTATION, extras: undefined, hud: { ...PRESENTATION.hud, bubbles: PRESENTATION.hud.bubbles.filter((b) => CONTRAST_CORNERS.includes(b.anchor) && b.type === 'builtin') } };
  const results = {};
  for (const [cfg, backdrop, op] of CONTRAST_CONFIGS) {
    for (const wp of WALLPAPERS) {
      const rows = [];
      for (const anchor of CONTRAST_CORNERS) {
        const prefs = { ...base, hud: { ...base.hud, backdrop, bgOpacity: op } };
        rows.push(...(await measureCorner(prefs, anchor, wp, `contrast-${wp}-${cfg}-${anchor}`)));
      }
      results[`${cfg}|${wp}`] = rows;
      console.log(`  ${cfg} over ${wp}: body fill-only ${f2(minOf(rows, 'body', 'fill'))}, with halo ${f2(minOf(rows, 'body', 'halo'))}`);
    }
  }
  // The lowest Background that keeps body text at 4.5:1 over a white window.
  const sweep = {};
  for (const backdrop of ['panel', 'scrim']) {
    for (let op = 50; op <= 95; op += 5) {
      const rows = [];
      for (const anchor of CONTRAST_CORNERS) rows.push(...(await measureCorner({ ...base, hud: { ...base.hud, backdrop, bgOpacity: op } }, anchor, 'white')));
      sweep[`${backdrop}-${op}`] = { body: minOf(rows, 'body', 'fill'), accent: minOf(rows, 'accent', 'fill'), secondary: minOf(rows, 'secondary', 'fill') };
    }
  }
  // The idle overlay over each wallpaper.
  const ambient = {};
  state.presentation = base;
  for (const wp of WALLPAPERS) {
    const win = await open('ambient.html', { width: DESK_W, height: DESK_H, transparent: true });
    await sleep(1200); // the overlay's own fade-in
    const boxes = await js(win, TEXT_BOXES);
    const realCap = await capture(win);
    await js(win, HIDE_TEXT);
    await sleep(250);
    const fillCap = await capture(win);
    win.destroy();
    const real = await compositeOn(realCap, wp, 'top-left', 0);
    const fill = await compositeOn(fillCap, wp, 'top-left', 0);
    writeFileSync(path.join(OUT, `contrast-ambient-${wp}.png`), real.toPNG());
    ambient[wp] = measure(boxes, pixels(fill), pixels(real), 0);
    console.log(`  idle overlay over ${wp}: body fill-only ${f2(minOf(ambient[wp], 'body', 'fill'))}, with halo ${f2(minOf(ambient[wp], 'body', 'halo'))}`);
  }
  state.presentation = null;
  state.google = null;

  // The report: body text (the gate), then every line for context.
  const lines = ['# Contrast over four wallpapers', '', `Build: ${path.relative(ROOT, DIST)} · ${new Date().toISOString()}`, ''];
  const table = (title, key, role) => {
    lines.push(`## ${title}`, '', `| Backdrop | ${WALLPAPERS.join(' | ')} |`, `|---|${WALLPAPERS.map(() => '---:').join('|')}|`);
    for (const [cfg] of CONTRAST_CONFIGS) lines.push(`| ${cfg} | ${WALLPAPERS.map((wp) => f2(minOf(results[`${cfg}|${wp}`], role, key))).join(' | ')} |`);
    lines.push(`| idle overlay | ${WALLPAPERS.map((wp) => f2(minOf(ambient[wp], role, key))).join(' | ')} |`, '');
  };
  table('Body text, backdrop only (gate: 4.5)', 'fill', 'body');
  table('Body text, with the ink halo (median of the ring two pixels out)', 'halo', 'body');
  table('Accent text (cobalt times), backdrop only', 'fill', 'accent');
  table('Urgent text (the crimson countdown), backdrop only', 'fill', 'urgent');
  table('Urgent text, with the ink halo', 'halo', 'urgent');
  table('Secondary text, backdrop only', 'fill', 'secondary');
  lines.push('## Background sweep over white (backdrop only): body / accent / secondary', '', '| Background | panel | scrim |', '|---:|---:|---:|');
  for (let op = 50; op <= 95; op += 5) {
    const cell = (b) => ['body', 'accent', 'secondary'].map((k) => f2(sweep[`${b}-${op}`]?.[k])).join(' / ');
    lines.push(`| ${op}% | ${cell('panel')} | ${cell('scrim')} |`);
  }
  writeFileSync(path.join(OUT, 'contrast.md'), lines.join('\n') + '\n');
  writeFileSync(path.join(OUT, 'contrast.json'), JSON.stringify({ results, sweep, ambient }, null, 1));
  console.log(lines.join('\n'));
}

async function main() {
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  await app.whenReady();
  appProtocol.serve(protocol, DIST, { [BLANK]: '<!doctype html><title>blank</title>' });
  stubBridge();
  console.log(`design shots → design-shots/${LABEL}  (${path.relative(ROOT, DIST)}, extras ${EXTRAS_ON ? 'on' : 'off'})`);
  if (runs('settings')) await settingsShots();
  if (runs('hud')) await hudShots();
  if (runs('surfaces')) await surfaceShots();
  if (runs('special') && !OPACITY) await specialShots();
  if (runs('np') && !OPACITY) await npShots();
  if (runs('cat') && !OPACITY && HAS_ADDONS) await catShots();
  if (runs('watcher') && !OPACITY && HAS_ADDONS) await watcherShots();
  if (runs('hover') && !OPACITY) await hoverShots();
  if (runs('meal') && !OPACITY && HAS_ADDONS) await mealShots();
  if (runs('setup') && !OPACITY) await setupShots();
  if (runs('empty') && !OPACITY) await emptyShots();
  if (runs('contrast') && !OPACITY) await contrastShots();
}

// Never let a stuck page keep an electron.exe alive.
setTimeout(() => {
  console.error('design-shots: timed out');
  app.exit(1);
}, 25 * 60_000).unref();

main()
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('design-shots crashed:', err);
    app.exit(1);
  });
